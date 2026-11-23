/**
 * @module web/routes/docs
 *
 * The user guide and the API documentation pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import { helpPage } from '../../src/markdown.ts';
import { logger } from '../../src/logging.ts';
import { type Route, route } from '../routing.ts';
import type { Modules } from '../modules.ts';

/**
 * Docs routes.
 *
 * @param modules - Composed server modules (`context`, `auth`, `mail`, `editing`, `snapshots`, `jobs`).
 * @returns Registered route definitions for this area.
 */
export function docsRoutes(modules: Modules): Route[] {
  const { config, HERE } = modules.context;
  const { clientIp, overLimit } = modules.auth;
  const MANUAL = path.join(HERE, '..', 'docs', 'MANUAL.md');
  /**
   * The API-key routes as OpenAPI 3.1 (docs/openapi.json, kept in step with ROUTES by a test) and a Swagger UI page
   * for it at /api/docs, served from node_modules/swagger-ui-dist (no CDN, so the CSP stays 'self').
   */
  const DOCS_DIR = path.join(HERE, '..', 'docs');
  const SWAGGER_DIR = path.join(HERE, '..', 'node_modules', 'swagger-ui-dist');
  const SWAGGER_FILES: Record<string, string> = {
    'swagger-ui.css': 'text/css', 'swagger-ui-bundle.js': 'text/javascript', 'favicon-32x32.png': 'image/png', 'favicon-16x16.png': 'image/png',
  };
  const DOCS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DoorKing Gate Manager API</title><link rel="icon" type="image/png" href="/api/docs/favicon-32x32.png">
<link rel="stylesheet" href="/api/docs/swagger-ui.css"></head>
<body><div id="swagger-ui"></div><script src="/api/docs/swagger-ui-bundle.js"></script><script src="/api/docs/init.js"></script></body></html>`;
  const DOCS_INIT = `window.ui = SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger-ui', deepLinking: true, persistAuthorization: false,
  tryItOutEnabled: false, displayRequestDuration: true, defaultModelsExpandDepth: 0 });`;
  return [
    // Android Digital Asset Links for App Links & Credential Manager passkey verification.
    route('GET', '/.well-known/assetlinks.json', 'public', ({ reply }) => {
      const { packageName, sha256CertFingerprints } = config.android;
      const body = packageName && sha256CertFingerprints.length ? [{
        relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
        target: { namespace: 'android_app', package_name: packageName, sha256_cert_fingerprints: sha256CertFingerprints },
      }] : [];
      return reply.header('Cache-Control', 'no-cache').type('application/json; charset=utf-8').send(body);
    }),

    // Direct signed Android APK download (configured via `android.apkPath` in config.json).
    // Served at both `/download` and `/api/download` (so older cached PWAs whose SW denylist only skips `/api/` work immediately).
    ...(['/download', '/api/download'] as const).map((urlPath) => route('GET', urlPath, 'public', ({ reply }) => {
      const apkPath = config.android.apkPath;
      if (!apkPath || !fs.existsSync(apkPath)) return [404, { error: 'Android APK is not available on this server' }];
      return reply
        .header('Cache-Control', 'no-cache')
        .header('Content-Disposition', 'attachment; filename="doorking-gate.apk"')
        .type('application/vnd.android.package-archive')
        .sendFile(path.basename(apkPath), path.dirname(apkPath), { cacheControl: false });
    })),

    // Remote Android crash report intake -> appended to logs/android-crashes.jsonl and logged via LogTape.
    route('POST', '/api/client-crashes', 'public', async ({ req, body }) => {
      if (await overLimit(`crash:${clientIp(req)}`, 20)) return [429, { error: 'Too many crash reports' }];
      const trace = String(body.trace ?? '').slice(0, 24000).trim();
      if (!trace) return [400, { error: 'Missing crash trace' }];
      const entry = {
        receivedAt: new Date().toISOString(),
        appVersion: String(body.appVersion ?? '').slice(0, 40),
        versionCode: Number(body.versionCode ?? 0) || 0,
        device: String(body.device ?? '').slice(0, 120),
        sdkInt: Number(body.sdkInt ?? 0) || 0,
        thread: String(body.thread ?? '').slice(0, 80),
        trace,
      };
      fs.mkdirSync(config.paths.logs, { recursive: true });
      fs.appendFileSync(path.join(config.paths.logs, 'android-crashes.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      const firstLine = trace.split('\n').find((line) => line.includes('Exception') || line.includes('Error')) || trace.split('\n')[0];
      logger('android').error`Android crash (${entry.appVersion}/${entry.versionCode} ${entry.device}): ${firstLine}`;
      return [201, { ok: true }];
    }, { bodyLimit: 32 * 1024 }),

    // The user guide (docs/MANUAL.md) as a page, read on each request so edits show at once. Public: it holds no gate data.
    route('GET', '/help', 'public', ({ reply }) => reply.type('text/html; charset=utf-8').send(helpPage(fs.readFileSync(MANUAL, 'utf8')))),

    // The API-key routes as OpenAPI (public: it holds no data) and the browsable docs page.
    route('GET', '/api/openapi.json', 'public', ({ reply }) => reply.header('Cache-Control', 'no-cache').type('application/json; charset=utf-8').sendFile('openapi.json', DOCS_DIR, { cacheControl: false })),
    route('GET', '/api/docs', 'public', ({ reply }) => reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(DOCS_PAGE)),
    route('GET', '/api/docs/:file', 'public', ({ params, reply }) => {
      if (params.file === 'init.js') return reply.header('Cache-Control', 'no-cache').type('text/javascript; charset=utf-8').send(DOCS_INIT);
      const type = SWAGGER_FILES[params.file];
      if (!type) return [404, { error: 'Not found' }];
      return reply.header('Cache-Control', 'no-cache').type(type).sendFile(params.file, SWAGGER_DIR, { cacheControl: false });
    }),
  ];
}
