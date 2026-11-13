# REST API

Every action in the web page goes through this API, so scripts can do anything the page does. The routes are
defined in the `ROUTES` table in `web/server.ts`.

## Conventions

- **Address:** `http://localhost:8080/api` (port from `--port` or `PORT`). The server listens on `127.0.0.1` only;
  with `--public-host <name>` behind the HTTPS proxy, also `https://<name>/api`.
- **Host and Origin:** requests must use host `localhost:<port>`, `127.0.0.1:<port>` or the `--public-host` name
  (403 `Forbidden host` otherwise). Non-GET requests whose `Origin` header isn't `http://localhost:<port>`,
  `http://127.0.0.1:<port>` or `https://<public host>` get 403 `Forbidden origin`.
- **Bodies:** `POST` and `PUT` need `Content-Type: application/json` (415 otherwise). The body must be a JSON
  object of at most 10,000 bytes (400 `Bad JSON` / `The body must be a JSON object`, 413 `Request body too large`).
- **Sign-in:** `POST /api/session` sets the `sid` cookie (HttpOnly, SameSite=Strict; plus Secure through the public
  name); send it with every later
  call. A session ends after **30 minutes idle**, on sign-out, or when the server restarts.
- **Gate routes** are under `/api/gates/{phone}`; `{phone}` (digits) must be in the signed-in user's gate list
  (404 `Gate not in your list` otherwise).
- **Background jobs:** pulls and sends return 202 and run in the background; poll `GET .../job`. One gate
  connection runs at a time across all gates (409 while one is running).
- **Errors:** `{ "error": "message" }` with the status below.

| Status | Meaning |
|---|---|
| 400 | invalid input |
| 401 | not signed in, or DKS Cloud refused the sign-in |
| 403 | wrong host or origin, or not connected to the gate yet (`{ error, notConnected: true }`) |
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
| gate-open | signed in, and `{phone}` is in the user's gate list |
| gate | also **connected**: the user has pulled from or sent to the gate successfully with the master code now in their list (403 `notConnected` otherwise). Changing the master code closes the gate again until the next successful connection. |
| gate-setup | like *gate*, but also open while no account has connected to the gate yet (to set it up for the first pull) |

## Session and gate list

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| GET | `/help` | public | | the user guide (`MANUAL.md`) as an HTML page (not under `/api`) |
| GET | `/api/session` | public | | `{ loggedIn: false }`, or `{ loggedIn: true, user, gate, defaults, holidayList }` |
| POST | `/api/session` | public | `{ user, password }` | DKS Cloud `CheckLogin`; 200 `{ ok: true }` and the `sid` cookie; 401 refused; 429 too many failures |
| DELETE | `/api/session` | public | | sign out: `{ ok: true }` |
| PUT | `/api/session/gate` | user | `{ phoneNumber }` | the gate the page shows (kept across reloads): `{ gate }` |
| DELETE | `/api/session/gate` | user | | back to the gate list |
| GET | `/api/gates` | user | | `{ gates: [{ phoneNumber, siteName, addedAt, verified }] }`; never master codes; `siteName` is empty until connected |
| POST | `/api/gates` | user | `{ phoneNumber, masterCode }` | 201 added, 200 master code updated; phone 4–15 digits, master code 4 digits |
| GET | `/api/gates/{phone}` | gate-open | | one gate (same fields) |
| PUT | `/api/gates/{phone}` | gate-open | `{ masterCode }` | update the master code |
| DELETE | `/api/gates/{phone}` | gate-open | | remove from your list; files, prefs, history and schedules are kept |
| DELETE | `/api/credentials` | user | | delete your saved DKS password (used by scheduled transfers): `{ removed }` |

`defaults` are the gate-match defaults (`GATE_DEFAULTS` plus command-line flags); `holidayList` is the built-in
fixed-date holiday list.

## Gate connection (prefix `/api/gates/{phone}`)

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| POST | `/pull` | gate-open | `{ what: "residents" \| "transactions" }` | 202, starts a pull |
| GET | `/job` | gate-open | | `{ state: idle\|running\|done\|failed, what, phoneNumber, user, startedAt, finishedAt, log, error? }`; a job for another gate (or another user's job before you are connected) shows as `{ state: "idle", busyElsewhere }` |
| GET | `/send` | gate | | send preview: `{ changedBlocks: { "<file>.bin": [blocks] }, residentCounts }` |
| POST | `/send` | gate | `{ confirm: true }` | 202, sends the working copy, then pulls residents to check the gate holds it |

A pull is allowed before the first connection: its success is what connects you. A send (and its preview) is
refused (409) when the working copy is missing files, a newer pull differs from its base (**Reset to gate** first),
or two or more entries share a directory code, entry code or card (the error lists them; see `duplicates` below).

## Residents and vendors (working copy; prefix `/api/gates/{phone}`)

`{code}` is the directory code; shorter codes get leading zeros to the gate's digit count.

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| GET | `/residents` | gate | | `{ rows, unassignedCards, areaCodes, emptyCodes, dirDigits, duplicates, cache, pulled, saved }`; each row has its `note`; `duplicates: [{ kind: directoryCode\|entryCode\|card, value, holders, text }]` lists values held by more than one entry |
| GET | `/residents/{code}` | gate | | one row |
| POST | `/residents` | gate | `{ directoryCode, name, vendor?, hidden?, …fields }` | 201; fills a vacant code or inserts a new one |
| PUT | `/residents/{code}` | gate | any of `name, hidden, vendor, areaCode, phone, entryCode, securityLevel, elevatorRef, floor, cards[]` | only the given fields change |
| PUT | `/residents/{code}/note` | gate | `{ note }` | local note, at most 500 characters (blank clears it): `{ note }` |
| DELETE | `/residents/{code}` | gate | | blanks the slot; the code stays as an empty unit |
| DELETE | `/directory-codes/{code}` | gate | | removes the code from the gate entirely |
| PUT | `/dir-digits` | gate | `{ digits: 1-4, confirm? }` | Num of digits in dir code; decreasing wipes all residents and needs `confirm: true` |

Edits return `{ changed: { "<file>.bin": [blocks] }, cache }`. An entry code or card number already held by
another directory code is refused with 409. `areaCode` is 3 digits, or 4 as 1 + area code for long distance;
card numbers are 00001–65407.

## Settings, working copy, preferences, history and relays (prefix `/api/gates/{phone}`)

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| GET | `/settings` | gate | | `{ fields: [{ key, group, name, offset, size, value, gate, editable, secret, note, maxLength }], pulled, saved, cache }`; secret values are masked |
| PUT | `/settings` | gate | `{ "<field key>": value, … }` | saves editable fields to the working copy: `{ changed, changedBlocks }`; 400 when nothing changed, or when it changes a tone-open digit (`relay{0-2}Tone…`) and two tones of relays 0–2 would share a digit (Tracker command relays are left out) |
| GET | `/data` | gate | | `{ transactions }`: the transaction history, with names looked up in the working copy's values (`gate_residents`, `gate_cards`) (until 2026-11-12 also `residents`, `holdOpen`, `holidays`, `securityLevels`, `facilityCodes`, `elevator`; use `/residents` and `/settings` for those) |
| GET | `/working-copy` | gate | | `{ exists, edited, newerPull, files }` |
| DELETE | `/working-copy` | gate | | Reset to gate: the working copy becomes the last pull |
| GET | `/files/{name}` | gate | | download the working copy's `names.bin`, `phone.bin`, `cards.bin` or their `.map` (built from the database) |
| GET | `/prefs` | gate-setup | | the gate's preferences (see below) |
| PUT | `/prefs` | gate-setup | any preference keys | saves; changing `gateConfig.areaCodes` converts the working copy (409 when it can't) |
| GET | `/history` | gate | | `{ events, signIns }`: up to 500 events, newest first, `{ id, time, user, action, summary, result?, error?, details, revertible, revertedBy }`; `signIns: [{ user, last, count }]` |
| POST | `/history/{id}/revert` | gate | | undoes that change in the working copy (and prefs); 409 if already reverted or a later change touched the same data |
| GET | `/relays` | gate | | live relay state (DKS `GetRelays`): `{ checkedAt, relays }`, all 19 relays |
| PUT | `/relays` | gate | `{ "<relay>": true\|false, … }` | **changes the gate now** (DKS `SetRelays`); `true` = Active (held open). Allowed: relays 0–2 except a Tracker command relay, plus 3–10 with Tracker 2 and 11–18 with Tracker 1 (400 otherwise) |
| POST | `/delete-data` | gate | `{ confirm: true }` | **deletes everything stored about the gate**: its rows in every table keyed by phone (every user's gate-list entry, prefs, history, schedules, camera settings, snapshot log, notes, transaction history) and its `DOWNLOADED/<phone>/` folder: `{ removed: { <table>: rows }, filesError? }`. Nothing on the gate changes. 409 while a gate connection, snapshot run or scheduled transfer for the gate is running |

**Preferences** (`PUT /prefs`, any of these keys; they are kept in the local database, never sent to the gate):

| Key | Value |
|---|---|
| `gateConfig` | `{ siteName, memorySize, areaCodes, modelNumber, antiPassBack, interface1816 }`: the values DKS Cloud needs to connect; they must match the gate. `areaCodes` is `10 Area Codes` or `255 Area Codes` |
| `relayLabels` | `{ "<relay>": name, … }`, up to 24 characters each; only the relays given change (relays 3–18 are kept only when named) |
| `deviceAssociation` | up to 10 rows `[{ name, from, to }]`: name up to 12 characters, device codes 00001–65407, no overlapping ranges |
| `features` | `{ floors, elevators }`: which floor/elevator columns and pages the web page shows |
| `tracker` | `{ enabled, tracker1, tracker2, prevTime1?, prevTime2? }`: Tracker expansion boxes; `prevTimeN` is the command relay's strike time to restore |

**History actions:** `change` (working-copy or prefs change), `revert`, `note`, `pull`, `send`, `relay`, `camera`.
Working-copy and prefs changes are recorded with what changed (as values) and can be reverted, including directory-code digit
and area-code changes; a revert is itself recorded and can be reverted. A revert is refused while a later change
touched the same resident, card, setting or layout value. Pulls, sends, relay changes
and camera changes are recorded but not revertible.

Setting field keys (for example `talkTime`, `systemMessage`, `facilityEnabled`, `apbMode`, `relay2Elevators`) are
listed in `src/gate-settings.ts`; [`BITMAP.md`](BITMAP.md) lists each key's address in `names.bin`.

## Scheduled transfers (prefix `/api/gates/{phone}`)

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| GET | `/schedules` | gate | | `{ schedules: [{ id, phoneNumber, user, days, time, actions, enabled, createdAt, nextRun, lastRun, lastResult, lastError, queued }], passwordSaved }` |
| POST | `/schedules` | gate | `{ days: [0-6, Sun = 0], time: "HH:MM", actions: ["send"\|"residents"\|"transactions"\|"snapshots"], enabled? }` | 201; also saves your DKS password (encrypted) |
| PUT | `/schedules/{id}` | gate | same as POST | replaces the entry; you become its owner and your password is saved |
| DELETE | `/schedules/{id}` | gate | | deletes the entry |
| POST | `/schedules/{id}/run` | gate | `{}` | 202, queues the entry now; 409 if already queued |

## Cameras and snapshots (prefix `/api/gates/{phone}`)

| Method | Path | Level | Body | Result |
|---|---|---|---|---|
| GET | `/cameras` | gate | | `{ settings }`: `{ enabled, serial, username, channels: [{ channel, name }], clockOffset, mode, frames, framesAfter, clipTries, events, backfillHours, keepDays, savedBy, savedAt }` or `null`; never the password |
| PUT | `/cameras` | gate | `{ serial, username, password?, channels, clockOffset?, mode? ("snapshots"\|"video"), frames? (1-6), framesAfter? (0-6), clipTries? (1-5), events? ("access"\|"all"), backfillHours? (0-720), keepDays? (15, 30, 60, 90; 0 = forever), enabled? }` | saves; a blank password keeps the saved one |
| DELETE | `/cameras` | gate | | removes the settings (pictures are kept): `{ removed }` |
| POST | `/cameras/test` | gate | `{}` | a live picture per channel: `{ channels: [{ channel, name, file?, error? }] }` |
| GET | `/cameras/live/{channel}` | gate | | live MJPEG stream for an `<img>`; `?quality=high` for the main stream; 502 when no picture comes |
| GET | `/snapshots` | gate | | `{ snapshots: { "<YYYYMMDD-HHMM>": { status (done, partial, failed, removed), files, error, attempts, at, … } }, run }`; match a transaction's `minute` |
| POST | `/snapshots/run` | gate | `{}` or `{ minute }` | 202, fetches pictures for pending transactions (or only that minute; 409 during a run) |
| POST | `/snapshots/stop` | gate | `{}` | stops the running snapshot run: `{ stopped }` |
| DELETE | `/snapshots` | gate | | deletes every saved picture and the snapshot log: `{ minutes, files }` (409 during a run) |
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

Bash quoting; in Windows PowerShell use `curl.exe` and put JSON bodies in files (`-d "@body.json"`).
```
J='Content-Type: application/json'; API=http://localhost:8080/api
curl -c jar.txt -H "$J" -d @login.json $API/session
curl -b jar.txt $API/gates/2145550100/residents/101
curl -b jar.txt -X PUT -H "$J" -d '{"name":"Smith, J"}' $API/gates/2145550100/residents/101
curl -b jar.txt -X POST -H "$J" -d '{"what":"residents"}' $API/gates/2145550100/pull
curl -b jar.txt $API/gates/2145550100/job
```
Keep the password in `login.json` (`{ "user": "...", "password": "..." }`) rather than on the command line, and
delete `jar.txt` afterwards: it holds the session cookie.
