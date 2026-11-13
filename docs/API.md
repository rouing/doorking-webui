# REST API

Every action in the web page goes through this API. Scripts and other systems use it with a gate's **API key**
(below); the routes are defined in the `ROUTES` table in `web/server.ts`.

**OpenAPI:** the routes an API key can use are described in [`openapi.json`](openapi.json) (OpenAPI 3.1), served at
`GET /api/openapi.json` and browsable at **`/api/docs`** (Swagger UI: **Authorize** with a key, then **Try it out**).
Both are public; they contain no data. A test keeps the file in step with `ROUTES` (every API-key route, method and
role); update `docs/openapi.json` with any change to those routes.

## Conventions

- **Address:** `http://localhost:8080/api` (`server.port`). The server listens on `127.0.0.1` only; with
  `server.publicHost` behind the HTTPS proxy, also `https://<name>/api`.
- **Host and Origin:** requests must use host `localhost:<port>`, `127.0.0.1:<port>` or the public host name
  (403 `Forbidden host` otherwise). Non-GET requests whose `Origin` header isn't `http://localhost:<port>`,
  `http://127.0.0.1:<port>` or `https://<public host>` get 403 `Forbidden origin`.
- **Bodies:** `POST` and `PUT` need `Content-Type: application/json` (415 otherwise). The body must be a JSON
  object of at most 10,000 bytes (400 `Bad JSON` / `The body must be a JSON object`, 413 `Request body too large`).
- **API keys (scripts):** send `Authorization: Bearer <key>`. A key is created by a gate admin under System
  Settings → API keys (or `POST /api-keys` below), shown once, and belongs to **one gate**, not to a person. It
  works only on that gate's routes (`/api/gates/{phone}/…`), with its own role (`readonly` or `admin`), until it
  expires or is revoked. Routes marked **web only** below (gate login, gate users, API keys, deleting the gate's
  data, leaving the gate) and every route outside the gate refuse keys (403). A wrong, expired or revoked key gets
  401. When a request carries an `Authorization` header, no cookie session is used. History records key actions as
  `api:<key name>`.
- **Web page sign-in:** `POST /api/session` (local account) sets the `sid` cookie (HttpOnly, SameSite=Strict; plus
  Secure through the public name), sent with every later call. A session ends after **30 minutes idle** or on
  sign-out; it survives a server restart.
- **Gate routes** are under `/api/gates/{phone}`; the signed-in user needs a role on `{phone}`, or the key must be
  that gate's (404 / 403 otherwise).
- **Background jobs:** pulls and sends return 202 and run in the background; poll `GET .../job`. One gate
  connection runs at a time across all gates (409 while one is running).
- **Errors:** `{ "error": "message" }` with the status below.

| Status | Meaning |
|---|---|
| 400 | invalid input |
| 401 | not signed in, or DKS Cloud refused the sign-in |
| 403 | wrong host or origin, read-only user on an admin route, wrong setup code, or `{ mustChangePassword: true }` |
| 404 | not found (gate, directory code, schedule, file, …) |
| 405 | wrong method (with an `Allow` header) |
| 409 | conflict (a gate connection or snapshot run is running, duplicate entry code, revert refused, …) |
| 413 | request body over 10,000 bytes |
| 415 | `POST`/`PUT` without a JSON content type |
| 429 | 5 failed sign-ins for a user name within 15 minutes; sign-in is refused for the rest of that time |
| 500 | unexpected server error |
| 502 | DKS Cloud or the camera recorder failed |

### Access levels

Each route has one of these access levels (the `scope` in `ROUTES`):

| Level | Who may call it |
|---|---|
| public | anyone |
| user | any signed-in user |
| gate | signed in with any role on the gate in `{phone}` (**admin** or **read only**); 404 otherwise |
| gate-admin | signed in with the **admin** role on that gate, or an admin API key of that gate; 403 "Only a gate admin can do this" otherwise |

**web only**: refused for API keys whatever their role: everything under "Session and gate list", "Gate login, users
and API keys" and the debug log, plus `POST /delete-data`.

A user whose password was set by someone else (a new account, or the CLI's `reset-password`) gets 403
`{ mustChangePassword: true }` from every non-public route except `PUT /api/me/password` until they choose their own.

## Session and gate list

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| GET | `/help` | public | | the user guide (`MANUAL.md`) as an HTML page (not under `/api`) |
| GET | `/api/session` | public | | `{ loggedIn: false, setup?, emailEnabled, sso }` (`setup`: no account exists yet; `sso`: the single sign-on providers `[{ id, name }]`), or `{ loggedIn: true, user, email, pendingEmail, phone, dark, notifyAccess, notifyAlerts, mustChangePassword, emailEnabled, sso, hasPassword, passwordAllowed, gate, defaults, holidayList }` (`hasPassword`: false for an account that signs in with single sign-on only; `passwordAllowed`: false when linked to a provider with `passwords: false`); `gate`: `{ phoneNumber, siteName, addedAt, role }` |
| POST | `/api/session` | public | `{ user, password }` | local account; 200 `{ ok: true }` and the `sid` cookie; 401 wrong username or password; 403 password sign-in is off for the account (it must use its single sign-on provider); 429 too many failures |
| DELETE | `/api/session` | public | | sign out: `{ ok: true }` |
| POST | `/api/setup` | public | `{ setupCode, username, password, email? }` | only while no account exists: creates the first account (admin of every gate without an admin) and signs it in: 201 `{ ok, gates }`; 403 wrong setup code (printed in the server's console at start); 409 once an account exists |
| GET | `/api/me` | user | | `{ username, email, pendingEmail, phone, dark, notifyAccess, notifyAlerts }` (`phone`: E.164 such as `+12145550100`, or `""`) (`email`: confirmed; `pendingEmail`: waiting for its link) |
| PUT | `/api/me` | user | `{ email?, phone?, dark?, notifyAccess?, notifyAlerts? }` | your own settings; `phone` is stored in international form (10 digits = US/Canada, else `+` and the country code; `""` removes it; 400 when it doesn't look like a number); a new `email` becomes `pendingEmail` and gets a confirmation link (the old confirmed address is told); `""` removes it; 409 when another account has confirmed it |
| POST | `/api/me/email/resend` | user | | sends the confirmation link again; 503 when email is off |
| POST | `/api/email/verify` | public | `{ token }` | confirms the email from a link (`#verify=<token>`): `{ username, email }`; 400 invalid, used or expired |
| POST | `/api/password-reset/request` | public | `{ identifier }` (username or confirmed email) | always 200 with the same message; a reset link (`#reset=`, 1 hour) goes to the account's confirmed email if there is one. 3 per account and 50 in total per 15 minutes; 503 when email is off |
| POST | `/api/password-reset` | public | `{ token, password }` | sets the new password, ends all the account's sessions, sends a security alert: `{ username }` |
| POST | `/api/invite/check` | public | `{ token }` | `{ username }` of an invitation link (`#invite=`), without using it up |
| POST | `/api/invite` | public | `{ token, password }` | accepts the invitation: sets the password, confirms the email, signs in (`sid` cookie) |
| PUT | `/api/me/password` | user | `{ current, password }` | change your own password (12+ characters); ends your other sessions; 403 wrong current password, or password sign-in is off for the account (linked to a provider with `passwords: false`) |
| GET | `/api/me/passkeys` | user | | `{ passkeys: [{ id, name, site, synced, createdAt, lastUsedAt }] }` |
| POST | `/api/me/passkeys/options` | user | `{ password }` (your current one; not asked when the account has none) | WebAuthn creation options for `startRegistration()`; 403 wrong password (5 tries per 15 minutes, then 429); 400 when the page isn't on the public name or `localhost` |
| POST | `/api/me/passkeys` | user | `{ name?, response }` (the browser's registration answer) | 201 `{ passkeys }`; 400 when the check fails; 409 already registered |
| PUT | `/api/me/passkeys/{id}` | user | `{ name }` | rename: `{ passkeys }` |
| DELETE | `/api/me/passkeys/{id}` | user | | remove: `{ passkeys }` |
| POST | `/api/passkey/options` | public | | WebAuthn request options for `startAuthentication()` (no username: any passkey for this site) |
| POST | `/api/passkey/session` | public | `{ response }` (the browser's answer) | signs in like `POST /api/session`: 200 and the `sid` cookie; 401 unknown passkey, bad signature, used or expired challenge, or a counter that went back |
| POST | `/api/sso/start` | public | `{ provider, invite? }` (`invite`: an invitation link's token, to accept it with the provider) | single sign-on: `{ url }` to open (the provider's sign-in page) and the `dk_sso` cookie tying the attempt to this browser (10 minutes); 404 unknown provider; 400 when the page isn't on the public name or `localhost` |
| POST | `/api/me/sso/start` | user | `{ provider, password? }` (your current password; not asked when the account has none) | like `/api/sso/start`, to link the provider account to yours; 403 wrong password (5 tries per 15 minutes, then 429) |
| GET | `/api/sso/{provider}/callback` | public | (the provider's redirect) | finishes the sign-in and redirects: to `/` with the `sid` cookie, to `/#sso=linked` after linking, or to `/#sso-error=<message>` (no account for that work account, a domain that isn't allowed, an expired or reused attempt, …) |
| GET | `/api/me/sso` | user | | `{ identities: [{ provider, providerName, subject, email, linkedAt, lastUsedAt }] }`: your linked single sign-on accounts |
| DELETE | `/api/me/sso/{provider}/{subject}` | user | | unlinks one: `{ identities }`; 409 when it's your only way left to sign in (no other link, passkey or usable password) |
| PUT | `/api/session/gate` | user | `{ phoneNumber }` | the gate the page shows (kept across reloads): `{ gate }` |
| DELETE | `/api/session/gate` | user | | back to the gate list |
| GET | `/api/gates` | user | | `{ gates: [{ phoneNumber, siteName, addedAt, role }] }`: the gates you have access to; never master codes or DKS logins |
| POST | `/api/gates` | user | `{ phoneNumber, masterCode, dksUser, dksPassword, gateConfig }` | adds a gate: 409 "already managed here, ask one of its gate admins" when it exists; 400 when DKS Cloud refuses the DKS login; else 202 and a residents pull with these values starts; the gate is saved (you as admin) only when it succeeds |
| GET | `/api/gate-add` | user | | `{ job }`: the pull checking the gate you are adding (as `/job` below), or `{ job: null }` |
| GET | `/api/gates/{phone}` | gate | | one gate (same fields) |
| DELETE | `/api/gates/{phone}` | gate | | leave the gate (remove your own access); 409 for its last admin |

### Gate login, users and API keys (prefix `/api/gates/{phone}`; web only)

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| GET | `/login` | gate-admin | | `{ dksUser, dksPasswordSet }` (the password and master code are never returned) |
| PUT | `/login` | gate-admin | `{ dksUser?, dksPassword? (empty keeps), masterCode? (empty keeps) }` | a new DKS login is checked with DKS Cloud, then saved: 200 `{ changed }`; a new master code starts a residents pull with it: 202 `{ checking: true }`, saved when the pull succeeds (progress via `/job`) |
| GET | `/users` | gate-admin | | `{ users: [{ username, email, pendingEmail, phone, invited, role, grantedBy, grantedAt, lastSignIn }] }` |
| POST | `/users` | gate-admin | `{ username, password?, email?, role? ("readonly" default \| "admin") }` | creates an account with access to this gate: with `email` and no `password` (and email on), an **invitation** link goes to the email; otherwise `password` is a temporary one (changed at first sign-in) and an `email` gets a confirmation link. 201 `{ users, invited }`; 409 `{ exists: true }` when the username is taken (share instead) |
| POST | `/users/{username}/invite` | gate-admin | | sends the invitation again (new link): `{ users }`; 409 already accepted |
| POST | `/share` | gate-admin | `{ username, role? }` | gives an existing account access: `{ users }`; 404 no such user; 409 already has access |
| PUT | `/users/{username}` | gate-admin | `{ role }` | changes a role: `{ users }`; 409 when it would leave the gate without an admin |
| DELETE | `/users/{username}` | gate-admin | | takes the user off this gate (the account stays): `{ users }`; 409 for the last admin |
| GET | `/api-keys` | gate-admin | | `{ apiKeys: [{ id, name, role, createdBy, createdAt, expiresAt, lastUsedAt }] }` (never the keys) |
| POST | `/api-keys` | gate-admin | `{ name (1-40 characters), role? ("readonly" default \| "admin"), expiresDays? (0 never, 30, 90, 365) }` | 201 `{ key, apiKey }`: `key` (`dkg_<id>_<secret>`) is shown only here |
| DELETE | `/api-keys/{id}` | gate-admin | | revokes the key at once: `{ apiKeys }` |

`defaults` are the gate-match defaults (`gateDefaults` in `config.json` plus flags); `holidayList` is the built-in
fixed-date holiday list.

## Gate connection (prefix `/api/gates/{phone}`)

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| POST | `/pull` | gate | `{ what: "residents" \| "transactions" }` | 202, starts a pull |
| GET | `/job` | gate | | `{ state: idle\|running\|done\|failed, what, phoneNumber, user, startedAt, finishedAt, log, error? }`; a job for another gate (or the pull checking a gate someone is adding) shows as `{ state: "idle", busyElsewhere }` |
| GET | `/send` | gate | | send preview: `{ changedBlocks: { "<file>.bin": [blocks] }, residentCounts }` |
| POST | `/send` | gate-admin | `{ confirm: true }` | 202, sends the working copy, then pulls residents to check the gate holds it |

Read-only users may pull. A send (and its preview) is
refused (409) when the working copy is missing files, conflicts with the gate aren't decided yet (below), or two or
more entries share a directory code, entry code or card (the error lists them; see `duplicates` below).

A residents pull updates the working copy at once: its files become what the gate holds, and unsent changes are put
back on top (resident by directory code, card by slot, setting by key). An item changed differently at the gate and
here is a **conflict**: the working copy keeps its value until someone decides. When the directory code digits or the
area-code mode changed (at the gate or in the working copy), the gate's version is taken and unsent changes are
dropped. The pull's job log says which happened.

## Residents and vendors (working copy; prefix `/api/gates/{phone}`)

`{code}` is the directory code; shorter codes get leading zeros to the gate's digit count.

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| GET | `/residents` | gate | | `{ rows, unassignedCards, areaCodes, emptyCodes, dirDigits, duplicates, cache, pulled, saved }`; each row has its `note`; `duplicates: [{ kind: directoryCode\|entryCode\|card, value, holders, text }]` lists values held by more than one entry |
| GET | `/residents/{code}` | gate | | one row |
| POST | `/residents` | gate-admin | `{ directoryCode, name, vendor?, hidden?, …fields }` | 201; fills a vacant code or inserts a new one |
| PUT | `/residents/{code}` | gate-admin | any of `name, hidden, vendor, areaCode, phone, entryCode, securityLevel, elevatorRef, floor, cards[]` | only the given fields change |
| PUT | `/residents/{code}/note` | gate-admin | `{ note }` | local note, at most 500 characters (blank clears it): `{ note }` |
| DELETE | `/residents/{code}` | gate-admin | | blanks the slot; the code stays as an empty unit |
| DELETE | `/directory-codes/{code}` | gate-admin | | removes the code from the gate entirely |
| PUT | `/dir-digits` | gate-admin | `{ digits: 1-4, confirm? }` | Num of digits in dir code; decreasing wipes all residents and needs `confirm: true` |

Edits return `{ changed: { "<file>.bin": [blocks] }, cache }`. An entry code or card number already held by
another directory code is refused with 409. `areaCode` is 3 digits, or 4 as 1 + area code for long distance;
card numbers are 00001–65407.

## Settings, working copy, preferences, history and relays (prefix `/api/gates/{phone}`)

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| GET | `/settings` | gate | | `{ fields: [{ key, group, name, offset, size, value, gate, editable, secret, note, maxLength }], pulled, saved, cache }`; secret values are masked. Read-only fields (`editable: false`) include `dialType` (`Tone`/`Rotary`), `multipleSystems` (`Yes`/`No`), `systemMemory` (e.g. `3000`), `memoryChips` (`Standard`/`MemPLUS`/`Anti-pass back`) and `downloadStamp1`/`2` (`2026-11-05 17:40:00 UTC`); a value that doesn't fit shows as `? (<hex>)` |
| PUT | `/settings` | gate-admin | `{ "<field key>": value, … }` | saves editable fields to the working copy: `{ changed, changedBlocks }`; 400 when nothing changed, or when it changes a tone-open digit (`relay{0-2}Tone…`) and two tones of relays 0–2 would share a digit (Tracker command relays are left out) |
| GET | `/data` | gate | | `{ transactions }`: `{ updated, rows }` from the transaction history, `updated` = the last transactions pull, `null` before the first; names looked up in the working copy's values (`gate_residents`, `gate_cards`) (until 2026-11-12 also `residents`, `holdOpen`, `holidays`, `securityLevels`, `facilityCodes`, `elevator`; use `/residents` and `/settings` for those) |
| GET | `/working-copy` | gate | | `{ exists, edited, conflicts: [{ kind, key, label, gate, mine }], files }`; `kind` is `resident`, `card` or `setting`, `gate`/`mine` say in words how the two values differ |
| DELETE | `/working-copy` | gate-admin | | Reset to gate: unsent changes and conflicts are dropped; the working copy becomes what the gate holds |
| POST | `/working-copy/conflicts` | gate-admin | `{ kind, key, choice: "mine" \| "gate" }` | decides a conflict: keep the working copy's value, or take the gate's (saved like an edit, in History); returns the status; 404 for no such conflict |
| GET | `/files/{name}` | gate-admin | | download the working copy's `names.bin`, `phone.bin`, `cards.bin` or their `.map` (built from the database) |
| GET | `/prefs` | gate | | the gate's preferences (see below) |
| PUT | `/prefs` | gate-admin | any preference keys | saves; changing `gateConfig.areaCodes` converts the working copy (409 when it can't) |
| GET | `/history` | gate | | `{ events, users }` (`users`: the gate's users with their last sign-in, as `/users`): up to 500 events, newest first, `{ id, time, user, action, summary, result?, error?, details, revertible, revertedBy }` |
| POST | `/history/{id}/revert` | gate-admin | | undoes that change in the working copy (and prefs); 409 if already reverted or a later change touched the same data |
| GET | `/relays` | gate | | live relay state (DKS `GetRelays`): `{ checkedAt, relays }`, all 19 relays |
| PUT | `/relays` | gate-admin | `{ "<relay>": true\|false, … }` | **changes the gate now** (DKS `SetRelays`); `true` = Active (held open). Allowed: relays 0–2 except a Tracker command relay, plus 3–10 with Tracker 2 and 11–18 with Tracker 1 (400 otherwise) |
| POST | `/delete-data` | gate-admin (web only) | `{ confirm: true }` | **deletes everything stored about the gate**: its rows in every table keyed by phone (the gate itself with its DKS login, everyone's access to it, prefs, history, schedules, camera settings, snapshot log, notes, transaction history) and its `media/<phone>/` folder: `{ removed: { <table>: rows }, filesError? }`. Nothing on the gate changes. 409 while a gate connection, snapshot run or scheduled transfer for the gate is running |

**Preferences** (`PUT /prefs`, any of these keys; they are kept in the local database, never sent to the gate):

| Key | Value |
|---|---|
| `gateConfig` | `{ siteName, memorySize, areaCodes, modelNumber, antiPassBack, interface1816 }`: the values DKS Cloud needs to connect; they must match the gate. `areaCodes` is `10 Area Codes` or `255 Area Codes` |
| `relayLabels` | `{ "<relay>": name, … }`, up to 24 characters each; only the relays given change (relays 3–18 are kept only when named) |
| `deviceAssociation` | up to 10 rows `[{ name, from, to }]`: name up to 12 characters, device codes 00001–65407, no overlapping ranges |
| `features` | `{ floors, elevators }`: which floor/elevator columns and pages the web page shows |
| `tracker` | `{ enabled, tracker1, tracker2, prevTime1?, prevTime2? }`: Tracker expansion boxes; `prevTimeN` is the command relay's strike time to restore |

**History actions:** `change` (working-copy or prefs change), `revert`, `note`, `pull`, `send`, `relay`, `camera`,
`access` (users created, shared, changed, removed or leaving), `login` (the gate's DKS login or master code changed).
Working-copy and prefs changes are recorded with what changed (as values) and can be reverted, including directory-code digit
and area-code changes; a revert is itself recorded and can be reverted. A revert is refused while a later change
touched the same resident, card, setting or layout value. Pulls, sends, relay changes
and camera changes are recorded but not revertible.

Setting field keys (for example `talkTime`, `systemMessage`, `facilityEnabled`, `apbMode`, `relay2Elevators`) are
listed in `src/gate-settings.ts`; [`BITMAP.md`](BITMAP.md) lists each key's address in `names.bin`.

## Scheduled transfers (prefix `/api/gates/{phone}`)

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| GET | `/schedules` | gate | | `{ schedules: [{ id, phoneNumber, user, days, time, actions, enabled, createdAt, nextRun, lastRun, lastResult, lastError, queued }] }`; entries run with the gate's DKS login |
| POST | `/schedules` | gate-admin | `{ days: [0-6, Sun = 0], time: "HH:MM", actions: ["send"\|"residents"\|"transactions"\|"snapshots"], enabled? }` | 201; you become its owner ("Saved by") |
| PUT | `/schedules/{id}` | gate-admin | same as POST | replaces the entry; you become its owner ("Saved by") |
| DELETE | `/schedules/{id}` | gate-admin | | deletes the entry |
| POST | `/schedules/{id}/run` | gate-admin | `{}` | 202, queues the entry now; 409 if already queued |

## Cameras and snapshots (prefix `/api/gates/{phone}`)

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| GET | `/cameras` | gate | | `{ settings }`: `{ enabled, serial, username, channels: [{ channel, name }], clockOffset, mode, frames, framesAfter, clipTries, events, backfillHours, keepDays, savedBy, savedAt }` or `null`; never the password |
| PUT | `/cameras` | gate-admin | `{ serial, username, password?, channels, clockOffset?, mode? ("snapshots"\|"video"), frames? (1-6), framesAfter? (0-6), clipTries? (1-5), events? ("access"\|"all"), backfillHours? (0-720), keepDays? (15, 30, 60, 90; 0 = forever), enabled? }` | saves; a blank password keeps the saved one |
| DELETE | `/cameras` | gate-admin | | removes the settings (pictures are kept): `{ removed }` |
| POST | `/cameras/test` | gate-admin | `{}` | a live picture per channel: `{ channels: [{ channel, name, file?, error? }] }` |
| GET | `/cameras/live/{channel}` | gate | | live MJPEG stream for an `<img>`; `?quality=high` for the main stream; 502 when no picture comes |
| GET | `/snapshots` | gate | | `{ snapshots: { "<YYYYMMDD-HHMM>": { status (done, partial, failed, removed), files, error, attempts, at, … } }, run }`; match a transaction's `minute` |
| POST | `/snapshots/run` | gate | `{}` or `{ minute }` | 202, fetches pictures for pending transactions (or only that minute; 409 during a run; 400 when every transaction at that minute is one that never gets footage: gate data transfers (RS232, modem), hold-open events (Hold Begin / Hold End), anti-pass back maintenance (Re-Sync, Counter) and System relay commands other than a momentary open (System Admit)) |
| POST | `/snapshots/stop` | gate | `{}` | stops the running snapshot run: `{ stopped }` |
| DELETE | `/snapshots` | gate-admin | | deletes every saved picture and the snapshot log: `{ minutes, files }` (409 during a run) |
| GET | `/snapshots/{minute}/{file}` | gate | | the JPEG, or the `.mp4` (supports `Range`); `{minute}` may be `live` |
| POST | `/snapshots/{minute}/{file}/refresh` | gate | `{}` | fetches that picture (or video) again: `{ snapshot }`; 502 when none was saved, 409 during a run |

`run` is `{ state: running|done|stopped|failed, startedAt, finishedAt?, progress: { minutes, minutesDone, frames,
framesDone, current, byMinute }, result, log, error?, stopping? }`, or `null`.

## Debug log

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| GET | `/api/debug-log` | user | | `{ enabled, file, size }` |
| PUT | `/api/debug-log` | user | `{ enabled }` | turns Debug logs on or off for the whole server: `{ enabled, file, size }` |
| GET | `/api/debug-log/file` | user | | `debug.log` as plain text (empty when there is none) |

## Example (`curl`)

Bash quoting; in Windows PowerShell use `curl.exe` and put JSON bodies in files (`-d "@body.json"`). Keep the key in a
file readable only by you, not on the command line:
```
printf 'Authorization: Bearer %s\n' "<your API key>" > key.hdr && chmod 600 key.hdr   # once, from a password manager
J='Content-Type: application/json'; G=https://gate.example.com/api/gates/2145550100
curl -H @key.hdr $G/residents/101
curl -H @key.hdr -X PUT -H "$J" -d '{"name":"Smith, J"}' $G/residents/101        # admin key
curl -H @key.hdr -X POST -H "$J" -d '{"what":"transactions"}' $G/pull
curl -H @key.hdr $G/job
curl -H @key.hdr $G/data
```
