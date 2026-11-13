# Database

The app keeps everything that is not on the gate in a **PostgreSQL** database, through the `pg` driver. The code is in
`src/db.ts` (connection, schema, encryption, query helpers) and the module named for each table below. (Until
2026-11-12 it was a SQLite file, `DB/data.db`; its data was copied over and checked row by row, then the SQLite
code and file were removed.)

## Files

| File | Contents | Back up | Share |
|---|---|---|---|
| `config.json` | the server's settings; `database` holds the login (host, port, name, user, password, or a full `url`). `DATABASE_URL` overrides it. Mode 0600 | yes | **never** |
| `doorking.key` | the encryption key (`paths.keyFile`, by default next to `config.json`): 32 random bytes as 64 hex digits, created on first start, mode 0600 | yes, **with** the database | **never** |
| `~/.pgpass` | the same login for `psql`, `pg_dump`, `pg_restore` (not used by the app) | no | **never** |
| `media/<phone>/` | not the database: camera pictures and videos (`snapshots/`) | yes | no |
| `logs/debug.log` | not the database: the debug log, written only while Debug logs is on | no | no |

- The server creates the key and the tables on first start. It doesn't start (exit 1) when `config.json` is wrong
  ("Configuration error"), when it or the key can be read by other users, or when the database can't be reached
  ("Database not available"). Settings are read by `loadConfig` in `src/config.ts` (see INSTALL.md §4).
- **Keep the database and the key together.** Without the key the encrypted values (master codes, passwords, gate
  files) can't be read; with both, anyone can read them. `config.json` and `doorking.key` are in `.gitignore`.
- Until 2026-11-13 the login and key were in a `DB/` folder (`DB/postgres.url`, `DB/pgpass`, `DB/key`); the key was
  moved to `doorking.key` unchanged and the login into `config.json`.
- Backups: `pg_dump` of the database plus a copy of the key (not set up yet).

### The PostgreSQL server (set up 2026-11-12)

The machine's own PostgreSQL 18 cluster (`/var/lib/postgresql/18/main`, listening on `127.0.0.1`/`::1` port 5432
only, SCRAM passwords) has:
- role **`doorking`** (login; not superuser, can't create databases or roles) owning database **`doorking`** (the
  app's) and **`doorking_test`** (for `npm test`). `PUBLIC` has no access to either database or its `public` schema.
- To open a shell: `psql -h 127.0.0.1 -U doorking doorking` (password from `~/.pgpass`). Administration:
  `sudo -u postgres psql`.
- A new install creates the role and database the same way (see [INSTALL.md](INSTALL.md)).

The Docker container `local-build-postgres-1` on the same machine belongs to another project and is unrelated.

### Tests

`npm test` uses `TEST_DATABASE_URL`, else `config.json`'s login with database `database.testName`
(`doorking_test`). Each test creates its own schema (`t_<random>`) and drops it afterwards, so tests never touch the
app's data and can run while the server runs.

## Encryption

Master codes, gates' DKS passwords, camera recorder passwords and the gate files are encrypted with **AES-256-GCM** using the key.
An encrypted value is stored as text: `v1:<iv>:<tag>:<ciphertext>` (base64 parts, a new random 12-byte IV each
time). Everything else in the database is plain text.

## Tables

Phone numbers are stored as digits only. Usernames and emails are stored lower case (they compare
case-insensitively). Times are `TIMESTAMPTZ`; the app reads and writes them as ISO 8601 text (UTC). JSON columns are
`JSONB` and hold the object described. The user column is called `username` (`user` is reserved in PostgreSQL).

### `meta`: server-wide values

| Column | Type | Meaning |
|---|---|---|
| `key` | TEXT, primary key | name |
| `value` | TEXT | value |

Keys: `debugLogs` (`1` = Debug logs on, `0` = off), `jsonImported` (time the pre-database JSON files were
imported; the import code was removed 2026-11-13), `gatesVerifiedBackfill` (time gates were marked connected from history, once;
removed 2026-11-13), `localAccountsMigrated` (time the move from DKS sign-in to local accounts ran, once), `emailsUnconfirmed`
(time earlier saved emails were made pending, once).

### `users`: local accounts (`src/users.ts`)

| Column | Type | Meaning |
|---|---|---|
| `username` | TEXT, primary key | 3-32 letters, digits, `.`, `_`, `-`; lower case |
| `password_hash` | TEXT | `scrypt$N$r$p$<salt>$<hash>` (base64); never the password |
| `email` | TEXT, unique, null | lower case; optional |
| `dark` | BOOLEAN | dark mode |
| `must_change` | BOOLEAN | the password was set by someone else (a gate admin or the CLI): the user must choose their own |
| `created_at`, `created_by` | TIMESTAMPTZ, TEXT | when and by whom (`setup`, `cli` or a username) |
| `last_sign_in`, `sign_ins` | TIMESTAMPTZ null, INTEGER | last sign-in (password or passkey) and the count |
| `webauthn_id` | TEXT, null | random WebAuthn user handle (base64url) given to passkeys, so they don't hold the username |
| `pending_email` | TEXT, null | an address waiting for its confirmation link (not unique; `email` holds only confirmed addresses since 2026-11-13) |
| `notify_access`, `notify_alerts` | BOOLEAN | the user's email notifications: gate access changes; gate alerts as an admin |

`password_hash` is `!` for an invited account that hasn't accepted its invitation (nothing matches it).

### `sessions`: sign-in sessions (`src/users.ts`)

| Column | Type | Meaning |
|---|---|---|
| `token_hash` | TEXT, primary key | SHA-256 of the `sid` cookie's token (the token itself is not stored) |
| `username` | TEXT | references `users` (deleted with it) |
| `created_at`, `last_seen` | TIMESTAMPTZ | `last_seen` is written at most once a minute; idle sessions are deleted |
| `gate` | TEXT, null | the gate the page has open |

### `email_tokens`: one-use links in emails (`src/email.ts`)

| Column | Type | Meaning |
|---|---|---|
| `token_hash` | TEXT, primary key | SHA-256 of the token in the link (the token itself is not stored) |
| `kind` | TEXT | `verify` (24 h), `reset` (1 h) or `invite` (72 h) |
| `username` | TEXT | references `users` (deleted with it) |
| `data` | TEXT | for `verify`/`invite`: the address being confirmed |
| `created_at`, `expires_at` | TIMESTAMPTZ | a new token of the same kind replaces the user's older one; using one deletes it |

### `emails`: the outbox (`src/email.ts`)

| Column | Type | Meaning |
|---|---|---|
| `id` | BIGINT, identity | |
| `to_addr`, `subject`, `kind` | TEXT | `kind`: `verify`, `reset`, `invite`, `access`, `security` or `alert` |
| `body` | TEXT, null | the text, **encrypted**; set to null once sent or given up |
| `status` | TEXT | `queued`, `sent` or `failed` (after 6 tries: waits of 1, 5, 15, 60 and 240 minutes) |
| `attempts`, `next_try`, `error` | INTEGER, TIMESTAMPTZ, TEXT | delivery tries, when the next one is due, the last SMTP error |
| `created_at`, `sent_at` | TIMESTAMPTZ | |

### `passkeys`: passkeys (WebAuthn) for signing in (`src/passkeys.ts`)

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT, primary key | credential id (base64url) |
| `username` | TEXT | references `users` (deleted with it) |
| `rp_id` | TEXT | the site name it works on (the public name, or `localhost`) |
| `public_key` | BYTEA | COSE public key (not secret) |
| `counter` | BIGINT | signature counter; a sign-in must raise it (0 for authenticators that don't count) |
| `transports` | JSONB | how the browser reaches it (`internal`, `usb`, `hybrid`, …) |
| `name` | TEXT | the user's label |
| `device_type`, `backed_up` | TEXT, BOOLEAN | `singleDevice`/`multiDevice`, and whether a provider syncs it |
| `created_at`, `last_used_at` | TIMESTAMPTZ | added, last sign-in |

### `managed_gates`: the gates this server manages (`src/gate-list.ts`)

| Column | Type | Meaning |
|---|---|---|
| `phone` | TEXT, primary key | gate system phone number |
| `master_code` | TEXT | 4-digit master code, **encrypted** |
| `dks_user` | TEXT | the gate's DKS Cloud user ('' = not set yet) |
| `dks_password` | TEXT | its password, **encrypted** ('' = not set yet) |
| `added_by`, `added_at` | TEXT, TIMESTAMPTZ | who added it, when |

A row is added only after a successful residents pull with these values (or by the 2026-11-13 migration).

### `gate_access`: who may use each gate (`src/gate-list.ts`)

| Column | Type | Meaning |
|---|---|---|
| `phone` | TEXT | references `managed_gates` |
| `username` | TEXT | references `users` |
| `role` | TEXT | `admin` or `readonly` |
| `granted_by`, `granted_at` | TEXT, TIMESTAMPTZ | who gave access, when |

Primary key (`phone`, `username`); index on `username`. Changes that would leave a gate without an admin are
refused (the gate's row is locked while admins are counted).

### `api_keys`: API keys, one gate each (`src/api-keys.ts`)

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT, primary key | 12 hex digits, also part of the key (`dkg_<id>_<secret>`) |
| `phone` | TEXT | references `managed_gates` (deleted with it) |
| `name` | TEXT | label, e.g. "Home Assistant" |
| `role` | TEXT | `admin` or `readonly` |
| `secret_hash` | TEXT | SHA-256 of the whole key (hex); the key itself is never stored |
| `created_by`, `created_at` | TEXT, TIMESTAMPTZ | the admin who created it (recorded only; the key doesn't depend on them), when |
| `expires_at` | TIMESTAMPTZ, null | null = never |
| `last_used_at` | TIMESTAMPTZ, null | written at most once a minute |

Revoking deletes the row.

### `gates`: each DKS user's gate list (until 2026-11-13; kept, no longer used)

| Column | Type | Meaning |
|---|---|---|
| `username` | TEXT | DKS user, lower case |
| `phone` | TEXT | gate system phone number |
| `master_code` | TEXT | 4-digit master code, **encrypted** |
| `added_at` | TIMESTAMPTZ | when the user added the gate |
| `verified_at` | TIMESTAMPTZ, null | when this user last connected successfully (pull or send) with this master code; null = not connected. Cleared when the master code changes |

Primary key (`username`, `phone`); index `gates_phone` on `phone`.

### `prefs`: per-gate preferences (`src/prefs.ts`)

| Column | Type | Meaning |
|---|---|---|
| `phone` | TEXT, primary key | gate |
| `data` | JSONB | `{ gateConfig?, relayLabels?, deviceAssociation?, features?, tracker? }` (see `PUT /prefs` in [API.md](API.md)) |

### `sign_ins`: last sign-in per DKS user (until 2026-11-13; kept, no longer used)

| Column | Type | Meaning |
|---|---|---|
| `username` | TEXT, primary key | DKS user as typed |
| `last` | TIMESTAMPTZ | time of the last sign-in |
| `count` | INTEGER | number of sign-ins |

### `history`: what happened on each gate (`src/audit.ts`)

| Column | Type | Meaning |
|---|---|---|
| `seq` | BIGINT, primary key, identity | order |
| `id` | TEXT, unique | random 16-hex-digit id |
| `phone` | TEXT | gate |
| `data` | JSONB | the event (below) |

Index `history_phone` on (`phone`, `seq`). Rows are only added, never changed or deleted.
The event JSON: `{ id, time, user, action, summary, result?, error?, what?, scheduled?, details?, values?, files?, prefs?,
revertOf? }`.
- `action`: `change`, `revert`, `note`, `pull`, `send`, `relay`, `camera`, `access` (gate users), `login` (gate login) or
  `apikey` (API key created or revoked).
- `user`: the local username, or `api:<key name>` for API key requests (DKS user names on events before 2026-11-13).
- `details`: `[{ key, label, change: added|removed|changed|sent, fields: [{ field, from, to }] }]` for the History page.
- `values`: the working-copy change that Revert undoes, as values (`diffStates` in `src/gate-state.ts`): `{ residents?:
  { <directory code>: [before, after] }, cards?: { <slot>: [before, after] }, settings?: { <key>: [before, after] },
  layout?: { dirDigits | areaCodeMode | areaCodes | middlePointer: [before, after] } }`; null = absent (added or
  removed). Only what changed is listed. Revert refuses when a listed value no longer holds its "after" value.
- `files` (events before 2026-11-12): per working-copy file, a byte patch: `{ runs: [[offset, beforeHex, afterHex], …] }`,
  or `{ whole: true, before, after }` (both whole files, raw-deflated and base64) when the file size changed. These
  can still be reverted.
- `prefs`: `{ before, after }`, the preference keys the change touched.
- `revertOf`: the id of the event a revert undid.

### `credentials`: saved DKS passwords for scheduled transfers (until 2026-11-13; kept, no longer used)

| Column | Type | Meaning |
|---|---|---|
| `username` | TEXT, primary key | DKS user, lower case |
| `login` | TEXT | the user name as typed (sent to DKS Cloud) |
| `password` | TEXT | DKS password, **encrypted** |
| `saved_at` | TIMESTAMPTZ | when it was saved |

The 2026-11-13 migration copied each gate's saved login into `managed_gates`. Schedules now use the gate's DKS login.

### `schedules`: scheduled transfers (`src/schedules.ts`)

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT, primary key | random 16-hex-digit id |
| `phone` | TEXT | gate |
| `username` | TEXT | who last saved it ("Saved by"); entries run with the gate's DKS login |
| `data` | JSONB | `{ days: [0-6, Sun = 0], time: "HH:MM", actions: ["send"\|"residents"\|"transactions"\|"snapshots"], enabled }` |
| `created_at` | TIMESTAMPTZ | when it was created |
| `last_due` | TIMESTAMPTZ, null | the last scheduled time it was queued for (also set on save, so a new entry waits for its next time) |
| `last_run` | TIMESTAMPTZ, null | when it last finished |
| `last_result` | TEXT, null | `done` or `failed` |
| `last_error` | TEXT, null | errors and notes of the last run, `; `-separated |

### `cameras`: camera recorder settings per gate (`src/cameras.ts`)

| Column | Type | Meaning |
|---|---|---|
| `phone` | TEXT, primary key | gate |
| `data` | JSONB | `{ enabled, serial, username, channels: [{ channel, name }], clockOffset, mode, frames, framesAfter, clipTries, events, backfillHours, keepDays }` (`keepDays`: 15, 30, 60, 90; 0 or missing = forever) |
| `password` | TEXT | recorder password, **encrypted** |
| `saved_by` | TEXT | user who saved them |
| `saved_at` | TIMESTAMPTZ | when |

### `snapshots`: camera picture log per transaction minute (`src/cameras.ts`)

| Column | Type | Meaning |
|---|---|---|
| `phone` | TEXT | gate |
| `minute` | TEXT | transaction minute, `YYYYMMDD-HHMM` (local time; the folder name under `snapshots/`) |
| `status` | TEXT | `done`, `partial`, `failed`, or `removed` (files deleted by `tidySnapshots`: older than `keepDays`, or no longer on disk; `error` says which) |
| `files` | JSONB | saved file names, e.g. `["ch1-00.jpg", "ch1-20.jpg"]` or `["ch1.mp4"]` |
| `error` | TEXT, null | errors of the last try, `; `-separated |
| `attempts` | INTEGER | runs that tried this minute |
| `at` | TIMESTAMPTZ | time of the last try |
| `shifts` | JSONB, null | `{ file: seconds }` for pictures taken that many seconds from the planned time |
| `video_attempts` | INTEGER, default 0 | runs made in video mode |
| `short` | JSONB, null | `{ file: seconds }` for partial videos (kept, fetched again later) |

Primary key (`phone`, `minute`).

### `notes`: local resident/vendor notes (`src/notes.ts`)

| Column | Type | Meaning |
|---|---|---|
| `phone` | TEXT | gate |
| `code` | TEXT | directory code without leading zeros (so a note survives a change of digit count) |
| `note` | TEXT | up to 500 characters |
| `saved_by` | TEXT | user who saved it |
| `saved_at` | TIMESTAMPTZ | when |

Primary key (`phone`, `code`). Never sent to the gate. Clearing a note deletes its row.

### `tx_history`: every transaction pulled from each gate (`src/tx-history.ts`)

| Column | Type | Meaning |
|---|---|---|
| `phone` | TEXT | gate |
| `seq` | INTEGER | order within the gate, oldest first |
| `raw` | TEXT | the 10-byte `rcv_out.bin` record as hex (layout in [BITMAP.md](BITMAP.md)) |
| `year` | INTEGER | year worked out when the record was first saved (the gate stores no year) |
| `added_at` | TIMESTAMPTZ | when the pull that added it ran |

Primary key (`phone`, `seq`). Each transactions pull adds only the records after the part already saved, in one
transaction that holds a per-gate lock (`pg_advisory_xact_lock`), so two merges for a gate can't interleave.

### `gate_files`: the gate's board files (`src/gate-cache.ts`)

| Column | Type | Meaning |
|---|---|---|
| `phone` | TEXT | gate |
| `copy` | TEXT | `pulled` (the latest pull) or `base` (as pulled when the working copy was made: what the gate holds). `working` was the working copy as files until 2026-11-12 (now values, below); `migrateWorkingFiles` converts any left |
| `name` | TEXT | `names.bin`, `phone.bin`, `cards.bin`; `rcv_out.bin` (transactions) is kept as `pulled` only |
| `data` | BYTEA | the file, **encrypted** (12-byte IV, 16-byte tag, ciphertext) |
| `saved_at` | TIMESTAMPTZ | when it was pulled |

Primary key (`phone`, `copy`, `name`). Change maps (`.map`) are not stored: they're worked out from `base` and the
built working copy. The layouts of the files are in [BITMAP.md](BITMAP.md). Until 2026-11-12 these were files under
`DOWNLOADED/<phone>/` (and `cache/`); `importGateFiles` moved them in once (meta `gateFilesImported`).

### `gate_residents`, `gate_cards`, `gate_settings`, `gate_working`: the working copy as values (`src/gate-state.ts`)

The working copy is these rows. **Reset to gate** (and a residents pull while there are no unsent edits) fills them
from the pull; every edit replaces them. The values are the text the app shows, so with no unsent edits they show
what the gate holds. The board files to show, compare or send are built from them (below).

| Table | Columns |
|---|---|
| `gate_residents` | `phone`, `seq` (order), `directory_code`, `type` (`Resident`/`Vendor`), `name`, `hidden`, `area_code`, `phone_number` (`555-0142`), `entry_code`, `security_level`, `floor`, `elevator_ref`, `entry_offset` / `record_offset` (where the entry is in `names.bin` / `phone.bin`). Primary key (`phone`, `seq`) |
| `gate_cards` | `phone`, `slot` (record number in `cards.bin`), `card_number` (5 digits), `directory_code` (`''` = not assigned, null = not a directory code), `raw_code` (bytes 2-3 as hex when not a directory code, e.g. a mass-enabled `AB` record). Primary key (`phone`, `slot`) |
| `gate_settings` | `phone`, `key` (as in `src/gate-settings.ts`), `grp` (page), `name`, `value` (e.g. `1:00`, `Off`, `0000001` = days Sun…Sat, `''` = not set). The master code is left out. Primary key (`phone`, `key`) |
| `gate_working` | `phone` (primary key), `dir_digits` (1-4), `area_code_mode` (255 or 10), `area_codes` (JSONB: the area-code table, one entry per slot, null = free), `middle_pointer` (`names.bin` `0xF8`-`0xFA` as hex), `base_ok` (the base passed the round-trip check; false locks editing), `saved_at` (last edit) |
| `gate_state` | the round-trip check of the latest pull: `phone` (primary key), `pulled_at`, `checked_at`, `round_trip_ok`, `problems` (JSONB: `[{ file, bytes, offsets, settings?, error? }]`) |

**Building the files** (`buildFiles`): from the base copy, in this order: the directory code digits (if changed);
the area-code table (if the layout is unchanged); codes removed, resident values that differ written, codes added;
the area-code layout and its table (if changed); settings that differ; the directory order (by `entry_offset`) and
the middle pointer; `cards.bin` from its slots. Everything else, including every byte nothing decodes, comes from
the base copy. The steps use the same functions as the edit pages.

**Saving an edit** (`writeCacheFiles`): the page's edit runs on the built files as before; the result is decoded into
values, which are saved only if building from them gives the same files byte for byte. Otherwise the edit is refused
(409, nothing saved). Edits are refused while `base_ok` is false.

**Round-trip check.** The decoded values are written back, with the app's own encoders, over a copy of the pull
whose decoded bytes were overwritten first (settings, names and flag bits, phone record bytes 2-9; `cards.bin` is
built from its slots). The copy must come out byte for byte the same as the pull, which shows the files can be built
from values like these. Bytes nothing decodes are carried over. The directory's middle-entry pointer (`0xF8`) is kept
from the pull when the directory rebuilt exactly, as edits do.

## Deleting a gate's data

**System Settings → Delete stored gate data** (`POST /api/gates/{phone}/delete-data`) runs `deleteGateData` in
`src/gate-list.ts`: in one transaction it deletes the gate's rows from `gate_access`, `api_keys`, `managed_gates`, `gates`,
`prefs`, `history`, `schedules`, `cameras`, `snapshots`, `notes`, `tx_history`, `gate_files`, `gate_residents`,
`gate_cards`, `gate_settings`, `gate_state` and `gate_working`, and closes it in open sessions. The server then
deletes `media/<phone>/` (camera pictures). Accounts and `meta` are not about one gate and are kept.

## Schema changes

`openStore` creates missing tables and indexes with `CREATE … IF NOT EXISTS` on every start. A new column needs an
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` there too, so existing databases update themselves. Nothing is ever dropped.

## Looking inside

With `psql` (safe while the server runs), from the project root:
```
psql -h 127.0.0.1 -U doorking doorking -c "SELECT phone, COUNT(*) FROM tx_history GROUP BY phone"
```
Encrypted columns can only be read with the key (`decrypt` in `src/db.ts`); don't print them.
