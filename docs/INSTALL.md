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
<root>/            the app: package.json, web/, src/, docs/, tools/, …
  config.json      the server's settings, including the database password (section 2a; not in git)
  doorking.key     the encryption key (created on the first start; not in git)
  media/           camera pictures per gate (everything else is in the database)
  research/        reference material only (not needed to run the app)
```
When copying, leave out `node_modules/`, `web/dist/`, `logs/` and `media/` (they are created on the machine);
`research/` is optional and not in the git repository. Keep `tools/` (camera bridge and licenses) if you use
cameras. `.gitignore` keeps all of these, `config.json` and `doorking.key` out of git.

This guide runs every command from `<root>`.

**Moving an existing install** instead of starting fresh: also copy, with the old server stopped,
- the database: `pg_dump -Fc` on the old machine, `pg_restore` into the new database (sections 2a and 8), and
  `doorking.key` (**the key and the database belong together**): gate lists, master codes, history, schedules,
  notes, transaction history, camera settings, gate files;
- `config.json` (adjust it for the new machine);
- `media/`: camera pictures and videos.

Transfer these privately (not by e-mail or a shared drive): with the key they reveal master codes and passwords.
(Installs from before 2026-11-13 kept the login and key in a `DB/` folder: `DB/key` is `doorking.key`, and the
login in `DB/postgres.url` goes into `config.json`'s `database` section. The camera folder was `DOWNLOADED/`.)

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

Copy `config.example.json` to `config.json`, put the password in `database.password`, and make the file readable
by the app's user only (the server refuses to start otherwise):
```
cp config.example.json config.json
chmod 600 config.json
```
The `database` section's other values (host `127.0.0.1`, port `5432`, database `doorking`, user `doorking`, tests in
`doorking_test`) match the commands above. Instead of the separate values, `database.url` can hold a full
`postgres://user:password@host:port/database` URL. The app creates its tables on the first start.

For `psql`, `pg_dump` and `pg_restore`, keep the same login in `~/.pgpass` (mode 0600):
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
DoorKing web UI: http://localhost:8080  (config <root>\config.json, media in <root>\media)
```
On the first start it creates the tables and the encryption key `doorking.key`. Stop it with **Ctrl+C**. Without a
reachable database it prints "Database not available: …" and stops; a mistake in `config.json` prints
"Configuration error: …" with the setting's name. `node web/server.ts --check-config` prints the settings in effect
(passwords hidden) and exits.

### Settings (`config.json`)

Every setting is optional except the database password; `config.example.json` lists them all with their defaults.
Relative paths are relative to the folder `config.json` is in. Unknown names and wrong values stop the server.

| Setting | Default | Meaning |
|---|---|---|
| `server.port` | `8080` | HTTP port (the server listens on `127.0.0.1` only) |
| `server.publicHost` | `""` | public name served by an HTTPS reverse proxy (section 6a); the server also accepts that host and `https://` origins, and marks its cookie `Secure` there |
| `paths.media` | `media` | camera pictures folder (one folder per gate) |
| `paths.logs` | `logs` | folder for `debug.log` |
| `paths.keyFile` | `doorking.key` | the encryption key (created when missing; must be chmod 600) |
| `database.host`, `.port`, `.name`, `.user`, `.password` | `127.0.0.1`, `5432`, `doorking`, `doorking`, none | the PostgreSQL login |
| `database.url` | `""` | a full `postgres://` URL instead of the values above |
| `database.poolSize` | `5` | database connections |
| `database.testName` | `doorking_test` | database the tests use (same login) |
| `dks.url` | `https://dksdb.dksoftware.com/DkWebService.asmx` | DKS Cloud address |
| `security.sessionIdleMinutes` | `30` | sign-out after this long without activity |
| `security.maxFailedSignIns`, `.signInWindowMinutes` | `5`, `15` | after this many failed sign-ins within the window, that user name is refused for the rest of it |
| `schedules.checkSeconds` | `30` | how often scheduled transfers are checked |
| `cameras.ffmpeg` | `""` | the ffmpeg program: a path (relative to `config.json`'s folder, e.g. `tools/bin/ffmpeg-linux-x64`), or a name looked up on the PATH (`ffmpeg`); empty = the copy in `tools/bin` if there is one, else `ffmpeg` on the PATH |
| `cameras.tidyMinutes` | `60` | how often old snapshots and leftover pieces are cleaned up |
| `email.host`, `.port`, `.security` | `""`, `587`, `starttls` | SMTP server for account emails and gate alerts; empty host = email off. `security`: `starttls` (port 587), `tls` (465) or `none` |
| `email.user`, `.password` | `""` | SMTP login (for Amazon SES: the SMTP credentials, not your AWS keys) |
| `email.from` | | sender, e.g. `DoorKing Gate Manager <gate@yourdomain.com>`; required when `email.host` is set |
| `email.appUrl` | `https://<server.publicHost>` | the address links in emails open |
| `gateDefaults.*` | `GATE_DEFAULTS` in `src/gate-pull.ts` | gate-match defaults (`siteName`, `memorySize`, `areaCodes`, `modelNumber`, `antiPassBack`, `interface1816`, `dialDelay`), used when a gate's Gate configuration leaves a value empty |

**Overrides**, highest first: command-line flags (`--port`, `--public-host`, `--media`, `--logs`, `--site-name`,
`--memory`, `--area-codes`, `--model`, `--anti-passback`, `--interface-1816`), then environment variables (`PORT`,
`PUBLIC_HOST`, `DATABASE_URL`, `DKS_URL`), then `config.json`, then the defaults. `--config <file>` (or
`DOORKING_CONFIG`) reads another config file.

The gate-match values sent to DKS Cloud come from, lowest first: `gateDefaults`, then the command-line flags,
then the gate's saved **System Settings → Gate configuration**. The `antiPassBack` default is `N`; set `Y` per
gate if the gate uses anti-pass back.

Other npm scripts: `npm run dev` (Vite dev server for the page on `http://localhost:5173`, with `/api`
going to the server on port 8080), `npm run typecheck`, `npm test`.

## 5. First-time setup in the browser

1. Open **http://localhost:8080** on the same machine. Other computers can't reach it: the server listens on
   `127.0.0.1` only. For access from anywhere, set up section 6a and open `https://<public name>`.
2. **Create the first account.** While no account exists, the page asks for a **setup code**: the server prints it
   in its console when it starts (`journalctl -u doorking | grep "setup code"` with systemd). Pick a username and a
   password of at least 12 characters. Or, on the server: `node cli.ts create-admin <username>` (asks for the
   password). The first account becomes admin of every gate already on the server.
3. **Add a gate**: system phone number, master code, the gate's **DKS user and password**, and the gate
   configuration (Site name, System memory, Area codes, Model, Anti-passback, Interface 1816/1820) **matching the
   gate**. The app checks the DKS login, then pulls the residents; the gate is added (you as its admin) only when
   that works. A mismatch fails the pull with a message such as "Anti-Passback Mismatch".
4. **Open** the gate and **Pull transactions** (sidebar, Gate connection).
5. Optional: relay names (Relays page), Device association and **Gate cameras** (System Settings), and
   **Scheduled Transfers**.
6. Create accounts for the other people under **System Settings → Gate users** (Admin or Read only), or share the
   gate with existing accounts. There is no sign-up page.

Repeat step 3 for each gate.

**Email** (optional, but needed for password resets, email invitations, confirming addresses and alerts): fill in the
`email` section, restart, and check it with `node cli.ts test-email you@yourdomain.com` (it shows the SMTP error,
if any). Send from a domain you control and set up its SPF and DKIM records as your mail provider describes, or the
emails may land in spam. `node cli.ts emails` lists recent emails and their delivery status.

**Account commands** (for whoever runs the server; they use `config.json`'s database and ask for the password, so it
never appears on the command line):

| Command | Does |
|---|---|
| `node cli.ts create-admin <username>` | creates an account that becomes admin of every gate without an admin |
| `node cli.ts reset-password <username>` | sets a temporary password for someone who forgot theirs (they choose a new one at sign-in); ends their sessions |
| `node cli.ts test-email <address>` | sends a test email with the `email` settings |
| `node cli.ts emails` | the last 20 emails: to, subject, sent / queued / failed, the error |
| `node cli.ts grant <username> <gate phone> <admin\|readonly>` | gives an account access to a gate, or changes its role (keeps at least one admin) |

**Moving from an install with DKS sign-in** (before 2026-11-13): on the first start, each gate someone had
connected to becomes a managed gate with that person's master code and, if they had saved a schedule, their DKS
login. Gates without one show "No DKS login saved yet" under System Settings → Gate login. Then create the first
account (step 2): it becomes admin of those gates.

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
read `config.json` and `doorking.key`, and write `logs/` and `media/`. Use the full path of `node` (with nvm, `readlink -f $(which node)`;
update the service after a Node upgrade). Logs: `journalctl -u doorking`.

## 6a. Public access (HTTPS)

The app itself never listens on a public address. A reverse proxy serves HTTPS on the public address and passes
requests to `127.0.0.1:8080`; `server.publicHost` in `config.json` is set to the name. Anyone who reaches the page can
try to sign in; the local accounts (with the sign-in failure limit) protect it, and the first account needs the
setup code from the server's console, so create it before (or right after) making the site public.

**Passkeys** (sign-in with fingerprint, face or PIN) need this HTTPS name: they are tied to `server.publicHost`, and
also work at `http://localhost:<port>` on the server itself, but not at `http://127.0.0.1` or another name.

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
3. `sudo systemctl reload caddy`, then set `"publicHost": "gate.example.com"` in `config.json`'s `server` section
   and restart the server.
4. Open `https://gate.example.com`. Until DNS points to the machine, Caddy logs "could not get certificate" and
   retries by itself (`journalctl -u caddy`); HTTP already redirects to HTTPS.

Sessions stay in memory, so restarting either service signs everyone out.

## 7. Update

1. `git pull` (or replace the program files, keeping `config.json`, `doorking.key`, `logs/` and `media/`).
2. `npm install` and `npm run build`.
3. Restart the server (a rebuild of the page alone doesn't need a restart; open pages show "A new version of
   this page is available" with **Reload** within a minute).

The database updates its own tables on start (see [DB.md](DB.md)); there is no separate migration step.

## 8. Back up

Back up the database (safe while the server runs), plus `doorking.key`, `config.json` and `media/`:
```
pg_dump -Fc -h 127.0.0.1 -U doorking -f doorking.dump doorking
```
(the password comes from `~/.pgpass`, section 2a). Keep the backup private: with the key it reveals master codes and
passwords. To restore into an empty database: `pg_restore -h 127.0.0.1 -U doorking -d doorking doorking.dump`, put
`doorking.key`, `config.json` and `media/` back, and start the server.

## 9. Check the install

```
npm run typecheck
npm test
```
Both should finish without errors. The tests don't contact DKS Cloud or the gate; they need the `doorking_test`
database (`database.testName`, section 2a), or `TEST_DATABASE_URL` set to another database the login may create
schemas in.

## 10. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `node` prints a syntax error for `.ts` files | Node is older than 24. Install Node 24 or later. |
| "Configuration error: …" on start | `config.json` has a mistake: the message names the setting. "can be read by other users": run `chmod 600` on the file it names. |
| "Database not available: …" on start | PostgreSQL isn't running, `config.json`'s `database` settings are missing or wrong, or the login is refused. Check with `psql -h 127.0.0.1 -U doorking doorking`. |
| The page says "The web page is not built yet" | Run `npm install` and `npm run build`, then reload. |
| `EADDRINUSE` on start | Port 8080 is in use (often a server already running). Stop the other one, or start with `--port 8081`. |
| `Forbidden host` | Open the page as `http://localhost:<port>` or `http://127.0.0.1:<port>`, or by the `server.publicHost` name through the proxy, not by machine name or IP. |
| `Forbidden origin` on sign-in through the public name | `server.publicHost` isn't set to that name, or the page was opened over `http://` instead of `https://`. |
| Sign-in says "Login refused" | DKS Cloud rejected the user or password. |
| Sign-in says "Too many failed sign-ins" | 5 failed tries for that user within 15 minutes. Wait 15 minutes. |
| A pull fails with "… Mismatch" | Gate configuration doesn't match the gate (System Settings). Fix the named value. |
| Pulls fail with a network error | The machine can't reach `dksdb.dksoftware.com` on port 443 (firewall or proxy). |
| Cameras: "Could not reach the recorder after 3 tries" | Check the recorder serial, user and password, and that it is online in DMSS/SmartPSS. |
| Something else | Turn on **System Settings → Debug logs**, repeat the action, then **Open log** (`logs/debug.log`). |
