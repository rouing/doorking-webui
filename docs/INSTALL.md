# Install and set up

How to set up DoorKing Gate Manager on a new machine, move an existing install, keep it running, and update it.
For using the app once it runs, see [MANUAL.md](MANUAL.md).

## 1. Requirements

| Need | Details |
|---|---|
| **Node.js 24 or later** | from [nodejs.org](https://nodejs.org) (LTS). Node 24 runs the server's `.ts` files directly, so no compiler is needed. npm comes with it. |
| **PostgreSQL 14 or later** | the database (on this machine or another). Ubuntu: `sudo apt install postgresql`; Windows: the installer from [postgresql.org](https://www.postgresql.org/download/). Set up a login and database for the app in section 2a. |
| **Operating system** | Windows (x64 or ARM64) or Linux (x64 or arm64, a glibc distribution such as Debian or Ubuntu). The camera bridge in `tools/bin/` exists for these; everything except cameras runs on any system with Node 24. |
| **ffmpeg** (cameras only) | not in the git repository (too large). Ubuntu/Debian: `sudo apt install ffmpeg`; Windows: a static build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) with `ffmpeg.exe` on the PATH or in `tools/bin/`. The app uses `tools/bin/ffmpeg.exe` / `tools/bin/ffmpeg-linux-<x64\|arm64>` when present, else `ffmpeg` on the PATH. |
| **Internet access** | outgoing HTTPS (port 443) to `dksdb.dksoftware.com` (DKS Cloud), and for cameras to Dahua's P2P cloud. No incoming ports: the server listens on this machine only, unless you set up public access (section 6a). |
| **A DKS Cloud account** | the user and password that manage the gates, and for each gate its **system phone number** and 4-digit **master code**. |
| **Disk space** | about 1 GB for the program and camera tools; camera videos need more (about 62 MB per 2-minute clip). |

Check Node with `node --version` (it must print `v24` or later).

## 2. Copy the files

Clone the repository (`git clone <repository URL> doorkings`) or copy the project folder to the machine. The
layout is:
```
<root>/          the app: package.json, web/, src/, docs/, tools/, …
  DOWNLOADED/    camera pictures per gate (everything else is in the database)
  research/      reference material only (not needed to run the app)
```
When copying, leave out `node_modules/`, `web/dist/`, `DB/`, `logs/` and `DOWNLOADED/` (they are created on the
machine); `research/` is optional and not in the git repository. Keep `tools/` (camera bridge and licenses) if you
use cameras. `.gitignore` keeps all of these, and the secrets in `DB/`, out of git.

This guide runs every command from `<root>`.

**Moving an existing install** instead of starting fresh: also copy, with the old server stopped,
- the database: `pg_dump -Fc` on the old machine, `pg_restore` into the new database (sections 2a and 8), and `DB/key`
  (**the key and the database belong together**): gate lists, master codes, history, schedules, notes,
  transaction history, camera settings;
- `DOWNLOADED/`: camera pictures and videos (pulled gate files and working copies are in the database).

Transfer these privately (not by e-mail or a shared drive): with `key` they reveal master codes and passwords.

## 2a. Set up the database

Create a login and a database for the app, plus a second database for the tests (as the PostgreSQL admin; on Linux
`sudo -u postgres psql`). Pick a long random password:
```
CREATE ROLE doorking LOGIN PASSWORD '<password>';
CREATE DATABASE doorking OWNER doorking;
CREATE DATABASE doorking_test OWNER doorking;
REVOKE ALL ON DATABASE doorking, doorking_test FROM PUBLIC;
```
then in each of the two databases: `REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO doorking;`.

Put the connection URL in `DB/postgres.url` (create the folder; make the file readable by the app's user only,
e.g. `chmod 600`):
```
postgres://doorking:<password>@127.0.0.1:5432/doorking
```
Or set the environment variable `DATABASE_URL` instead. The app creates its tables on the first start.

For `psql`, `pg_dump` and `pg_restore`, keep the same login in a `.pgpass` file (mode 0600), e.g. `DB/pgpass`:
`127.0.0.1:5432:doorking:doorking:<password>` (one line per database). Don't type the password on a command line.

## 3. Build the web page

```
npm install
npm run build
```
`npm install` downloads the database driver (`pg`) and the build tools (React, Vite, TypeScript) into
`node_modules/`. `npm run build` writes the page to `web/dist/`. The server needs `pg` at runtime, so keep
`node_modules/` (or run `npm install --omit=dev` on a machine that only runs the server).

## 4. Start the server

```
node web/server.ts
```
(or `npm start`). It prints:
```
DoorKing web UI: http://localhost:8080  (gate folders in <root>\DOWNLOADED, database in <root>\DB)
```
On the first start it creates the tables and the encryption key `DB/key`. Stop it with **Ctrl+C**. Without a
reachable database it prints "Database not available: …" and stops.

Options (all optional):

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | `8080` (or the `PORT` environment variable) | HTTP port |
| `--public-host <name>` | none (or the `PUBLIC_HOST` environment variable) | public name served by an HTTPS reverse proxy (section 6a); the server also accepts that host and `https://` origins, and marks its cookie `Secure` there |
| `--dir <folder>` | `<root>/DOWNLOADED` | camera pictures folder (one folder per gate) |
| `--db <folder>` | `DB` | folder with `postgres.url` (the database connection) and `key` |
| `--logs <folder>` | `logs` | folder for `debug.log` |
| `--gates <file>`, `--prefs <file>` | `gates.json`, `prefs.json` | pre-database JSON files, imported once into a new database when present (see [DB.md](DB.md)) |
| `--site-name`, `--memory`, `--area-codes`, `--model`, `--anti-passback`, `--interface-1816` | see `GATE_DEFAULTS` in `src/gate-pull.ts` | gate-match defaults, used when a gate's Gate configuration leaves a value empty |

The environment variable `DATABASE_URL` overrides `postgres.url`. `DKS_URL` overrides the DKS Cloud address (default
`https://dksdb.dksoftware.com/DkWebService.asmx`).

The gate-match values sent to DKS Cloud come from, lowest first: `GATE_DEFAULTS`, then the command-line flags,
then the gate's saved **System Settings → Gate configuration**. The `antiPassBack` default is `N`; set `Y` per
gate if the gate uses anti-pass back.

Other npm scripts: `npm run dev` (Vite dev server for the page on `http://localhost:5173`, with `/api`
going to the server on port 8080), `npm run typecheck`, `npm test`.

## 5. First-time setup in the browser

1. Open **http://localhost:8080** on the same machine. Other computers can't reach it: the server listens on
   `127.0.0.1` only. For access from anywhere, set up section 6a and open `https://<public name>`.
2. **Sign in** with the DKS Cloud user and password.
3. **Add a gate**: its system phone number and master code. Then **Open** it.
4. **System Settings → Gate configuration**: set Site name, System memory, Area codes, Model, Anti-passback and
   Interface 1816/1820 **to match the gate**, then **Save gate configuration**. DKS Cloud checks these on every
   connection; a mismatch fails the pull (for example "Anti-Passback Mismatch").
5. **Pull residents** and **Pull transactions** (sidebar, Gate connection). The first successful pull connects you
   to the gate and opens its data.
6. Optional: relay names (Relays page), Device association and **Gate cameras** (System Settings), and
   **Scheduled Transfers**.

Repeat steps 3–5 for each gate. Each DKS user has their own gate list.

## 6. Keep it running

Scheduled transfers and automatic camera snapshots run only while the server runs. Sign-in sessions are kept in
memory, so a restart signs everyone out.

**Windows (Task Scheduler)**
1. Open **Task Scheduler** → **Create Task**.
2. General: a name such as *DoorKing Gate Manager*; **Run whether user is logged on or not**.
3. Triggers: **At startup**.
4. Actions: **Start a program**. Program: the full path of `node.exe` (for example
   `C:\Program Files\nodejs\node.exe`); arguments: `web\server.ts`; start in: the full path of `<root>`.
5. Settings: untick **Stop the task if it runs longer than**.
6. Run the task once, then open http://localhost:8080.

**Linux (systemd)**, as `/etc/systemd/system/doorking.service` (adjust the user and paths):
```
[Unit]
Description=DoorKing Gate Manager
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service

[Service]
User=doorking
WorkingDirectory=/opt/doorking
ExecStart=/usr/bin/node web/server.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
Then `sudo systemctl daemon-reload && sudo systemctl enable --now doorking`. The service user must be able to
write `DB/`, `logs/` and `DOWNLOADED/`. Use the full path of `node` (with nvm, `readlink -f $(which node)`;
update the service after a Node upgrade). Logs: `journalctl -u doorking`.

## 6a. Public access (HTTPS)

The app itself never listens on a public address. A reverse proxy serves HTTPS on the public address and passes
requests to `127.0.0.1:8080`; the server is started with `--public-host <name>`. Anyone who reaches the page can
try to sign in; the DKS sign-in (with its failure limit) is what protects it.

With **Caddy** (Ubuntu: `sudo apt install caddy`), which gets and renews Let's Encrypt certificates itself:
1. Create a DNS **A record** for the name pointing to the machine's public IP. Open ports **80 and 443** to the
   internet (cloud firewall / security group). Let's Encrypt checks the name over them.
2. `/etc/caddy/Caddyfile` (replace the name; `default_bind` = the address that owns the public IP, or leave it
   out to listen on every address):
   ```
   {
   	default_bind <public-interface IP>
   	cert_issuer acme
   }

   gate.example.com {
   	header {
   		Strict-Transport-Security "max-age=31536000"
   		X-Content-Type-Options nosniff
   		X-Frame-Options DENY
   		Referrer-Policy same-origin
   		-Server
   	}
   	reverse_proxy 127.0.0.1:8080 {
   		flush_interval -1
   	}
   }
   ```
   `flush_interval -1` passes the live camera stream through unbuffered. `cert_issuer acme` uses Let's Encrypt only
   (Ubuntu's Caddy 2.6 can't register with its ZeroSSL fallback).
3. `sudo systemctl reload caddy`, then add `--public-host gate.example.com` to the server's start command
   (section 6) and restart it.
4. Open `https://gate.example.com`. Until DNS points to the machine, Caddy logs "could not get certificate" and
   retries by itself (`journalctl -u caddy`); HTTP already redirects to HTTPS.

Sessions stay in memory, so restarting either service signs everyone out.

## 7. Update

1. `git pull` (or replace the program files, keeping `DB/`, `logs/` and `DOWNLOADED/`).
2. `npm install` and `npm run build`.
3. Restart the server (a rebuild of the page alone doesn't need a restart; open pages show "A new version of
   this page is available" with **Reload** within a minute).

The database updates its own tables on start (see [DB.md](DB.md)); there is no separate migration step.

## 8. Back up

Back up the database (safe while the server runs), plus `DB/key` and `DOWNLOADED/`:
```
PGPASSFILE=DB/pgpass pg_dump -Fc -h 127.0.0.1 -U doorking -f doorking.dump doorking
```
Keep the backup private: with `key` it reveals master codes and passwords. To restore into an empty database:
`PGPASSFILE=DB/pgpass pg_restore -h 127.0.0.1 -U doorking -d doorking doorking.dump`, put `key` and
`DOWNLOADED/` back, and start the server.

## 9. Check the install

```
npm run typecheck
npm test
```
Both should finish without errors. The tests don't contact DKS Cloud or the gate; they need the `doorking_test`
database (section 2a), or `TEST_DATABASE_URL` set to another database the login may create schemas in.

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `node` prints a syntax error for `.ts` files | Node is older than 24. Install Node 24 or later. |
| "Database not available: …" on start | PostgreSQL isn't running, `DB/postgres.url` is missing or wrong, or the login is refused. Check with `PGPASSFILE=DB/pgpass psql -h 127.0.0.1 -U doorking doorking`. |
| The page says "The web page is not built yet" | Run `npm install` and `npm run build`, then reload. |
| `EADDRINUSE` on start | Port 8080 is in use (often a server already running). Stop the other one, or start with `--port 8081`. |
| `Forbidden host` | Open the page as `http://localhost:<port>` or `http://127.0.0.1:<port>`, or by the `--public-host` name through the proxy, not by machine name or IP. |
| `Forbidden origin` on sign-in through the public name | The server wasn't started with `--public-host <that name>`, or the page was opened over `http://` instead of `https://`. |
| Sign-in says "Login refused" | DKS Cloud rejected the user or password. |
| Sign-in says "Too many failed sign-ins" | 5 failed tries for that user within 15 minutes. Wait 15 minutes. |
| A pull fails with "… Mismatch" | Gate configuration doesn't match the gate (System Settings). Fix the named value. |
| Pulls fail with a network error | The machine can't reach `dksdb.dksoftware.com` on port 443 (firewall or proxy). |
| Cameras: "Could not reach the recorder after 3 tries" | Check the recorder serial, user and password, and that it is online in DMSS/SmartPSS. |
| Something else | Turn on **System Settings → Debug logs**, repeat the action, then **Open log** (`logs/debug.log`). |
