# DoorKing Gate Manager — Web UI

Standalone React 19 + Material UI (MUI 9) + Vite 8 Progressive Web App (PWA) for managing DoorKing telephone-entry gates through [`doorking-api`](https://github.com/rouing/doorking-api).

## Features

- **Material 3 Expressive UI** — responsive desktop and mobile PWA layout with light/dark theme support, `Cmd/Ctrl+K` QuickJump search, and installable Service Worker (`vite-plugin-pwa` `injectManifest`).
- **Resident Self-Service Portal** — Buzz Me In relay control across all openable gate relays (with per-user **Visible gate relays** synced to Android and Android Auto), masked keypad code with daily-capped reroll, printable welcome instructions PDF, activity history with camera clips and `hidePortalHoldNoise` filtering, suspicious-activity reports, and self-service change requests.
- **Full Gate Management:**
  - **Directory** — classic desktop `<Table>` with inline expanded `RecentTransactions` vs. borderless mobile tonal cards, Extended FAB, slide-up `ResidentForm`, and collapsible `MobileRecentTransactions` pill cards; `libphonenumber-js` NANP and international E.164 phone parsing/formatting; duplicate detection across directory codes, entry codes, and cards; bulk edits, CSV import/export, and printable resident PDFs.
  - **Transactions & Cameras** — virtualized desktop table (`@tanstack/react-virtual`) and paged mobile `TransactionCard`s, paired `Hold Begin`/`Hold End` noise filtering around `Portal Open` events, and **Camera Channel ↔ Relay** mapping (`All relays` or specific named relays per channel).
  - **Live Relays & Job Dock** — live relay status and timed hold-open auto-release with configured relay names, plus a log-parsed `%` progress bar (`Session Complete: Success` → `100%`) and expandable raw DKS log.
  - **Access Insights (`Audit`)** — traffic KPIs, 24-hour activity chart, dormant credentials, unknown cards, high-frequency/off-hours entry codes, plus open Suspicious Activity reports and pending Resident Requests on both desktop and mobile.
  - **History & Rollback** — Gate users, **Past pulls** archive (Compare/Restore) ordered above the **Events** audit log with inline Revert.
  - **Board Settings & Schedules** — factory-default-aware 2-Line vs. 8-Line LCD detection, named relays throughout Schedules and Anti-Passback (**APB** hides sub-settings when `Off`, shows `Re-Sync List` only when `Re-Sync All Devices` is active, and groups scheduled re-sync controls into one card), floating US holidays, and outbound signed Webhooks.
- **Modern Auth & Connected Clients** — local accounts, WebAuthn passkeys (autofill, step-up confirmation, and **Approve with Android app** 2-digit number-match push approval with 8-character code fallback), OIDC Single Sign-On, Android browser `doorking://invite` handoff, unified Web Push (VAPID) + Android FCM device management, and **Connected AI Clients** OAuth grant inspection and revocation.

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
  @api path /api/* /.well-known/* /download /help /privacy /mcp* /authorize /token /register /revoke /oauth/*
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

A multi-stage `Dockerfile` (Node build → Caddy static server listening on port `8080`) is included, and container images are published via GitHub Actions to GHCR:

```bash
docker build -t doorking-webui .
docker run -p 8080:8080 doorking-webui
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
