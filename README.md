# DoorKing Gate Manager — Web UI

Standalone React 19 + Material UI (MUI 9) + Vite 8 Progressive Web App (PWA) for managing DoorKing telephone-entry gates through [`doorking-api`](https://github.com/rouing/doorking-api).

## Features

- **Material 3 Expressive UI** — responsive desktop and mobile PWA layout with light/dark theme support and installable Service Worker (`vite-plugin-pwa` `injectManifest`).
- **Resident Self-Service Portal** — Buzz Me In relay control, masked keypad code with reroll, printable welcome instructions PDF, activity history with camera clips, and change requests.
- **Full Gate Management** — Residents & Vendors directory, bulk edits & CSV import, pre-send diff review, live relay control with auto-release timers, Access Insights, History & point-in-time pull archive rollback, Board Settings, Schedules, Cameras, Webhooks, and Scoped API Keys.
- **Modern Auth** — local accounts, WebAuthn passkeys (with autofill & step-up confirmation), OIDC Single Sign-On, and Web Push (VAPID) notifications.

## Requirements

- **Node.js:** `>= 24`
- **Backend:** Running [`doorking-api`](https://github.com/rouing/doorking-api) instance

## Installation & Development

```bash
git clone https://github.com/rouing/doorking-webui.git
cd doorking-webui
npm install
```

Start the Vite dev server (proxies `/api`, `/help`, `/privacy`, `/download`, and `/.well-known` to `API_ORIGIN`, defaulting to `http://localhost:8080`):

```bash
API_ORIGIN=http://127.0.0.1:8080 npm run dev
```

Open `http://localhost:5173`.

## Production Build & Deployment

Build the static bundle to `dist/`:

```bash
npm run build
```

Deploy `dist/` behind the **same origin** as `doorking-api` so `HttpOnly; SameSite=Strict` cookies, WebAuthn passkey `rpID`, and OIDC redirect URIs work without CORS configuration:

### Example Caddyfile (Same-Origin Path Routing)

```caddyfile
gate.example.com {
  @api path /api/* /.well-known/* /download /help /privacy
  handle @api {
    reverse_proxy 127.0.0.1:8080
  }

  handle {
    root * /var/www/doorking-web-ui
    try_files {path} /index.html
    file_server
  }
}
```

### Docker

A multi-stage `Dockerfile` (Node build → Nginx static server) is included, and container images are published via GitHub Actions to GHCR:

```bash
docker build -t doorking-webui .
docker run -p 8080:80 doorking-webui
```

## Regenerating API Types

TypeScript models in `generated/models/` are generated from `doorking-api`'s OpenAPI 3.1 spec (`docs/openapi.json`) via Orval on demand:

```bash
npm run gen:types
```

## Typechecking & Tests

```bash
npm run typecheck
node --test
```

## Related Repositories

- [`rouing/doorking-api`](https://github.com/rouing/doorking-api) — Headless Fastify REST API, DKS Cloud worker & PostgreSQL backend
- [`rouing/doorking-android`](https://github.com/rouing/doorking-android) — Native Android app (Jetpack Compose, Glance widget, Android Auto, FCM)
- [`rouing/doorking-mcp`](https://github.com/rouing/doorking-mcp) — MCP server for AI assistants

## Disclaimer

DoorKing Gate Manager is an independent open-source project and is not affiliated with or endorsed by DoorKing, Inc.

## License

MIT
