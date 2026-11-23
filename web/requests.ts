/**
 * @module web/requests
 *
 * Fastify HTTP server: registers `@fastify/cookie`, `@fastify/helmet`, `@fastify/static`, the built SPA and the
 * REST API routes (`web/routes/`), checking host, origin, session or API key, role and step-up on every request.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { withContext } from '@logtape/logtape';
import * as dk from '../index.ts';
import type { Body, Gate, Reply, Session } from './context.ts';
import { G, type Route } from './routing.ts';
import type { Modules } from './modules.ts';
import { logger } from '../src/logging.ts';

/** Built web UI directory (produced by `npm run build`). */
const DIST = path.join(import.meta.dirname, 'dist');
const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.html': 'text/html',
};
const SERVER_FAULT = 'Something went wrong on the server. Try again; if it keeps happening, the server log has the details.';
const NOT_BUILT = 'The web page is not built yet. Run `npm run build` in the project folder, then reload.';

/**
 * Resolves a static web-UI URL path to `[filePath, mimeType]`, or `null` when disallowed or not built.
 *
 * @param pathname - URL pathname (e.g. `/` or `/assets/index-abc.js`).
 * @returns `[filePath, contentType]` tuple, or `null`.
 */
export function staticFile(pathname: string): [string, string] | null {
  if (pathname === '/') {
    const built = path.join(DIST, 'index.html');
    return fs.existsSync(built) ? [built, 'text/html'] : null;
  }
  // /assets/<file>, or a file at the top of the build (the app's service worker, manifest and icons, from web/ui/public).
  const match = /^\/((?:assets\/)?[\w-][\w.-]*)$/.exec(pathname);
  const type = match && ASSET_TYPES[path.extname(match[1])];
  if (!match || !type) return null;
  const file = path.join(DIST, match[1]);
  return fs.existsSync(file) ? [file, type] : null;
}

/**
 * Routes requiring a recent passkey confirmation (`security.stepUpMinutes`) for browser sessions.
 * API keys are excluded because they are already scoped to one gate and role.
 */
const STEP_UP = [
  `POST ${G}/send`, `POST ${G}/schedules`, `PUT ${G}/schedules/:id`, `POST ${G}/schedules/:id/run`,
  `PUT ${G}/login`, `POST ${G}/users`, `POST ${G}/users/:username/invite`, `POST ${G}/share`, `PUT ${G}/users/:username`,
  `DELETE ${G}/users/:username`, `POST ${G}/api-keys`, `DELETE ${G}/api-keys/:id`, `POST ${G}/delete-data`,
  `POST ${G}/webhooks`, `PUT ${G}/webhooks/:id`, `DELETE ${G}/webhooks/:id`,
  'POST /api/me/sso/start', 'DELETE /api/me/sso/:provider/:subject', 'POST /api/me/passkeys/approval',
];

/**
 * Marks the `STEP_UP` routes on the route table, throwing if a listed route is missing so renames cannot silently drop step-up checks.
 *
 * @param routes - Registered server routes.
 * @throws Error when any `STEP_UP` pattern is missing from `routes`.
 */
export function markStepUp(routes: Route[]): void {
  for (const key of STEP_UP) {
    const found = routes.find((route) => `${route.method} ${route.pattern}` === key);
    if (!found) throw new Error(`STEP_UP: no route ${key}`);
    found.stepUp = true;
  }
}

const isReply = (result: Session | Reply | FastifyReply | undefined | void): result is Reply => Array.isArray(result);

/**
 * Registers Fastify plugins (`@fastify/cookie`, `@fastify/helmet`, `@fastify/static`) and the strict JSON-object body parser.
 *
 * @param fastify - Fastify instance.
 */
async function registerPlugins(fastify: FastifyInstance): Promise<void> {
  await fastify.register(fastifyCookie);
  await fastify.register(fastifyHelmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'same-origin' },
    hsts: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
  });
  await fastify.register(fastifyStatic, { root: import.meta.dirname, serve: false });
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : '';
    if (!text) return done(null, {});
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return done(dk.httpError('Bad JSON', 400)); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return done(dk.httpError('The body must be a JSON object', 400));
    }
    return done(null, parsed);
  });
}

/**
 * Registers global request guards (shutdown 503, allowed Host/Origin, JSON Content-Type on POST/PUT, default `no-store`)
 * and the fallback error handler for pre-route Fastify errors (413/400).
 *
 * @param fastify - Fastify instance.
 * @param options - Guard dependencies.
 * @param options.allowedHosts - Permitted `Host` header values (lowercased).
 * @param options.allowedOrigins - Permitted `Origin` header values (lowercased).
 * @param options.isStopping - Callback returning `true` during server shutdown.
 * @param options.requestIds - Map associating each request with its correlation `requestId`.
 */
function registerGlobalHooks(
  fastify: FastifyInstance,
  { allowedHosts, allowedOrigins, isStopping, requestIds }: {
    allowedHosts: Set<string>;
    allowedOrigins: Set<string>;
    isStopping: () => boolean;
    requestIds: WeakMap<FastifyRequest, string>;
  },
): void {
  fastify.addHook('onRequest', async (req, reply) => {
    requestIds.set(req, crypto.randomUUID().slice(0, 8));
    if (!req.url.startsWith('/assets/')) reply.header('Cache-Control', 'no-store');
    if (isStopping()) return reply.code(503).send({ error: 'The server is restarting. Try again in a moment.' });
    if (!allowedHosts.has((req.headers.host || '').toLowerCase())) return reply.code(403).send({ error: 'Forbidden host' });
    const origin = req.headers.origin;
    if (req.method !== 'GET' && origin && !allowedOrigins.has(origin.toLowerCase())) {
      return reply.code(403).send({ error: 'Forbidden origin' });
    }
    if ((req.method === 'POST' || req.method === 'PUT') && !/^application\/json/.test(req.headers['content-type'] || '')) {
      return reply.code(415).send({ error: 'JSON required' });
    }
  });
  fastify.setErrorHandler((err, req, reply) => {
    const requestId = requestIds.get(req) || crypto.randomUUID().slice(0, 8);
    return withContext({ requestId }, () => {
      const out = errorReply(err, req, req.url.split('?')[0]);
      return sendReply(reply, out, req, req.url.split('?')[0]);
    });
  });
}

/**
 * Registers the SPA static file fallback and `405 Allow` / `404` handler for unmatched paths.
 *
 * @param fastify - Fastify instance.
 * @param routes - Registered server routes used to compute `Allow` headers on 405 responses.
 */
function registerNotFound(fastify: FastifyInstance, routes: Route[]): void {
  const routeMatchers = routes.map((route) => ({
    method: route.method,
    re: new RegExp(`^${route.pattern.replace(/\./g, '\\.').replace(/:(\w+)/g, '([^/]+)')}$`),
  }));
  fastify.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0];
    if (req.method === 'GET' || req.method === 'HEAD') {
      const page = staticFile(pathname);
      if (page) {
        const relativePath = path.relative(DIST, page[0]);
        return reply.type(page[1]).sendFile(relativePath, DIST, pathname.startsWith('/assets/')
          ? { maxAge: 31536000000, immutable: true } : { cacheControl: false });
      }
      if (pathname === '/') return reply.code(503).type('text/plain').send(NOT_BUILT);
    }
    const allow = routeMatchers.filter((matcher) => matcher.re.test(pathname)).map((matcher) => matcher.method);
    if (allow.length && !allow.includes(req.method as Route['method'])) {
      return reply.header('Allow', allow.join(', ')).code(405).send({ error: 'Method not allowed' });
    }
    const notFound = /^\/api\/gates\/[^/]+\/snapshots\/[^/]+\/[^/]+$/.test(pathname) ? 'Snapshot not found' : 'Not found';
    return reply.code(404).send({ error: notFound });
  });
}

/**
 * Translates an error thrown by Fastify or a route handler into a JSON `[status, body]` reply.
 * Unexpected faults are logged with their stack trace and return a generic 500 message.
 *
 * @param err - Caught error value.
 * @param req - Incoming Fastify request.
 * @param pathname - Request URL pathname.
 * @returns HTTP `[status, body]` reply tuple.
 */
function errorReply(err: unknown, req: FastifyRequest, pathname: string): Reply {
  const error = err as Error & { status?: unknown; statusCode?: unknown; code?: string };
  const status = typeof error.status === 'number' ? error.status
    : typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode
      : null;
  if (status) {
    const message = error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'Request body too large' : error.message;
    return [status, { error: message }];
  }
  logger('request').error`${req.method} ${pathname}: ${error && error.stack ? error.stack : String(err)}`;
  return [500, { error: SERVER_FAULT }];
}

/**
 * Logs refused or failed replies (4xx/5xx other than already-logged 500 faults) and sends the `[status, body]` response.
 *
 * @param reply - Fastify reply object.
 * @param out - HTTP `[status, body]` reply tuple.
 * @param req - Incoming Fastify request.
 * @param pathname - Request URL pathname.
 * @returns Fastify reply handle.
 */
function sendReply(reply: FastifyReply, out: Reply, req: FastifyRequest, pathname: string): FastifyReply {
  const failed = out[0] >= 400 ? out[1] as { error?: unknown } | null : null;
  if (failed && failed.error && failed.error !== SERVER_FAULT) {
    logger('request')[out[0] >= 500 ? 'error' : 'warn']`${req.method} ${pathname}: ${out[0]} ${failed.error}`;
  }
  return reply.code(out[0]).send(out[1]);
}

/**
 * Builds and configures the Fastify server instance (not listening yet).
 *
 * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
 * @param routes - Registered server routes.
 * @param isStopping - Callback returning `true` while the server is shutting down.
 * @returns Promise resolving to the configured `FastifyInstance`.
 */
export async function createFastifyServer(modules: Modules, routes: Route[], isStopping: () => boolean): Promise<FastifyInstance> {
  const { ADMIN_ONLY, asGate, gateFor, MAX_BODY_BYTES, NO_GATE, prefsOf, store } = modules.context;
  const { ALLOWED_HOSTS, ALLOWED_ORIGINS, currentSession, NATIVE_SESSION_PREFIX, sessionFromToken, stepUpRefusal, strongUntil } = modules.auth;
  const requestIds = new WeakMap<FastifyRequest, string>();
  const fastify = Fastify({ logger: false, bodyLimit: MAX_BODY_BYTES, routerOptions: { maxParamLength: 1400 }, exposeHeadRoutes: false });

  await registerPlugins(fastify);
  registerGlobalHooks(fastify, { allowedHosts: ALLOWED_HOSTS, allowedOrigins: ALLOWED_ORIGINS, isStopping, requestIds });

  /**
   * Authenticates an `Authorization: Bearer <key>` request against the gate's API keys.
   *
   * @param req - Incoming Fastify request.
   * @param route - Matched route definition.
   * @param params - Route path parameters.
   * @param pathname - Request URL pathname.
   * @returns Promise resolving to an API-key `Session` or an HTTP error `Reply`.
   */
  async function apiKeySession(req: FastifyRequest, route: Route, params: Record<string, string>, pathname: string): Promise<Session | Reply> {
    const authorization = req.headers.authorization!;
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
    const apiKey = bearer ? await dk.findApiKey(store, bearer[1]) : null;
    if (!apiKey) {
      logger('api').warn`${req.method} ${pathname}: refused, ${bearer ? 'invalid or expired API key' : 'not a Bearer token'}`;
      return [401, { error: bearer ? 'Invalid or expired API key' : 'Use the header Authorization: Bearer <API key>' }];
    }
    if (!route.scope.startsWith('gate') || route.webOnly || String(params.phone || '').replace(/\D/g, '') !== apiKey.phone) {
      return [403, { error: `This API key works only on /api/gates/${apiKey.phone}/… (gate login, users, API keys and deleting data are web-only)` }];
    }
    return { tokenHash: '', user: `api:${apiKey.name}`, gate: null, mustChangePassword: false, strongAt: null, signedInAt: 0, apiKey: { phone: apiKey.phone, role: apiKey.role } };
  }

  /**
   * Resolves the caller's session (API key or cookie, `null` on public routes) or returns an auth refusal.
   *
   * @param req - Incoming Fastify request.
   * @param route - Matched route definition.
   * @param params - Route path parameters.
   * @param pathname - Request URL pathname.
   * @returns Promise resolving to `Session`, `null`, or a refusal `Reply`.
   */
  async function resolveCallerSession(req: FastifyRequest, route: Route, params: Record<string, string>, pathname: string): Promise<Session | null | Reply> {
    if (req.headers.authorization === undefined) return currentSession(req);
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization);
    if (bearer && bearer[1].startsWith(NATIVE_SESSION_PREFIX)) {
      const nativeSession = await sessionFromToken(bearer[1].slice(NATIVE_SESSION_PREFIX.length));
      if (nativeSession) return nativeSession;
      return route.scope === 'public' ? null : [401, { error: 'Session expired. Sign in again.' }];
    }
    return apiKeySession(req, route, params, pathname);
  }

  async function sessionFor(req: FastifyRequest, route: Route, params: Record<string, string>, pathname: string): Promise<Session | null | Reply> {
    const resolved = await resolveCallerSession(req, route, params, pathname);
    if (resolved && isReply(resolved)) return resolved;
    if (!resolved && route.scope !== 'public') return [401, { error: 'Not logged in' }];
    if (resolved && resolved.mustChangePassword && route.scope !== 'public' && !(route.method === 'PUT' && pathname === '/api/me/password')) {
      return [403, { error: 'Choose a new password first', mustChangePassword: true }];
    }
    return resolved;
  }

  /**
   * Loads the gate for a gate-scoped route: an API key's own gate (404 if deleted) or the URL gate checked against the user's access.
   *
   * @param session - Authenticated user or API-key session.
   * @param phone - Gate phone parameter from the URL.
   * @returns Promise resolving to the resolved `Gate`.
   * @throws HTTP 404 error when the gate does not exist or the user has no access.
   */
  async function routeGate(session: Session, phone: string): Promise<Gate> {
    if (!session.apiKey) return gateFor(session, phone);
    const rec = await dk.getGate(store, session.apiKey.phone);
    if (!rec) throw dk.httpError(NO_GATE, 404);
    return asGate(rec, session.apiKey.role, session.user);
  }

  /**
   * Authorizes and runs one matched route handler inside LogTape request context, translating thrown errors inside that context.
   *
   * @param route - Matched route definition.
   * @param req - Incoming Fastify request.
   * @param reply - Fastify reply object.
   * @returns Promise resolving to the Fastify reply or `undefined` when hijacked.
   */
  async function dispatchRoute(route: Route, req: FastifyRequest, reply: FastifyReply) {
    const pathname = req.url.split('?')[0];
    const params = (req.params || {}) as Record<string, string>;
    const requestId = requestIds.get(req) || crypto.randomUUID().slice(0, 8);
    return withContext({ requestId, ...(params.phone && { gate: dk.phoneDigits(params.phone) }) }, async () => {
      const session = await sessionFor(req, route, params, pathname);
      if (session && isReply(session)) return sendReply(reply, session, req, pathname);
      return withContext({ ...(session && { user: session.user }) }, async () => {
        try {
          const gate = route.scope.startsWith('gate') ? await routeGate(session!, params.phone) : null;
          if (gate && route.scope !== 'gate-resident' && gate.role === 'resident') {
            return sendReply(reply, [403, { error: 'Staff access is required for this page.' }], req, pathname);
          }
          if (gate && route.scope === 'gate-admin' && gate.role !== 'admin') return sendReply(reply, [403, { error: ADMIN_ONLY }], req, pathname);
          if (gate && route.scope === 'gate-editor' && gate.role === 'readonly') return sendReply(reply, [403, { error: 'Editor or admin access is required for this change.' }], req, pathname);
          const gateRequiresStrong = req.method !== 'GET' && gate && gate.role === 'admin'
            && (route.scope === 'gate-admin' || route.scope === 'gate-editor')
            && !session!.apiKey && (await prefsOf(gate.phoneNumber)).requireStrongAdmin === true;
          if ((route.stepUp || gateRequiresStrong) && !session!.apiKey && !strongUntil(session!)) return sendReply(reply, await stepUpRefusal(session!), req, pathname);
          const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Body;
          const out = await route.handler({ session, gate, params, body, req, reply });
          return isReply(out) ? sendReply(reply, out, req, pathname) : out;
        } catch (err) {
          return sendReply(reply, errorReply(err, req, pathname), req, pathname);
        }
      });
    });
  }

  for (const route of routes) {
    fastify.route({
      method: route.method,
      url: route.pattern,
      ...(route.bodyLimit && { bodyLimit: route.bodyLimit }),
      handler: (req, reply) => dispatchRoute(route, req, reply),
    });
  }
  registerNotFound(fastify, routes);
  return fastify;
}
