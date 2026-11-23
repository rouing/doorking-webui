/**
 * @module web/routing
 *
 * Route table types and helpers (registered on Fastify by web/requests.ts).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Body, Gate, Reply, Session } from './context.ts';

/**
 * Route table. scope: 'public' (no session), 'user' (signed in), 'gate' (signed in with any role on the gate in
 * :phone, else 404), 'gate-admin' (admin role on it, else 403). Read-only users may view, pull and use the
 * cameras. Handlers get { session, gate, params, body, req, reply } and return [status, body], or answer through
 * `reply` (file downloads, streams, redirects) and return nothing / `reply`. A user who must change their password
 * reaches only the public routes and PUT /api/me/password until they do.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Scope = 'public' | 'user' | 'gate-resident' | 'gate' | 'gate-editor' | 'gate-admin';
interface Ctx<S extends Scope> {
  session: S extends 'public' ? Session | null : Session;
  gate: S extends `gate${string}` ? Gate : null;
  params: Record<string, string>; body: Body; req: FastifyRequest; reply: FastifyReply;
}
type Handler<S extends Scope> = (ctx: Ctx<S>) => Reply | FastifyReply | undefined | void | Promise<Reply | FastifyReply | undefined | void>;
/**
 * webOnly: refused for API keys (gate login, users, API keys, deleting the gate's data, leaving).
 * stepUp: set from STEP_UP (sessions need a recent passkey confirmation).
 */
export interface Route { method: HttpMethod; pattern: string; scope: Scope; handler: Handler<Scope>; webOnly?: boolean; stepUp?: boolean; bodyLimit?: number }
/**
 * Web only.
 *
 * @param route - `Route` value.
 * @returns `Route` result.
 */
export const webOnly = (route: Route): Route => ({ ...route, webOnly: true });

/**
 * Route.
 *
 * @param method - `HttpMethod` value.
 * @param pattern - `string` value.
 * @param scope - `S` value.
 * @param handler - `Handler<S>` value.
 * @returns `Route` result.
 */
export function route<S extends Scope>(method: HttpMethod, pattern: string, scope: S, handler: Handler<S>, opts?: { bodyLimit?: number }): Route {
  // The request handler checks the scope first (web/requests.ts), so the context has what scope S promises.
  return { method, pattern, scope, handler: (ctx) => handler(ctx as Ctx<S>), ...(opts?.bodyLimit && { bodyLimit: opts.bodyLimit }) };
}

export const G = '/api/gates/:phone';
