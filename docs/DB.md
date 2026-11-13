# Database

The app keeps everything that is not on the gate in a **PostgreSQL** database, through the `pg` driver. The code is in
`src/db.ts` (connection, schema, encryption, query helpers) and the module named for each table below. (Until
2026-11-12 it was a SQLite file, `DB/data.db`; its data was copied over and checked row by row, then the SQLite
code and file were removed.)

## Files

| File | Contents | Back up | Share |
|---|---|---|---|
| `DB/postgres.url` | the connection URL, `postgres://<user>:<password>@<host>:5432/<database>` (mode 0600). `DATABASE_URL` overrides it | yes | **never** |
| `DB/pgpass` | the same login in `.pgpass` format, for `psql` (not used by the app) | no | **never** |
| `DB/key` | the encryption key: 32 random bytes as 64 hex digits, created on first start (file mode 0600 where the system supports it) | yes, **with** the database | **never** |
| `DOWNLOADED/<phone>/` | not the database: camera pictures and videos (`snapshots/`) | yes | no |
| `logs/debug.log` | not the database: the debug log, written only while Debug logs is on | no | no |

- The folder is `DB` by default; `--db <folder>` uses another one. The server creates the folder, the key and
  the tables on first start. It doesn't start (exit 1, "Database not available") when the database can't be reached.
- **Keep the database and `key` together.** Without the key the encrypted values (master codes, passwords) can't be
  read; with both, anyone can read them. `DB/` is in `.gitignore`.
- Backups: `pg_dump` of the database plus a copy of `key` (not set up yet).

### The PostgreSQL server (set up 2026-11-12)

The machine's own PostgreSQL 18 cluster (`/var/lib/postgresql/18/main`, listening on `127.0.0.1`/`::1` port 5432
only, SCRAM passwords) has:
- role **`doorking`** (login; not superuser, can't create databases or roles) owning database **`doorking`** (the
  app's) and **`doorking_test`** (for `npm test`). `PUBLIC` has no access to either database or its `public` schema.
- To open a shell: `PGPASSFILE=DB/pgpass psql -h 127.0.0.1 -U doorking doorking`. Administration:
  `sudo -u postgres psql`.
- A new install creates the role and database the same way (see [INSTALL.md](INSTALL.md)).

The Docker container `local-build-postgres-1` on the same machine belongs to another project and is unrelated.

### Tests

`npm test` uses `TEST_DATABASE_URL`, else the URL in `DB/postgres.url` with the database name changed to
`doorking_test`. Each test creates its own schema (`t_<random>`) and drops it afterwards, so tests never touch the
app's data and can run while the server runs.

## Encryption

Master codes, saved DKS passwords and camera recorder passwords are encrypted with **AES-256-GCM** using `key`.
An encrypted value is stored as text: `v1:<iv>:<tag>:<ciphertext>` (base64 parts, a new random 12-byte IV each
time). Everything else in the database is plain text.

## Tables

Phone numbers are stored as digits only. User names are stored lower case where noted (DKS user names compare
case-insensitively). Times are `TIMESTAMPTZ`; the app reads and writes them as ISO 8601 text (UTC). JSON columns are
`JSONB` and hold the object described. The user column is called `username` (`user` is reserved in PostgreSQL).

### `meta`: server-wide values

| Column | Type | Meaning |
|---|---|---|
| `key` | TEXT, primary key | name |
| `value` | TEXT | value |

Keys: `debugLogs` (`1` = Debug logs on, `0` = off), `jsonImported` (time the pre-database JSON files were
imported), `gatesVerifiedBackfill` (time gates were marked connected from history, once).

### `gates`: each user's gate list (`src/gate-list.ts`)

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

### `sign_ins`: last sign-in per user (`src/audit.ts`)

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
- `action`: `change`, `revert`, `note`, `pull`, `send`, `relay` or `camera`.
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

### `credentials`: saved DKS passwords for scheduled transfers (`src/schedules.ts`)

| Column | Type | Meaning |
|---|---|---|
| `username` | TEXT, primary key | DKS user, lower case |
| `login` | TEXT | the user name as typed (sent to DKS Cloud) |
| `password` | TEXT | DKS password, **encrypted** |
| `saved_at` | TIMESTAMPTZ | when it was saved |

A row is written when the user saves a scheduled transfer, updated on each later sign-in, and deleted by
**Forget my saved password**.

### `schedules`: scheduled transfers (`src/schedules.ts`)

| Column | Type | Meaning |
|---|---|---|
| `id` | TEXT, primary key | random 16-hex-digit id |
| `phone` | TEXT | gate |
| `username` | TEXT | owner: the user who last saved it (it runs with their saved password) |
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
`src/gate-list.ts`: in one transaction it deletes the gate's rows from `gates` (every user), `prefs`, `history`,
`schedules`, `cameras`, `snapshots`, `notes`, `tx_history`, `gate_files`, `gate_residents`, `gate_cards`,
`gate_settings` and `gate_state`. The server then deletes `DOWNLOADED/<phone>/` (camera pictures).
`meta`, `sign_ins` and `credentials` are not about one gate and are kept.

## Schema changes

`openStore` creates missing tables and indexes with `CREATE … IF NOT EXISTS` on every start. A new column needs an
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` there too, so existing databases update themselves. Nothing is ever dropped.

## One-time import

On the first start with a new database, `importJson` imports the files used before the database existed, if they
are there: `gates.json`, `prefs.json`, `DOWNLOADED/sign-ins.json` and every `DOWNLOADED/<phone>/history.jsonl`.
It then sets `meta.jsonImported` and never runs again. The files are left in place; delete them once the import is
checked (`gates.json` holds master codes in plain text).

## Looking inside

With `psql` (safe while the server runs), from the project root:
```
PGPASSFILE=DB/pgpass psql -h 127.0.0.1 -U doorking doorking -c "SELECT phone, COUNT(*) FROM tx_history GROUP BY phone"
```
Encrypted columns can only be read with `key` (`decrypt` in `src/db.ts`); don't print them.
