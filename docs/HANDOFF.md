# DoorKing Gate Manager — Project Handoff

> Read this first. It is the single source of truth for picking up the project on a new machine
> or by a new AI/engineer. It records what the project is, what works today, the reverse-engineered
> binary format (the hard-won part), the architecture, how to run it, the methodology, and what's
> left. Dates are absolute. Last updated: **2026-11-12**. Setup, UI and the full REST API are in `README.md`
> (and `API.md`); the user guide is `MANUAL.md`. The web app is the project root (it was in `JS/` until
> 2026-11-12); every document except `README.md` is in `docs/`, and `docs/MANUAL.md` is what `GET /help` serves.
> Reference material (decompile, manual PDF) is in `research/`.
>
> **Source history:** the conversation exports were deleted on 2026-10-16. This file is the only record of
> the project's history.

---

## 1. What this is

A modern JavaScript rebuild of the discontinued **DoorKing32.exe** ("DoorKing Account Manager" /
"Remote Account Manager") Windows app, used to manage a **DoorKing** telephone-entry gate system
(models **1833 / 1835 / 1837 / 1838**, DKS Cellular). It is a local Node.js web app in TypeScript (server
runs on Node 24 with one runtime npm package, `pg`, for its PostgreSQL database; the React page is built with
`npm run build`) that talks to
**DKS Cloud** (a SOAP web service) to pull from and push to the physical gate.

**Core principle:** the gate's `.bin` memory images are the **single source of truth**. We do **not**
use any `.DAT` files (RESIDENT.DAT / ACCOUNT.DAT, etc.) as a source of truth — those were only the
old desktop app's local database. Anything the old app kept only in `.DAT` (relay labels, LCD
single-vs-8-line mode, gate-match config) we reimplement as our own **preferences**, not gate data.

The gate exchanges four memory images via DKS Cloud:
- `names.bin` — 64000 bytes. Settings header, LCD display text, area-code table, holiday/security/
  hold-open/elevator/facility tables, **and the A–Z resident directory**.
- `phone.bin` — 30080 bytes. 10-byte records (phone number, entry code, security, elevator, floor).
- `cards.bin` — 32000 bytes. 4-byte records (card number ↔ directory code).
- `rcv_out.bin` — transactions log (read-only; pulled, never sent).

---

## 2. Current status (what works today)

Working, tested end-to-end against live gate pulls:

- **Local accounts and gate roles (2026-11-13; replaced DKS sign-in):** `src/users.ts` (accounts: scrypt hashes,
  12+ character passwords, unique case-insensitive usernames and emails; sessions in table `sessions`, token SHA-256
  only, so they survive restarts) and `src/gate-list.ts` (`managed_gates`: one row per gate with its encrypted
  master code and DKS login; `gate_access`: role `admin` or `readonly` per user and gate). Every DKS call for a gate
  uses its DKS login (`asGate` in server.ts sets `user`/`password` to it; `actor` is the local username for History).
  - Adding a gate (`POST /api/gates`): 409 `ALREADY_ADDED` if managed already; `CheckLogin` of the DKS login; then
    the gate configuration is saved to prefs and a residents pull runs with `JobInfo.adding`; `finishAdding()`
    calls `registerGate` (adder = admin) on success, else `deleteGateData` for that phone (nothing left behind).
    Only one connection runs at a time, so two adds of one phone can't race.
  - Changing the gate login (`PUT G/login`): a new DKS login is `CheckLogin`-ed and saved; a new master code runs a
    residents pull (`startLoginCheck`) and is saved only on success.
  - Scopes: `gate` (any role; read-only users may view, pull, use cameras, read relay state) and `gate-admin`
    (everything else, incl. board file downloads because names.bin holds the master code). Debug log routes need
    admin of any gate. A user with `must_change` (password set by an admin or the CLI) gets 403
    `mustChangePassword` everywhere except `PUT /api/me/password`.
  - Last-admin rule in `setRole`/`revokeAccess` (gate row locked `FOR UPDATE`). No self-registration. Admins can't
    set others' passwords; `node cli.ts reset-password` (operator) can, plus `create-admin` and `grant`.
  - First account: setup page with a one-time code printed to the console at start (`SETUP_CODE`), or the CLI; it
    adopts every gate without an admin (`adoptAdminlessGates`). `migrateToLocalAccounts()` (once,
    `meta.localAccountsMigrated`) made managed gates from the old per-user `gates` (connected entries) and
    `credentials` (saved schedule passwords). Old tables `gates`, `credentials`, `sign_ins` are kept, unused.
  - **API keys (2026-11-13):** `src/api-keys.ts`, table `api_keys`: per gate, not per person; `dkg_<id>_<secret>`,
    SHA-256 stored, role, optional expiry, `last_used_at`. The request handler authenticates a `Bearer` key before
    sessions; keys reach only `gate`/`gate-admin` routes of their own gate and never `webOnly(...)` routes (gate
    login, users, share, API keys, delete-data, leave). The handler's `s.user` is `api:<name>` (History, logs).
  - **Passkeys (2026-11-13):** `src/passkeys.ts` with `@simplewebauthn/server` 14 / `browser` 14; table `passkeys`,
    `users.webauthn_id`. Relying party from the request's Host (`relyingParty()` in server.ts): `server.publicHost`
    with `https://` origin, or `localhost:<port>` with `http://`; other hosts get 400. Discoverable credentials,
    `userVerification: 'required'`, attestation `none`; challenges in memory (5 min, one use, bound to user and
    site). Adding needs the current password (`checkOwnPassword`, counted in `failedSignIns`). The test suite drives
    it with a software ES256 authenticator (`softAuthenticator()` in test/gate-cache.test.ts).
  - **Email (2026-11-13):** `src/email.ts` (nodemailer 10 SMTP; `createMailer` from `config.email`, null = off).
    Outbox `emails` (encrypted body, nulled after sending; `sendQueued` every 30 s and after each `queueEmail`),
    tokens `email_tokens` (hash, kind, expiry, one use; new one replaces the old). `users.email` = confirmed only
    (unique); `pending_email` until the `#verify=` link (`confirmEmail` re-checks uniqueness). Invited accounts have
    password hash `!` until `acceptInvite`. Server helpers: `mailTo`, `securityAlert`, `accessEmail` (respects
    `notify_access`), `gateAlert` (`alertRecipients`: admins with a confirmed email and `notify_alerts`; sent for a
    failed non-scheduled send and a failed scheduled run). Reset request rate limits in memory (`resetRequests`).
    UI: `EmailLink` (App reads `#verify|reset|invite=` once and clears it), `ForgotPassword`. CLI `test-email`, `emails`.
  - UI: `Account.tsx` (first setup, forced password change, User Settings: dark mode, email, notifications, passkeys, password), `Gates.tsx`
    (roles, Leave, Add a gate with DKS login + configuration and progress), System Settings → Gate login / Gate
    users, read-only via `ReadOnlyContext` (edit buttons hidden; settings pages in a disabled `<fieldset>`).
- **Pull residents** and **Pull transactions** (read from the gate into the database).
- **Live Relay Control** — red/green buttons for relays 0–2 (`GetRelays`/`SetRelays`); holds the gate
  open / releases, immediately, with confirm. Lives on the **Relays** page. State is read
  automatically once when the app opens (login or reload while logged in); **Refresh** re-reads it.
- **Residents / Vendors** full CRUD on the **working copy**:
  - Browse (sortable, filterable), expand a row for recent transactions.
  - **Edit** a resident (name, phone, entry code, security, floor, elevator ref, hide) with a
    **devices/cards** list (add/remove).
  - **Vendors** are a separate list with only name / entry code / security level / cards (vendors have no
    phone/hide/floor/elevator; the DoorKing manual gives vendors a security level).
  - **Delete** (returns the slot to the gate's empty-slot byte format).
  - **Add** a resident/vendor into a vacant unit code, or under a new code (inserted in DoorKing32 order, §3.4.1).
  - **Remove code** (takes the code off the gate entirely, as DoorKing32's delete does, §3.4.1).
- **System editors**, all editing the working copy: Display (the Display groups of the names.bin
  settings table, plus the per-browser LCD display-mode toggle), Relays (Live Relay Control plus the
  Relays group as a relay × setting grid), Hold Open schedule, Holidays, Security Levels, Facility
  Codes, Elevator, Anti-Pass Back.
- **System Settings** page: **Gate settings** (the remaining names.bin settings as labelled fields,
  editing the working copy; the same editor is moved between this page, Relays and Display),
  plus local, gate-scoped options keyed by phone number (shared across accounts managing the same
  gate): **Gate configuration** (site name/memory/area codes/model/anti-passback/interface — used
  automatically by pulls & sends), **Device association**; and dark mode (per-browser). Relay names are
  on the Relays page (2026-10-21).
- **Working-copy model**: pull → cache → edit (blue=unsaved, green=saved-not-sent) → **Send to gate**
  (with a post-send verify pull) or **Reset to gate**.
- **Connection progress dock** (minimizable, bottom-right; reopenable).
- **Scheduled Transfers** page (added 2026-10-16; not yet run against a live gate): per-gate entries of days
  + time (server local, 24-hour) + transfers (send working copy, pull residents, pull transactions), run by
  the server unattended with the saving user's encrypted DKS password. Reworks DoorKing32's Scheduled Transfers
  (4 shared schedules A–D, run only while the app is open). Details in `README.md` → Scheduled transfers.
- **Database** (added 2026-10-16 as SQLite `DB/data.db`; **PostgreSQL since 2026-11-12**, see §9): PostgreSQL
  (login in `config.json`'s `database` section since 2026-11-13, see §9) + `doorking.key` (AES-256-GCM) holds gate
  lists, prefs, sign-ins, history, saved passwords, schedules, camera settings, snapshot log, notes, transaction
  history and gate files. (The one-time import of the pre-database JSON files, `importJson`, ran 2026-10-16 and
  was removed 2026-11-13.)
- **Added 2026-10-21 (built and tested; not yet clicked through against the live gate):**
  - **Duplicate checks:** `findDuplicates()` (`residents-edit.ts`) finds directory codes, entry codes and cards
    used by more than one entry. `GET G/residents` returns them (`duplicates`); Residents/Vendors show a red
    alert and red cells. `refuseDuplicates()` in `server.ts` blocks Send to gate, its preview and scheduled sends.
    Edits already refused to create duplicates. The live gate's working copy has none.
  - **Repeated tone-open digits:** a `PUT G/settings` that changes a `relayNTone*` field is refused while two tones
    of relays 0-2 share a digit (`toneConflicts()`, Tracker command relays skipped); the Relays page marks
    both boxes red and disables Save.
  - **Relay names** moved from System Settings into a Name column of the Relays table (still prefs
    `relayLabels`, never sent to the gate).
  - **Security level 1 / 0** show as "Enabled" / "Disabled" in Residents/Vendors (display only).
  - Resident/vendor detail: recent transactions coloured green/red by admit/deny.
  - **Live relay control with Tracker:** shows relays 3-10 (Tracker 2) / 11-18 (Tracker 1); the command relay
    (2 / 1) is greyed out and the server refuses it. Switching relays 3-18 through DKS has **never been tried**
    against the gate.
  - **Delete stored gate data:** red button at the bottom of System Settings → `POST G/delete-data`
    `{ confirm: true }` → `deleteGateData()` (`gate-list.ts`): every user's gate-list entry, all DB rows keyed by
    the phone, and `media/<phone>/` (camera pictures). Nothing on the gate changes. Refused
    while a gate connection, snapshot run or scheduled transfer for that gate is running.
  - **User guide:** `MANUAL.md` rewritten for everyday users (no file paths/APIs), served at public `GET /help`
    by `src/markdown.ts` (small Markdown subset; all text HTML-escaped; only `#…` and http(s) links). Linked from
    the sign-in page, the gate list and the sidebar (**Help ↗**).
  - **"?" hover tips:** `web/ui/HelpTip.tsx` (`<HelpTip of="key" />`, also `help="key"` on `Field` in
    `panes/fields.tsx`) with texts in `web/ui/help.ts` (44 keys, all used). A key without a text renders nothing.
  - **Sidebar:** the job badge is full width, button height and centered, with **Show progress** under it.
    The sidebar picks one of three densities (`data-density` 0/1/2 on `.sidebar`, CSS variables `--nav-*` in
    `styles.css`) in a `useLayoutEffect` in `GateApp.tsx`: the roomiest whose menu fits without scrolling,
    rechecked every render and on resize. The menu still scrolls (thin bar) if even density 2 doesn't fit.

**Test suite:** `node --test` → **75 tests, all passing** (as of 2026-11-12; the database tests need the
`doorking_test` PostgreSQL database, see `DB.md`).

---

## 3. The binary format (reverse-engineered — the valuable part)

All offsets below are **confirmed by isolated before/after gate pulls** unless marked "inferred".
See §7 for the methodology. The decoders/encoders live in `src/board-files.ts` (parse) and
`src/residents-edit.ts` (write). Byte-exact tests in `test/residents-edit.test.ts` reproduce the
exact deltas observed from the gate.

### 3.1 names.bin — resident directory
- Directory starts at offset **`0xF80`** (`0xC00` in 10-area-code mode, see 3.4.2), **20 bytes per entry**,
  walked until the code pattern at bytes 16–19 stops matching. This sample has **131 entries**.
- Entry layout (20 bytes):
  | bytes | field | notes |
  |------|-------|-------|
  | 0–14 | **name** | 15 chars, space-padded (`0x20`) |
  | 15 | **flag** | bitfield (below) |
  | 16–19 | **directory code** | ASCII digits, right-justified, space padded (`" 701"` with 3 digits, see 3.4.3) — **joins to phone.bin & cards.bin** |
- **flag byte (15) bitfield:**
  - **bit 0 (`0x01`) = Vendor** (set) vs resident (clear)
  - **bit 5 (`0x20`) = Shown** in the entry-panel directory; **clearing it = Hidden**
  - Observed values: `0x20` = shown resident (98), `0x01` = vendor (12), `0x00` = empty slot OR
    hidden resident.
  - **Hidden resident vs empty slot:** both have flag `0x00`; the difference is a hidden resident
    still has a **name**, an empty slot has a **blank** name. (Verified: hiding Cody flipped `0x20→0x00`
    and kept the name.)

### 3.2 phone.bin — 10-byte records, keyed by directory code
| bytes | field | encoding |
|------|-------|----------|
| 0–1 | directory code | BCD, **leading-F padded** (e.g. `701` → `F7 01`) |
| 2 | area-code index | index into names.bin area-code table; `0xFF` = none (255 mode; see 3.4.2 for 10 mode) |
| 3–5 | phone number | 3-byte big-endian of the **7-digit local** number; `FF FF FF` = none (255 mode) |
| 6–7 | entry code | BCD, leading-F padded; `FF FF` = none |
| 8 | **packed**: security + elevator | **bits 0–4 = security level (0–30)**, **bits 5–7 = elevator ref (stored 0–7, shown +1)** |
| 9 | **floor** | plain number 1–64; `0xFF` = unset |

- Byte 8 examples: `0x01` = security 1 / elevator "1"; `0x21` = security 1 / elevator "2"
  (`0x21>>5 = 1`, displayed +1 = 2). Default/no-elevator shows as "1".
- Floor example: `0xFF → 0x05` = floor 5.
- **Phone storage splits area code and the 7-digit local number** (area code lives in the names.bin
  table, referenced by index). The UI shows one combined phone field and splits it only for storage.

### 3.3 cards.bin — 4-byte records
| bytes | field | encoding |
|------|-------|----------|
| 0–1 | card number | 16-bit big-endian |
| 2–3 | directory code | BCD, leading-F padded |
- All-`0xFF` record = free slot. Add = write into a free slot; remove = set the record to `0xFF`.
- 8000 slots = the manual's "maximum 8000 device codes"; device numbers 00001-65407.
- **Mass-enabled (unassigned) device numbers** (researched 2026-10-21 from the decompile, never seen on a gate):
  DoorKing32's Mass Enable (manual 3.7.3) turns on a From-To range (≤ 8000) with an optional security level
  00-31 (blank = 01) before any user has the device; Assign (manual 4.2) later gives one to a user and it takes
  the user's level. Each enabled number is written as **`<card BE16> AB <security level byte>`**
  (`FUN_004a9210`; `0xAB` marker in byte 2, binary level in byte 3) vs an assigned card's BCD directory code
  (`FUN_004a9300`). The ranges themselves (`CMassEnableRecord`: From, To, level) stay in DoorKing32's files.
  Ours: `parseCardsBin` reads an `AB` record as directory code `null` (counted in "cards without a directory
  code", level ignored); edits leave it untouched; adding that number to a resident is refused ("already
  assigned to directory code null") where DoorKing32 would re-own the record. The user decided (2026-10-21)
  **not** to build Mass Enable; direct assignment covers their use. Whether the gate admits an `AB` card at that
  level is unverified.
- The live gate has one record `3E 70 FF FF` (card 15984, directory code `FFFF`, not an `AB` record; never used
  in its transaction log; origin unknown).

### 3.4 Empty-slot format (what "deleted" looks like)
A vacant directory slot is **byte-identical** to this (verified against real empties):
- names entry: name = 15 spaces, flag = `0x00`, byte 16 = space, code kept at 17–19.
- phone record: code kept at 0–1, bytes 2–7 = `0xFF`, **byte 8 = `0x01`**, byte 9 = `0xFF`.
- cards: no records for that code.

`deleteResident()` writes exactly this. `addEntry()` reverses it (fills a vacant slot).

### 3.4.1 New and removed directory codes (mapped from DoorKing32 changes 21–23)
Snapshots: `BAK\ACCT0001_step21_before_newcode`, `BAK\ACCT0001_step21_new_555_zztest`, `BAK\ACCT0001_step23_deleted_500_mmtest`.
- **Directory order:** empty slots, then residents (shown or hidden), then vendors; each group by name,
  ignoring case (MMTEST went between `Mills, A` and `Moore, B`; ZZTEST after the last resident).
- **Add a new code:** the 20-byte entry is inserted at that position and later entries move down 20 bytes;
  the phone record (`code ff ff ff ff ff ff 01 ff`, then the entered fields) is inserted in code order and
  later records move down 10 bytes. `cards.bin` only changes if cards are given.
- **Delete (DoorKing32):** removes the entry and the phone record, later ones move up, the freed bytes at the
  end become `0xFF`. Adding then deleting a code restores every file byte for byte. `removeDirectoryCode()`.
- **`names.bin` `0xF8`–`0xFA`:** 3-byte BE offset of the middle shown entry (flag exactly `0x20`):
  shown entry number `(count − 1) / 2` (DoorKing32.exe.c:119433–119453). `updateMiddlePointer()` writes it
  whenever the directory region changes. Purpose confirmed by the user 2026-11-12: browsing the directory on the
  gate starts at this entry (the middle). The gate's own copy holds `0x141C`, which doesn't fit this formula,
  and has `0xFB` = `05` where DoorKing32 writes `01`; neither is explained yet.
- **`.MAP` files:** DoorKing32 recalculates the flags on save (removing MMTEST dropped its flags again),
  the same as `blockMap()` comparing the working copy with the base.
- `src/residents-edit.ts` reproduces changes 21–23 byte for byte against these snapshots.

### 3.4.2 Area-code modes: 255 vs 10 (mapped from DoorKing32 change 24)
Snapshot: `BAK\ACCT0001_step24_10_area_codes` (compared with step 23). The mode changes the file layout;
`namesLayout()` detects it from where the directory starts (else from the `names.bin` length).
| | 255 Area Codes | 10 Area Codes |
|--|--|--|
| `names.bin` size | 64000 (`NAMES.MAP` 500) | 63104, `0x380` shorter (`NAMES.MAP` 493) |
| area-code table | `0xA41`, 255 entries | `0x44`, 10 entries |
| directory | `0xF80` | `0xC00` |
| phone.bin bytes 2–5 | index byte + 3-byte BE number | index nibble (`F` = none) + 7 BCD digits |
- Example record 701: `f701 02 54b03e 4821…` (255) → `f701 2 5550142 4821…` (10).
- The middle pointer (`0xF8`) counts from `0xF80` in both modes (stored = real offset + `0x380` in 10 mode).
- Switching to 10: area codes no phone record uses are dropped, the rest keep their order and are renumbered;
  the old table is cleared to `FF`. The Anti-Pass Back block and the rest of the header are unchanged.
- `convertAreaCodeMode()` does this both ways. Applied after replaying the step 24 removals on step 23, it
  matches DoorKing32's `names.bin` and `phone.bin` byte for byte, and `blockMap()` matches its `NAMES.MAP`.
- Saving the `areaCodes` pref converts the working copy (`PUT /api/gates/<phone>/prefs`); `writeCacheFile()`/`prepareSend()`
  accept a `names.bin` that is `0x380` bytes shorter or longer than the base.

### 3.4.3 "Num of Digits in Dir Code" (mapped from DoorKing32 changes 26–27)
Snapshots: `BAK\ACCT0001_step25_before_dirdigits`, `BAK\ACCT0001_step26_4digit_cody1701`, `BAK\ACCT0001_step27_decreased_destroyed`.
- Stored at `names.bin` `0x40` (`01`–`04`; the DoorKing manual allows 1–4); `namesDirDigits()` reads it. No file
  changes size.
- Entry bytes 16–19 hold the code right-justified: `" 701"` (3), `"0701"` (4). phone.bin/cards.bin codes are
  BCD with leading-`F` padding: `F7 01` (3), `07 01` (4).
- **Increase (3 → 4):** every code gets leading zeros in all three files; order is unchanged.
- **Decrease (4 → 3):** all resident data is wiped: the area-code table, the middle pointer (`0xF8`–`0xFA`) and
  everything from the directory start in `names.bin`, and all of `phone.bin` and `cards.bin` become `0xFF`.
  The rest of the header is kept.
- `convertDirDigits()` does both. Step 25 → 4 matches step 26 except the 701 → 1701 edit; step 26 → 3
  matches step 27 byte for byte. 1- and 2-digit modes are not checked against DoorKing32 yet.
- `PUT /api/gates/<phone>/dir-digits` applies it to the working copy (decrease needs `confirm: true`).

### 3.5 Other names.bin regions (decoded earlier, see `board-files.ts` for exact offsets & tests)
- Settings header (master code, talk time, relay tones, entry-code range, scroll text). Talk time at `0x10` is one
  byte of seconds (DoorKing32 writes minutes × 60 + seconds); editable as m:ss, 0:00–4:14 (`0xFF` = unset).
- Entry-code ranges, one per relay (manual 3.1.4), From then To as 2-byte BCD, `FFFF` = unset: relay 0 at
  `0xAC`/`0xAE`, relay 1 at `0xB0`/`0xB2`, relay 2 at `0xB4`/`0xB6` (relays 0 and 2 confirmed 2026-10-20 by
  one-change diffs, `BAK\ACCT0001_tracker7/8`: 1234-5678 → `12 34 56 78`, 2345-6789 → `23 45 67 89`). The manual's
  glossary "divide number" is from older boards.
- Postal switch / rotary dial 9 ("which relays activate"): relay bitmasks at `0x41` / `0x42`, bit r = relay r
  (confirmed 2026-10-20: relay 0 postal on `02`→`03`, relay 0 rotary on `02`→`03`, with relay 1 already on in
  both; relay 2 = bit 2 inferred). DoorKing32 mirrors them in `ACCOUNT.DAT` (`0x127` relay 0 postal, `0x12A`
  relay 0 rotary). Field keys `relayPostalSwitch`, `relayRotaryDial9` (elevatorMask layout); checkboxes on the
  Relays page, locked for a Tracker command relay.
- LCD display lines at `0x190` (8×20: user message 1–4 + instructions 1–4).
- Area-code table at `0xA41` (`0x44` in 10 mode; 2-byte BCD entries, F-padded).
- Hold-open schedule at `0x6F` (8 rows × 5 bytes; times + day flags). Relay assignments at `0x5C`–`0x6E`:
  one byte per relay 0–18, bit *i* = row *i* (bit 7 = Holiday). Taken from DoorKing32's hold-open grid
  code (field keys `holdOpenRelay0`–`holdOpenRelay18`); confirmed for relay 5 row 1 (`0x61` = `01`,
  2026-10-21, `BAK\ACCT0001_trk_relays_3_18`).
- Security level time zones at `0x243` (levels 02–30 × 4 TZ × 16 bytes: begin/end, days, relays, floors).
  Relay 7 confirmed (L02 TZ1 relays `00 10 00`, same snapshot); Anti-Pass Back Relays In 12 = `0C` at `0xA05`.
  Hold Open, Security Levels and Anti-Pass Back show relays 0–2 plus the Tracker relays (3–10 / 11–18).
- Holidays at `0x9C3` (32 rows × 2 bytes, month/day packed decimal; **names are NOT on the gate** —
  we supply them from a fixed list in `src/holidays.ts`; DoorKing32 keeps its own names in `ACCOUNT.DAT`, e.g.
  "Alpha"/"Bravo"/"Charlie" at ~`0x1982`).
- "Holidays for Security Levels" at `0xA03`, right after the holidays: `00` = on, `FF` = off (confirmed 2026-10-20,
  `BAK\ACCT0001_hol1_holidays_for_sl`; DoorKing32 mirrors it at `ACCOUNT.DAT` `0x197E`). On makes TZ4 of every
  security level the Holiday time zone; DoorKing32 asks "are you sure" first, and so do we. Key `holidaysForSecurity`
  (group Holidays): a box on the Holidays page; the Security Levels page labels TZ4 "HOL" while it is on.
- Facility codes: enable flag at `0x32`, 10 codes at `0x1E` (16-bit BE each; valid codes 000–255 per the manual).
- Outside line digit ("Dial _ First, then Dial Phone Number") at `0x1D`: `0xFF` = none, else the digit
  `0x00`-`0x09` (confirmed with 9, 0 and blank). DoorKing32 refuses to send it to boards/phone systems
  that do not support it.
- Elevator Reference table (ER1–ER8, the resident's elevator reference): elevator bitmap at `0xC6` (8 bytes),
  floor-button time in seconds at `0x97` (8 bytes). Earlier labelled "relay N"; the manual's 8 rows with
  elevators + time match the ER table (4.3). Field keys stay `elevatorNElevators`/`elevatorNTime`.
- Relay / Elevator table (which relay 0–18 controls which elevator): one byte per relay, elevator e = bit (e−1).
  Relay 0 at `0xF7`; relays 1–18 at `0x230` + relay (`0x231`–`0x242`). `0x230` (`FF`) is not part of it.
  Confirmed for relays 0, 2 and 5 (2026-10-21, `BAK\ACCT0001_elev1_relay2_elev3`, `elev2_relay5_elev1`,
  `elev3_relay0_elev1`); DoorKing32 mirrors it in `ACCOUNT.DAT` ("ElevatorRecord", 19 bytes from `0x180E`).
  Keys `relay0Elevators`–`relay18Elevators` (group `Relay Elevator`); the Relay / Elevator page, under Elevator
  Reference, shows relays 0–2 plus the Tracker relays, and hides with the Elevators feature.
- Day-of-week flag convention: day d (0=Sun..6=Sat) is bit (7−d), i.e. bit7=Sun … bit1=Sat.
- Relay strike times (confirmed, non-obvious): relay0 @ `0x11`, relay1 @ `0x04`, relay2 @ `0x05`.
- **Anti-Pass Back only applies to security levels 02–27** (DoorKing manual 3.5/3.6): cards in levels 01, 28, 29
  and 30 are never limited by it. The Anti-Pass Back page says so; nothing checks residents' levels yet.
- Anti-Pass Back (block 20, confirmed by one-change diffs of DoorKing32's output; snapshots in
  `BAK/ACCT0001_step*`): mode `0xA04` (Off `FF`, Passive `01`, Active `02`, Trap `03`); Relays In
  `0xA05`–`0xA0E` / Out `0xA0F`–`0xA18` (up to 10 sorted relay numbers 0–18, `FF` = empty; DoorKing32
  has no cap, so an In list can run into Out — we cap at 10); Record Facility Counter Every `0xA19`
  (Off `FF`, 15 Mins `01`, 30 Mins `02`, Hour `03`); Reset Facility Counter to `0xA29` (16-bit BE,
  `FFFF` = empty); Re-Sync All Devices `0xA2B` and Enable Re-Sync List `0xA2C` (`00` = selected);
  Re-Sync List `0xA2D`–`0xA36` (5 × 16-bit BE, `0000` = empty box, all `FF` when the list is off);
  Enable Scheduled Re-Sync All `0xA37` (`00` = on); days `0xA38`–`0xA3E` (Sat→Sun, ticked = day number
  Sat `01` … Sun `07`, `FF` = unticked); time `0xA3F` (same format as hold-open times). `0xA1A`–`0xA28`
  never changed.

### 3.6 rcv_out.bin — transaction log (decoded in `board-files.ts`: `orderRcvOut`, `decodeRcvEvent`)
- **Circular buffer of 10,000 events × 10 bytes.** The newest event can be anywhere in the file. The
  **last 6 bytes** give the next slot to be written; `orderRcvOut` uses them to put events in time order.
  The gate stores no year. It is inferred by counting back from the pull date and stepping back one year
  whenever the dates go backwards.
- **Transaction history** (`src/tx-history.ts`, table `tx_history`): pulls always ask for the whole buffer (zero
  marker). `mergeTransactions()` finds the longest run at the end of the saved history that equals the start of
  the pull and adds the rest, keeping each event's year from when it was first saved. No overlap while history
  exists = `gap` (logged). The Transactions view and camera runs read only the history (`readTransactions()`); the
  pulled `rcv_out.bin` isn't stored, only its time (`tx_pulls`, the view's "downloaded" time). Until 2026-11-13 the
  last one was kept in `gate_files`; `migrateRcvOut` merged it at start (the live gate: 10,000 events, 0 new, 13,895
  saved) and deleted it.
- Event layout:
  | bytes | field |
  |------|-------|
  | 0, 1, 3 | month, day, minute |
  | 2 | hour + PM marker + Admit/Deny marker (3 = Admit, 2 = Deny) |
  | 4 | event type (`00` Directory, `01` Entry Code, `02` Card, `04` Open Request, `05`–`0C` system/hold, `0D`–`1D` modem/RS232 link events, `20`/`21` APB Re-Sync/Counter, `22`–`25` APB Okay/Violation IN/OUT) |
  | 5–6 | number: directory code, entry code or card, depending on type |
  | 7 | relay (`12` = relay 0, `00` = relay 1, `01` = relay 2; `FC`–`FF` = multiple relays); APB sub-type for `20`/`21` |
  | 8–9 | `FF FF` end marker |
- Checked against the desktop app's export `TRANS002.CSV` (since deleted): 7,999 of 7,999 shared
  events match on all six columns. Card numbers ≥ 65408 are gate status messages (only "Gate Close
  Edge Activated" is known).

### 3.7 DKS Cloud protocol notes (`dks-cloud.ts`, `gate-pull.ts`)
- **Pull:** `StartSessionSeries30` → `ReceiveResidentData` or `ReceiveTransactionData(marker)` →
  wait for the session → `GetDataFile` per file → `EndSession`.
- **Transactions marker:** we always send the 24-zero `ZERO_MARKER`, so every pull returns the full
  10,000-event history. DoorKing32 saves where it stopped reading and sends that position, so it only
  gets new events. That is not implemented.
- **Send:** `SendResidentData` uploads `names`/`phone`/`cards` `.bin` + `.map` as hex text (two hex
  digits per byte), with retries, then waits for the session. The session UserID embeds
  `{residents,vendors}` counts (DoorKing32 `FUN_004f7320`). We derive them from `names.bin` (vendor =
  flag bit 0) via `namesResidentCounts`, so **no RESIDENT.DAT is needed** (an earlier version read
  RESIDENT.DAT; that dependency was removed).
- **Relays:** `GetRelays`/`SetRelays` use UserID `user/cellular` for DKS Cellular, `user/client` for the
  other DKS types. The reply is 19 characters (relays 0–18): `0` off, `1` held, `2` unknown.
  `comType` is not in `gateConfig`; the server always uses the `'DKS Cellular'` default.

---

## 4. Architecture

```
<project root>/       the web app (moved up from JS/ on 2026-11-12)
  README.md           technical overview
  docs/               INSTALL, MANUAL (served at /help), API, DB, BITMAP, HANDOFF (.md)
  index.ts            re-exports every src/ module as one `dk` object
  cli.ts              command-line entry (archive/parse utilities)
  config.json         server settings incl. database password (template config.example.json)  <-- never commit
  doorking.key        AES-256-GCM key, next to config.json  <-- never commit or share
  src/
    board-files.ts    parse names/phone/cards/rcv_out .bin  (+ all names.bin regions)
    residents-edit.ts  WRITE path: applyResidentEdit / deleteResident / removeDirectoryCode / addEntry / emptySlots
    gate-settings.ts  editable FIELDS (typed decode/encode) for the settings editors
    gate-cache.ts     the gate's files in gate_files (base, encrypted); applyPull (rebase, conflicts); reset/send/verify
    gate-state.ts     gate_residents/gate_cards/gate_settings from each pull; checkRoundTrip, saveGateState
    gate-pull.ts      buildSessionRequest, pullFromGate, pushToGate, controlRelays, checkRelays
    dks-cloud.ts      SOAP client (CheckLogin, GetRelays, SetRelays, SendResidentData,
                      ReceiveResidentData, StartSessionSeries30)
    config.ts         loadConfig (config.json < env < flags, validated), connectionSettings, maskedConfig
    db.ts             openStore({ connection, keyFile, schema?, poolSize? }) -> Store { db, key }, encrypt/decrypt
    prefs.ts          phone-keyed prefs (getPrefs/setPrefs(store, phone, ...))
    notes.ts          resident/vendor notes per gate + directory code without leading zeros (getNotes/getNote/setNote, noteKey)
    tx-history.ts     transaction history (mergeTransactions/readTransactions/txHistoryCount), table tx_history
    gate-list.ts      user-keyed gate list (listGates/findGate/addGate/removeGate(store, user, ...)), markGateVerified,
                  gateClaimed, backfillGateVerified
    audit.ts          history per gate (addEvent/listHistory/readHistory(store, phone, ...)), recordSignIn/signIns(store),
                      diffBuffers/undoPatch for Revert of entries before 2026-11-12 (newer ones: gate-state.ts
                      diffStates/undoValues)
    schedules.ts      scheduled transfers (saveSchedule/listSchedules/scheduleIsDue/lastDue/nextDue) and saved
                      DKS passwords (saveCredential/getCredential/forgetCredential)
    cameras.ts        per-gate camera settings (save/get/deleteCameraSettings, password encrypted), snapshot log
                      (listSnapshots/recordSnapshot/pendingMinutes), createCameraRunner (dahua-p2p bridge + ffmpeg),
                      runSnapshots/liveSnapshots, refreshSnapshot (one frame again, refresh button); video mode
                      (mode 'video': grabClip -> runner.grabFrame video + clipSeconds + finishClip); live view
                      (runner.liveStream: /cam/realmonitor re-encoded by ffmpeg to MJPEG, 8 fps, up to 960 wide)
    debug-log.ts      createDebugLog(file, { enabled }) -> write(area, message)/read/info; debugLogEnabled/
                      setDebugLogEnabled(store) (meta key debugLogs)
    markdown.ts       markdownToHtml/inline/helpPage: renders MANUAL.md for GET /help (all text escaped)
    holidays.ts       FIXED_HOLIDAYS + name lookups
    transactions.ts   rcv_out.bin transaction decoding
    carchive.ts       archive helpers
  web/
    server.ts         Node http server (no framework); routes listed below
    data.ts           reads the .bin working copy into UI-shaped data (residents/transactions/etc.)
    ui/               web page (React + Radix Themes), built by Vite into web/dist and served at /
      App.tsx         sign-in -> gate list (Gates.tsx) -> open gate (GateApp.tsx: sidebar, pulls, JobDock.tsx)
      api.ts          api()/gateApi() fetch helpers, 401 -> back to sign-in; localStorage helpers
      styles.css      layout Radix doesn't cover (sidebar + its densities, "?" tips, camera tiles, live window, time and
                      message boxes)
      HelpTip.tsx, help.ts  "?" hover tips and their texts
      format.ts, table.tsx  cell formatting, transaction colours, resident lookup, CSV, sortable headers
      panes/          Transactions, Directory (Residents/Vendors + WorkingCopyBar), ResidentForm (edit/add),
                      fields.tsx (PhoneField, CardsEditor, CardList), History, Schedules
      settings/       useGateSettings.ts (GET/PUT G/settings with unsaved edits), SettingsBar.tsx (Save/Discard/Reset/
                      Send, SettingInput), GateSettingsEditor.tsx (prefs/relays/display views), SystemSettings.tsx
                      (GateConfig, LocalPrefs: device association, CameraForm, debug logs, appearance, Delete stored
                      gate data),
                      RelaysDisplay.tsx (Relays page with live relay control, Display page), GroupPage.tsx
                      (Save/Discard page for one settings group, row colours), SchedulePages.tsx (Hold Open,
                      Elevator, Security Levels), ListPages.tsx (Holidays, Facility Codes), ApbPage.tsx
      camera/         snapshots.ts (useSnapshots: log, run polling, refresh), SnapViews.tsx (SnapCell,
                      SnapViewer), LiveView.tsx (top-right camera button + MJPEG window)
  test/               node --test suites (board-files, gate-cache, relay-control, residents-edit)
  media/              per-gate camera pictures and videos (DOWNLOADED/ until 2026-11-13)  <-- private
  research/           DoorKing32.exe.c / .h (decompiled desktop app), the 1835 manual PDF
  tools/              bundled camera tooling, run by src/cameras.ts
    bin/              picked by process.platform + process.arch (bridgeExe/ffmpegExe):
                      Windows: dahua-p2p-x64.exe, dahua-p2p-arm64.exe, ffmpeg.exe (9.0.2 x64 gyan.dev, also
                      runs on Windows ARM via emulation)
                      Linux: dahua-p2p-linux-x64, dahua-p2p-linux-arm64, ffmpeg-linux-x64, ffmpeg-linux-arm64
                      (BtbN n9.0 gpl builds; need glibc, not Alpine/musl). The execute bit is added at first use
                      when missing.
    licenses/         dahua-p2p (MIT) and ffmpeg (GPLv3) license files (ffmpeg-linux-LICENSE.txt for the Linux
                      builds); keep them with the binaries
```

### 4.1 HTTP routes (`web/server.ts`)
REST routes, defined in the `ROUTES` table with `route(method, pattern, scope, handler)`. `G` = `/api/gates/:phone`.
Full request/response details are in `README.md`.
```
GET    /help                        public; MANUAL.md as an HTML page
GET    /api/session                 { loggedIn, setup?, user, email, dark, mustChangePassword, gate | null, defaults, holidayList }
POST   /api/session                 { user, password }  local account; sets sid cookie
DELETE /api/session                 sign out
POST   /api/setup                   { setupCode, username, password, email? }  first account only
GET    /api/me, PUT /api/me         own settings { email, dark }; PUT /api/me/password { current, password }
PUT    /api/session/gate            { phoneNumber }  the gate the web UI has open (restored on reload)
DELETE /api/session/gate            back to the gate list
GET    /api/gates                   the user's gates { phoneNumber, siteName, addedAt, role }
POST   /api/gates                   { phoneNumber, masterCode, dksUser, dksPassword, gateConfig }  add (202; check pull)
GET    /api/gate-add                { job } of the user's gate-add check
GET    G                            one gate
DELETE G                            leave the gate (not for its last admin)
GET/PUT G/login                     the gate's DKS login / master code (admins)
GET/POST G/users, POST G/share, PUT/DELETE G/users/:username   gate users and roles (admins)
GET/POST G/api-keys, DELETE G/api-keys/:id   per-gate API keys (admins; key shown once on POST)
GET    /api/openapi.json, /api/docs  OpenAPI 3.1 of the API-key routes (docs/openapi.json) + Swagger UI (public)
POST   G/delete-data                { confirm: true }  delete everything stored about the gate (all users' lists, DB rows,
                                    media/<phone>/); 409 while a job/snapshot run/schedule for it runs
GET    G/job                        this gate's pull/send job; another gate's job shows idle + busyElsewhere
POST   G/pull                       { what: 'residents' | 'transactions' }  202 (gate config read from prefs)
GET    G/send                       send preview: changed blocks + resident counts
POST   G/send                       { confirm: true }  202; push working copy, then verify-pull (400 while duplicates exist)
GET    G/data                       { transactions }, names from the working-copy values (other views removed 2026-11-12)
GET    G/residents                  residents/vendors from the WORKING COPY + areaCodes + emptyCodes + cache
POST   G/residents                  entry: fill a vacant unit code or insert a new code (201)
GET    G/residents/:code            one row
PUT    G/residents/:code            edit fields (only given fields change)
PUT    G/residents/:code/note       { note } local note (max 500, blank clears); history action 'note', not revertible
DELETE G/residents/:code            blank the slot (code stays as an empty unit); also clears the note
DELETE G/directory-codes/:code      take the code off the gate (§3.4.1); also clears the note
PUT    G/dir-digits                 { digits: 1-4, confirm? }  change "Num of Digits in Dir Code" (§3.4.3)
GET    G/settings                   settings table (working copy) with per-field gate value
PUT    G/settings                   { <field key>: value, ... }
GET    G/working-copy               cache status
DELETE G/working-copy               working copy := last pull
GET    G/files/:name                working-copy .bin/.map download (from gate_files; .map computed)
GET    G/prefs                      gate-scoped prefs (relayLabels, deviceAssociation, gateConfig, features, tracker)
PUT    G/prefs                      { relayLabels? ('0'-'18'), deviceAssociation?, gateConfig?, features? { floors, elevators },
                                      tracker? { enabled, tracker1, tracker2 } }
                                    features/tracker: page-only switches; not sent to DKS Cloud
GET    G/relays                     GetRelays (read current state)
PUT    G/relays                     { '0'|'1'|'2': boolean }  SetRelays (changes the gate!)
GET    G/history                    { events (newest first, no patches), signIns }
POST   G/history/:id/revert         undo one change in the working copy/prefs (409 if a later change overlaps)
GET    G/schedules                  { schedules (with nextRun, last result, queued), passwordSaved }
POST   G/schedules                  { days, time, actions, enabled }  201; saves the user's password (encrypted)
PUT    G/schedules/:id              replace; the saver becomes the owner
DELETE G/schedules/:id              delete
POST   G/schedules/:id/run          queue now (409 if already queued)
GET    G/cameras                    { settings } (no password) or { settings: null }
PUT    G/cameras                    { serial, username, password?, channels, clockOffset, mode, frames, framesAfter,
                                    events, backfillHours, keepDays, enabled }  blank password keeps the saved one; logged as
                                    history; a keepDays change runs tidySnapshots (README "Clean-up")
                                    action 'camera'
DELETE G/cameras                    remove the settings (snapshots kept)
POST   G/cameras/test               live frame per channel -> snapshots/live/ch<N>.jpg
GET    G/cameras/live/:channel      live view as multipart/x-mixed-replace MJPEG for an <img> (camera button, top right ->
                                    "View Camera" window); ?quality=high = main stream, else sub stream; ends when the
                                    browser drops it, after 15 min (LIVE_MAX_MS), or the UI pauses it after 10 min;
                                    502 { error } when no picture came (tested 2026-10-20: first picture ~8 s)
GET    G/snapshots                  { snapshots: { <YYYYMMDD-HHMM>: { status, files, error, attempts } }, run }
POST   G/snapshots/run              202; snapshot pending transaction minutes now; { minute } = only that
                                    minute (runSnapshots minute option, Get pictures / Get video button; 409 during a run)
DELETE G/snapshots                  delete every picture and the snapshot log -> { minutes, files } (409 during a run)
GET    G/snapshots/:minute/:file    JPEG, or MP4 via sendVideo (Range requests) (names validated by snapshotFile)
POST   G/snapshots/:minute/:file/refresh  fetch one frame again (dk.refreshSnapshot, queued per gate in
                                    snapRefreshes) -> { snapshot }; 502 no picture, 409 during a run
GET    /api/debug-log               { enabled, file, size }  (whole server)
PUT    /api/debug-log               { enabled }  turn Debug logs on/off
GET    /api/debug-log/file          debug.log as text/plain
```
Debug log: `DEBUG` in server.ts writes to `<--logs>/debug.log` while on: camera runner bridge starts,
connections, exits, idle stops and connection failures, live views (opened, first picture, retried, ended),
snapshot runs (started, result) and `runSnapshots` frame retries/failures, every gate job line (`startJob`'s
`log`, consecutive repeats skipped) and its result, relay changes, schedule entries (started, result),
sign-ins/sign-outs, server start, uncaught errors (`uncaughtExceptionMonitor`), and every request answered
with `{ error }`. `DEBUG.write` checks the Debug logs setting on each call, so nothing is written while it is off.
Snapshots: `startPull()` calls `queueSnapshots(phone, dir)` after a successful transactions pull (manual or
scheduled). It runs `dk.runSnapshots()` in the background (one run per gate, `snapRuns`; a request during a run
repeats it afterwards) and does not hold the gate connection `job`. One `CAMERAS` runner is shared; its bridges
are stopped on server exit.
Scheduler: `checkSchedules()` runs at startup and every 30 s; a due entry gets `lastDue` set and is queued
(`queueSchedule`). `runScheduleQueue()` runs entries one by one; `runSchedule()` waits for `job` to be idle
before each transfer and calls `startSend`/`startPull` with `{ scheduled: true }` (they return a promise of the
finished job). The `snapshots` action skips the `job` wait and calls `scheduledSnapshots()`: it waits for a
snapshot run started since the entry began (the one its transactions pull queued), else `queueSnapshots()`
(which returns a promise of the finished run). Saving an entry sets `lastDue` to now, so it waits for its next time.
History: every working-copy route runs through `withHistory()` / `logChange()`, which compare the working copy
before and after and store the change as values (`values`: `dk.diffStates` of the decoded working copies) plus
field-level `details`. `revertEvent()` applies `dk.undoValues()`, which refuses if any changed value no longer holds
its "after" value, builds the files and saves them through `writeCacheFiles` (the usual rebuild check). Entries from
before 2026-11-12 carry byte patches (`files`, `diffBuffers`) and are still reverted with `undoPatch()`. Prefs changes store
`{ before, after }` per key. Pulls/sends are logged from `startJob()`, relay changes from `PUT G/relays`,
sign-ins from `POST /api/session` (into the `sign_ins` table).
POST/PUT require `Content-Type: application/json` (415 otherwise; the client's `api()` sets it for every
non-GET). Non-GET requests with a foreign `Origin` get 403. Everything except `/api/session` needs a valid
session cookie (401). Gate routes look the gate up in the user's list on every request (404 if absent), so
API clients don't need `/api/session/gate`. Unknown method on a known path: 405 with `Allow`. Handler errors
return `e.status || 400`. One gate connection (pull/send) runs at a time across all gates (409 otherwise).
The web UI calls gate routes through `gateApi(phone)` in `web/ui/api.ts` (`gapi(method, sub, body)` in components).

### 4.2 Working-copy model (`gate-cache.ts` + `gate-state.ts`; files on disk until 2026-11-12)
Per gate and file, rows in `gate_files` (data encrypted with `encryptBytes`):
- `base` — the latest residents pull: what the gate holds (`rcv_out.bin` isn't kept since 2026-11-13; §3.6). Until
  2026-11-13 a newer pull waited as `pulled` until Reset to gate; now each pull becomes the base at once.
- The **working copy is values** (phase 3, 2026-11-12): `gate_residents`, `gate_cards`, `gate_settings`,
  `gate_working` (digits, area-code layout and table, middle pointer, `base_ok`). `loadCopies` builds the working
  files with `buildFiles(base, values)` on every read; `writeCacheFiles` decodes the new files (`decodeWorking`),
  rebuilds, and saves the values only if the rebuild is byte-identical (else 409, nothing saved; 409 too while
  `base_ok` is false). `resetCache` = values := decode(base) (unsent changes and conflicts dropped). `applyPull` (each
  residents pull, 2026-11-13): base := pull; with unsent changes, `rebasePlan` diffs old base → working copy per item
  (resident by code, card by slot, editable setting) and puts the changes on the pull's values; both sides changed
  differently = conflict (`gate_working.conflicts`, working copy's value kept; Keep mine / Take the gate's via
  `resolveConflict`; sends refused meanwhile); `buildRebase` builds all at once, else one at a time and reports those
  the files can't take; a digits / area-code-mode change on either side (user's choice: take the gate's) or a pull
  failing the round-trip check drops the changes. Phone record positions are applied as an order (like the
  directory's), so a code removed at the gate doesn't leave a gap. After a send, a matching check pull replaces the
  base and working copy (`replaceBase`); a mismatching one is applied like any pull.
  `migrateWorkingFiles` converted the old `working` file copies once (verified, then deleted).
- The `.map` (one byte per 128-byte block, 1 = block differs from base: what a send uploads) is computed by
  `blockMap(base, built working)`; `cacheFileData` builds it for the download route.
- `buildFiles` order matters and was tested on the live gate's files with every edit type in sequence (rename,
  phone/entry/level/floor, hide, new area code, cards, fill a vacant code, add after a rename, vendor, delete,
  remove code, settings incl. clearing days, 255↔10 area codes, digits 3→4 and 4→3): all byte-identical. Two things
  had to be stored rather than derived: the directory order (an add's position depends on the names at the time
  it was added, so entries are put back in `entry_offset` order) and the area-code table + middle pointer (a digit
  decrease wipes them). History stores each change as values and reverts them (§4.1).
- **Rebuild from values alone (2026-11-13):** a build from blank files (`buildFromValues`) on the live gate first
  differed in the master code (not in the values tables), the 17 bytes of read-only settings (`buildFiles` wrote only
  editable ones), `0x37`/`0x43`, and 11 directory codes with a blank name (deleted slots; `addEntry` refuses blank
  names). Now: read-only settings are written back from their stored values (their encoders take every decoded
  value back, `? (...)` included); undecoded non-blank bytes before the directory are stored (`gate_working.extra`)
  and written back; a blank-named code is added as an empty slot (`addStoredEntry`); phone records are put at their
  stored `record_offset`; the file sizes are stored (`gate_working.sizes`). Every build (working copy, saves, sends,
  the rebuild) writes the master code saved with the gate login (`managed_gates`), not the pulled bytes; a gate whose
  file holds a different code shows block 0 as changed, and a send writes the saved code, as DoorKing32 always does.
  Digit 0 is `00`: DoorKing32's send builders write character − `'0'` and its receive check (`FUN_0045b490`, firmware
  byte below `0x50`; newer boards send `AAAA`) compares the same way; BITMAP's earlier `0A` had no source. No gate
  with a 0 in its code has been pulled yet to confirm it. `checkPull` runs `checkRebuild` on every pull
  (`gate_state.rebuild_ok`, not locking): the live gate rebuilds byte for byte. The base copy stays: sends upload only
  the blocks that differ from it.

Edit flow: `ensureCache` → `writeCacheFile` → `prepareSend`/`verifySend` (all async, `(store, phone, …)`). The server
awaits `prepareGateSend` (duplicates, `prepareSend`, resident counts) before its synchronous busy check, so a send
still claims the one connection without a gap; the scheduler re-checks after preparing.
After each residents pull and each send's check pull, `recordGateState` → `saveGateState` (`gate-state.ts`) fills
`gate_residents` / `gate_cards` / `gate_settings` from the pull and runs `checkRoundTrip`; the result goes to
`gate_state` and the job log. First run on the live gate (2026-11-12): passed (127 directory codes, 242 cards,
747 settings) after one fix: day masks decoded `FF` (not set) as `0000000` and wrote it back as `00`; they now
decode to `''` and keep `FF` (Hold Open **Clear** writes `''` too). On a blank file the Security Levels relay and
floor masks also turn `FF` into `00`; real gates hold `00` there, so those encoders were left alone.
A residents pull updates the working copy at once, with unsent changes kept on top (`applyPull`, above).

---

## 5. How to run

- **Node v24** and **PostgreSQL** (set up per `INSTALL.md` §2a). The server's one runtime npm package is `pg`.
- Moving to TypeScript + React + Radix Themes (`@radix-ui/themes`), built with Vite. Phase 0 (done): `package.json`
  (scripts `start`, `dev`, `build`, `typecheck`, `test`), `tsconfig.json` (server: `module nodenext`,
  `erasableSyntaxOnly`, `noEmit`, `allowJs` with `checkJs` off), `web/ui/` (Vite config, `tsconfig.json`, a
  placeholder page inside `<Theme>`), and `src/types.ts` (shared API shapes). `npm install` is needed for
  `dev`/`build`/`typecheck`. Phase 1 (done) converted the server to TypeScript, run directly by Node 24 (type
  stripping; `package.json` is `"type": "module"`): every file in `src/`, `web/server.ts`, `web/data.ts`,
  `cli.ts`, `index.ts` and the tests. Imports name the `.ts` file (`allowImportingTsExtensions`). `npm run
  typecheck` covers `src/`, `web/*.ts` and the root `.ts` files; the tests (`test/*.test.ts`) run but are not
  type-checked yet (about 300 errors under `strict`, mostly untyped helper parameters and partial fakes).
  Phase 2 (done) rebuilt the web page in React + Radix Themes (`web/ui/`, built into `web/dist/`, served at
  `/`) with every page of the earlier vanilla-JS page. Phase 3 (done, checked by the user against the real gate)
  removed that page (`web/public/`, `/legacy`, `/app.js`, `/style.css`); `/` now answers 503 "not built" until
  `npm run build` has run. After UI changes run `npm run build` (the server needs no restart). An open page
  compares its hashed script (`/assets/index-<hash>.js`) with the one `/` serves every 60 s and on tab focus, and
  shows a Reload notice when they differ (`web/ui/UpdateNotice.tsx`; not under `npm run dev`). Earlier, the
  browser kept showing an older build until Ctrl+Shift+R. Notes on the page:
  - The sidebar menu scrolls; History, Scheduled Transfers, System Settings, Gate connection and the user area
    are pinned at the bottom. Menu items have fixed height/padding (`.rt-Button.nav-item` in `styles.css`)
    because Radix ghost buttons are smaller with negative margins.
  - Unsaved gate-setting edits are kept per page. The Relays page reads the relays when it opens.
  - Text settings carry `maxLength` from `src/gate-settings.ts` (System message 27, System instruction 52,
    8-line messages 20); their boxes measure the text in the browser and add spare room (`useFitWidth` in
    `SettingsBar.tsx`). Time boxes on Hold Open/Security/Anti-Pass Back are plain `<input type="time">`.
  - Hold Open, Holidays, Facility Codes, Elevator and Anti-Pass Back have Clear (fills unset values as
    unsaved edits). Working-copy file downloads are in System Settings → Working copy files.
  - The server's CSP allows inline styles (`style-src 'self' 'unsafe-inline'`) for the `<style>` element
    Radix dialogs add; scripts stay `'self'` only.
- Start the server (from the project root):
  ```
  node web/server.ts
  ```
  - Settings come from `config.json` (`src/config.ts`; INSTALL.md §4 lists them; `--check-config` prints them).
    `paths.media` (default `media/` next to `config.json`) holds one folder per gate (digits of the system phone),
    only for camera pictures (`snapshots/`); pulls and the working copy are in the database. Open
    `http://localhost:8080`.
  - 2026-11-13: `DB/` (postgres.url, pgpass, key) was replaced by `config.json` + `doorking.key`, `DOWNLOADED/`
    renamed `media/`, and `--dir`, `--db`, `--prefs`, `--gates` and `importJson` removed. psql uses `~/.pgpass`.
  - Historically the server was pointed at the desktop app's folder
    `C:\Users\Public\Documents\DoorKing\DoorKing Account Manager\ACCT0001` for decode comparisons —
    **we moved off that** on 2026-10-13. Don't run the web app
    and the desktop app against the same folder simultaneously.
- `server.publicHost` (or `--public-host` / `PUBLIC_HOST`, added 2026-11-12): the name an HTTPS reverse proxy serves; adds it to
  `ALLOWED_HOSTS`, `https://<name>` to `ALLOWED_ORIGINS`, and `Secure` to the `sid` cookie for requests with that
  Host (`cookieAttrs`). The server still binds `127.0.0.1` only.
- Flags that still override `config.json`: `--config`, `--port`, `--public-host`, `--media`, `--logs` and the
  gate-match defaults `--site-name`, `--memory`, `--area-codes`, `--anti-passback`, `--interface-1816`, `--model`. The earlier sessions always started
  the server with `--anti-passback Y`. The command above omits it, which is how the default `'N'` leaked
  into pulls (see §6).
- Sign-in sessions are in the database (since 2026-11-13), so a restart keeps everyone signed in. After code
  changes, restart the server and hard-reload the browser (Ctrl+F5). A stale server still holding port 8080 was a
  recurring cause of "my change isn't showing".
- CLI: `node cli.ts` (no args prints usage). Local read-only parsers (`board`, `phones`, `cards`,
  `directory`, `rcvout`, `transactions`) and `cloud-*` commands that read credentials from the
  `DKS_USER` / `DKS_PASSWORD` / `DKS_URL` environment variables.
- Tests: `node --test` (from the project root).
- Rebuild the bridge (needs Go): the binaries are upstream `github.com/blackjid/dahua-p2p` at commit `345f724`,
  unmodified (verified 2026-11-13; the vendored copy in `tools/dahua-p2p/` differed only in line endings and was
  removed). `git clone https://github.com/blackjid/dahua-p2p && cd dahua-p2p && git checkout 345f724`, set
  `GOOS=windows`, `CGO_ENABLED=0`, `GOARCH=amd64` or `arm64`, then
  `go build -trimpath -ldflags "-s -w" -o <root>\tools\bin\dahua-p2p-<x64|arm64>.exe ./cmd/dahua-p2p`.
  For Linux set `GOOS=linux` and use `-o <root>/tools/bin/dahua-p2p-linux-<x64|arm64>`.
- Linux ffmpeg: `ffmpeg-n9.0-latest-<linux64|linuxarm64>-gpl-9.0.tar.xz` from
  github.com/BtbN/FFmpeg-Builds releases; copy `bin/ffmpeg` to `tools/bin/ffmpeg-linux-<x64|arm64>`.
- Verified 2026-10-19 under WSL Ubuntu (arm64, Node 22): the arm64 Linux binaries start and the test suite
  passes. The x64 Linux builds were not run (no x64 Linux available).
- Python (for byte-diffing samples) is invoked as **`py`** (the `python3` alias is a Windows Store
  stub on this machine). Run untrusted/sample-reading scripts with `py -I`.

---

## 6. Preferences (System Settings page) & gate config (important nuance)
Prefs (the database's `prefs` table, formerly `prefs.json`) are keyed by the **gate system phone number** (digits only), so every account that manages
the same physical gate shares: `relayLabels` (relay 0/1/2), `deviceAssociation` and `gateConfig` (site name,
memory size, area codes, model, **antiPassBack**, interface 1816/1820). Pulls and sends read `gateConfig` from
here automatically — the client no longer sends gate settings per request.

`deviceAssociation` mirrors DoorKing32's "Dev Enable" window (`CDeviceRecord` in `ACCOUNT.DAT`, never sent to
the gate — verified: editing it leaves every board file byte-identical). Up to 10 rows `{ name, from, to }`:
name ≤ 12 chars, device codes 00001–65407 stored as 5 digits (DoorKing manual 3.7.2; earlier 9 chars and
0–65405), no overlapping ranges. Validated by `normalizeDeviceAssociation()` in `src/prefs.ts`; default is one row
`Cards / 00001 / 65407`. A saved row starting at `00000` must be changed to `00001` before it saves again. New
cards on a resident are also limited to 00001–65407 (`applyCards()`, `CardsEditor`).
A card transaction's **Event Type** is the name of the first row whose range holds the card number, blank when
none does (DoorKing32 `FUN_0049bba0`, used by the transaction decoder's card case). `decodeRcvEvent()` still
returns `'Cards'`; `web/data.ts` swaps in `deviceNameFor()` and passes `lookup` to the client.

The 6 `gateConfig` keys are exactly: `siteName`, `memorySize`, `areaCodes`, `modelNumber`,
`antiPassBack`, `interface1816` (defined as `GATE_CONFIG_KEYS` in `web/server.ts`). Note
`GATE_DEFAULTS` (`src/gate-pull.ts:28`) also has a 7th key `dialDelay` that is **not** part of
`gateConfig` — it only ever comes from the defaults.

`interface1816` is **not in the board files**: toggling DoorKing32's "Interface with 1816/1820" (off → on) changed
only `ACCOUNT.DAT` `0x31F` (`00` → `01`); `names.bin`, `phone.bin`, `cards.bin`, `NAMES.MAP` and `RESIDENT.DAT`
stayed byte-identical (2026-10-21, `BAK\ACCT0001_if1816_toggle`). Like DoorKing32, we only pass it as the
`Interface1816` session parameter, so the saved Gate configuration must match the gate. In DoorKing32's code the
flag (per-account byte array at document `+0x770`) is read in only two places that do anything: the cloud
session builder `FUN_004634b0` (`"Y"`/`"N"`, built right before AntiPassBack and the model string, then passed
to `StartSessionSeries30`), and modem dialing (~line 36172 of `DoorKing32.exe.c`), which adds `#2` plus 8 pause
commas to the dial string before `*13`. The other reads are the account load/save, the settings dialog and
the printed report.

> **Gotcha fixed on 2026-10-13:** a stale server process + unsaved `gateConfig` caused an
> "Anti-Passback Mismatch" on pull (it fell back to the default `antiPassBack`). This gate runs
> **antiPassBack = Y**.
>
> **Decided 2026-10-14:** the code default stays `antiPassBack: 'N'` (`src/gate-pull.ts:33`). This gate's
> `Y` is set in **System Settings → Gate configuration** (saved in the gate's prefs under its phone number
> and used automatically by every pull/send). Do not change the default. Starting the server with
> `--anti-passback Y` also works but isn't needed.
>
> Precedence (`sessionRequest` in `web/server.ts`): `GATE_DEFAULTS` < CLI flags < non-empty
> prefs `gateConfig` values.
>
> **Checked 2026-10-21:** the `areaCodes` default stays `'255 Area Codes'`. The 6.2 manual said the gate's
> default is 10, but the 6.5 manual (`DKHelp65.pdf`, the version our sessions identify as) says 255 in 1.2.12
> and 3.1.2. A gate with a different setting needs it saved in its Gate configuration.


---

## 7. Reverse-engineering methodology (how we decoded fields)
This is how every field in §3 was confirmed and how to decode the rest:
1. Snapshot a baseline of `names.bin` / `phone.bin` / `cards.bin` (keep a copy).
2. In the DoorKing app/gate, change **exactly one thing** for one known record.
3. Pull again and **byte-diff** against the baseline (a tiny Python script; see session history).
4. The changed byte(s) reveal the field. Change one field at a time to avoid entangling bits
   (we learned this the hard way: a combined hide+floor+elevator change was ambiguous; isolating each
   gave clean single-byte deltas).
5. Encode the field, then add a test that reproduces the exact observed delta
   (`test/residents-edit.test.ts` does this for hide/elevator/floor/security/cards).

**Working style:** the user changes one setting at a time in the DoorKing32 desktop app, saves or pulls,
and asks for the diff. They sometimes revert earlier changes without saying so, so check every changed
byte, not only the one expected.

### 7.1 Reverse-engineering resources in `research/`
- The `BAK\ACCT0001_*` snapshots of DoorKing32's files cited in §3 and §8 (one-change diffs) were deleted on
  2026-11-12; the findings they back are recorded here and in byte-exact tests.
- `research/DoorKing32.exe.c` / `.h`: decompiled DoorKing32 (Ghidra-style `FUN_xxxxxxxx` names). Useful functions:
  `FUN_004aad40` / `FUN_004b0020` (build `names.bin` for a send in 10 / 255 area-code mode, effectively a map of
  the settings area; `param_1[0x99]` is the file's first byte), `FUN_0050e9d0` (printed settings report: labels
  for account fields), `FUN_0045b490` (receive checks: master code, download stamp, memory chips),
  `FUN_004f7320` (send resident counts), `FUN_0046a0b0` (`ReceiveTransactionData` wrapper). The
  transaction event decoder is `FUN_0053ebd0` (line ~223220; reads record bytes 0–7 only). Mass Enable / cards (2026-10-21): `FUN_0047cfb0` (apply an
  enabled range), `FUN_004a9660` (loop over enabled numbers 0-65405) → `FUN_004a9210` (unassigned `AB` record),
  `FUN_004a9300` (assigned record), Enable dialog checks around line 92460-92880.
- `1835-066-K-4-10_V6-2c.pdf`: the DoorKing 1835 manual (79 pages). No PDF library is installed here
  (checked 2026-11-13); decompressing its content streams with Python's `zlib` and joining the text in `( )` gives
  searchable text (section 3.1 describes the System Information screen).
- Deleted on 2026-10-16: `DkWebService.xml` (DKS Cloud WSDL), `export/` (including `ACCOUNT.txt`, the
  `ACCOUNT.DAT` field map), `TRANS002.CSV`, `BAK/` snapshots, and the root copies of the desktop app's
  `*.bin`/`*.DAT`/`*.MAP`/`*.TRA` files. Known `ACCOUNT.DAT` offsets from that map: anti-pass back re-sync all
  devices `0x19EB`, True APB mode `0x19EC` (0 Off, 1 Passive; Active/Trap assumed 2/3), facility counter
  `0x19F7`, IN/OUT relay tables `0x1A02`/`0x1A17` (19 bytes each, IN/OUT order assumed).
- **Unknown `names.bin` ranges, 2026-11-13:** anchored on offsets pull diffs had confirmed (master code `0x00`,
  strike times `0x04`/`0x05`/`0x11`, postal/rotary `0x41`/`0x42`), the two send builders write file offsets
  directly. Results (BITMAP.md), each checked against the 2026-11-13 pull:
  - **Read-only settings** (`src/gate-settings.ts`, System group): `0x06` Multiple Systems and `0x0F` Dial Type
    (`01` on/Rotary, `0A` off/Tone; DoorKing32 writes `(flag ? 0xF7 : 0) + 10`); `0x15`/`0x19` two little-endian
    Unix times, the last-download stamp (receive: "Changed to Send All Data because another PC has downloaded to
    this System"); `0xBF`–`0xC4` end addresses `0xF80 + memory × 20` and `0x10D80 + memory × 10` (document `+0x180`
    is the system memory; the gate's `0xF9E0`/`0x182B0` = 3000); `0xFB` memory chips (receive check on block 1, byte
    `0x7B`: `00` standard, `01` MemPLUS, `05` anti-pass back; the gate holds `05`).
  - **Blank:** every send ends by filling `0x12`, `0x33`–`0x3F`, `0x43`, `0x9F`–`0xAB`, `0xB8`–`0xBE`, `0xCE`–`0xF6`,
    `0xFC`–`0xFF`, `0x18D`–`0x18F`, `0x983`–`0x9C2`, `0xA1A`–`0xA28` with `FF`, `0x100`–`0x113`, `0x144`,
    `0x179`–`0x18C` with spaces, and the gap before the directory (`0xC3F`–`0xF7F` in 255 mode, `0xA41`–`0xBFF` in
    10 mode) with `FF`. `rcv_out.bin` bytes 8–9 are never read (`FF FF` in every stored record).
  - **Still unknown:** `0x13`–`0x14` (DoorKing32 writes relay 1's entry code range To there too, the gate holds
    `FF FF`), `0x37` and `0x43` (`01` on the gate though DoorKing32 writes `FF`: set by the board or other
    software), `0xC5` (never written). The last download (2026-11-05 17:40 UTC) wasn't from this app, which hasn't
    sent yet; it also left these `01` bytes and `0xFB` = `05`, which DoorKing32's builders wouldn't write.
  - The settings existed only as raw bytes in the encrypted base `names.bin` (no `gate_settings` rows) until then;
    `addMissingValues` (startup) adds rows for settings decoded after a working copy was saved.
- **Desktop-app trace leads (unconfirmed):** tracing `FUN_004aad40` put anti-pass back (mode, relays,
  reset counter, re-sync days, scheduled re-sync time) at `names.bin` **`0xA04`–`0xA40`**. That trace
  also guessed holidays at `0x243` and facility codes at `0x9C3`, and pull diffs later proved both wrong
  (see §3.5). Treat trace-derived offsets as leads and confirm each with §7 before relying on it.

---

## 8. Known limitations / pending work
- **Single sign-on (OpenID Connect, 2026-11-13):** built and tested (unit tests, a mock provider token exchange, and an
  end-to-end run of a second server copy on port 8099 against the test database); no real provider configured yet.
  Not done: mapping Entra groups / app roles or Google groups to gate roles, an SSO badge in the Gate users list,
  signing out at the provider, SAML and LDAP / Active Directory (user's choice: OIDC only; no sign-in at the reverse proxy).
- **Read-only settings from the decompile (`dialType`, `multipleSystems`):** confirm with one-change diffs
  (§7) before making them editable. `0x13`–`0x14`, `0x37`, `0x43` and `0xC5` are still unknown (§7.1).
- **Gate values as the working copy (phases 1-3 of the 2026-11-12 plan): done** (§4.2). Not yet done: a real send
  built from the values (everything up to the send is tested; the first send should be a small change, then check
  the verify pull).
- **Middle-entry pointer (`names.bin` `0xF8`, §3.4.1), to test with the user:** browsing on the gate starts at this
  entry. The gate holds `0x141C` (entry 59) where `updateMiddlePointer()` computes `0x1430` (entry 60), so the next
  sent directory edit would make browsing start one name later. Test: note the first name shown when browsing on the
  gate; hide or show one resident at the gate or in DoorKing32 (not in this app); **Pull residents**; note the first
  name again; compare the gate's new pointer with the formula and fix `updateMiddlePointer()` if the gate counts
  differently.
- **Directory display order (partly implemented):** new codes are inserted in DoorKing32 order (§3.4.1).
  Not mapped yet, so still done in place: filling a vacant slot, renaming, and changing vendor/hidden
  (DoorKing32 may move these entries). How commas, spaces and digits sort is also unconfirmed.
- **New codes not yet sent to a gate:** §3.4.1 matches DoorKing32's files; no send of a new or removed code
  has been verified with a pull afterward.
- **Incremental transaction pulls:** not implemented (always full 10,000-event history, see §3.7).
- **2026-10-21 work not yet checked in a browser / against the gate:** the sidebar densities (tight is estimated
  to fit a ~640 px tall window), the "?" tips' look, Tracker relays 3-18 live control, Delete stored gate data.
- **Mass Enable:** not built by decision (§3.3); a gate set up with DoorKing32 may hold `AB` records.
- **Communication type:** only DKS Cellular is used; there's no setting for the other DKS types.
- **Sending to the gate:** the push path (`SendResidentData`, `POST /api/gates/<phone>/send`) is fully implemented with a
  verify-pull afterward. DKS enforces single-owner sync (desktop **or** cloud); if the gate is owned by
  the desktop/cloud account in a conflicting mode, a send may be refused by DKS. Earlier in the project
  sending was deliberately kept **off** during testing; it is now wired. **Treat the first real send to
  a production gate with care** (it changes the physical gate; relay control holds it open).
- **Area-code table growth:** `areaCodeIndex()` appends a new area code (3 digits only) to the first free
  table slot, limited to the first 10 slots when the saved `areaCodes` pref is `10 Area Codes`
  (`areaCodeLimit()`). Saving `10 Area Codes` converts the working copy (3.4.2) and is refused while more than
  10 area codes are in use. Unused area codes are only dropped by that conversion; in 255 mode they stay in
  the table. Not yet sent to a gate: whether DKS accepts the resized `names.bin`, and which layout a pull
  returns, are untested.
- **Tracker (mapped 2026-10-20 by one-change diffs of DoorKing32's saved files; snapshots
  `BAK\ACCT0001_tracker0_baseline` … `tracker4_addl_tracker2`):** DoorKing32 shows "Additional Relays For Tracker 1"
  (relays 11-18, commanded by relay 1) and "... Tracker 2" (relays 3-10, commanded by relay 2) on the Relays screen
  only while System Info → Tracker is ticked. Ticking one fixes that relay's strike time at 00 with the note "When
  Additional Relays Feature is selected, the relay time is 00 and cannot be changed. Times for Relays 11-18 [3-10] are
  set at the hardware", and lets relays 3-18 be named. Confirmed:
  - **Tracker** = `ACCOUNT.DAT` `0x312` (`00`/`01`); no gate byte changes. **Tracker 1 box** = `ACCOUNT.DAT` `0x449`;
    **Tracker 2 box** = `0x44a`. The boxes keep their state while Tracker is off (hidden, not cleared). None of
    these are on the gate.
  - Ticking Tracker 1 changes only `names.bin` `0x04` (relay 1 strike time) → `00`; relay 1's tones (`0x07`-`0x0A`)
    and entry code range (`0xB0`-`0xB3`) are **kept**. Ticking Tracker 2 changes only `0x05` (relay 2 strike time)
    → `00`; relay 2's tones (`0x0B`-`0x0E`) and range (`0xB4`-`0xB7`) are kept. Unticking puts the strike time back to what it was (seen in
    DoorKing32's screen). `ACCOUNT.DAT` above ~`0x1B00` is a session text log rewritten on every save; ignore it.
  - Ours: prefs `tracker { enabled, tracker1, tracker2, prevTime1, prevTime2 }` (page only). Ticking a box saves the
    current strike time in `prevTimeN` and writes 00 to `relayNTime` in the working copy; unticking writes `prevTimeN`
    back. The command relay's row (strike time, 4 tones, entry code range) is locked, values kept. Manual
    3.1.3/3.2: with Tracker, relays 1/2 are command relays and the tones, postal switch and rotary dial 9 must
    activate relay 0 instead. Relay names 3-18 go in prefs `relayLabels` (names are DoorKing32-only, confirmed
    earlier). The postal switch / rotary dial 9 checkboxes (§3.5) lock for a command relay too.
  - Entry-code ranges for relays 0 and 2 are mapped too (§3.5); relay 2's locks with Tracker 2.
- **Card removal:** DoorKing32 closes the gaps in `cards.bin` when cards are removed (step 24); `applyCards()`
  leaves the record `0xFF` in place. Unmapped.
- **4-digit area codes:** the pulled table held `1315`, `1323`, `1682` (a leading `1`, stored as all 4 BCD
  digits). Per the DoorKing manual these are valid "Alternate Area Codes" (1 + area code) for long-distance
  dialing, so they are kept. `areaCodeIndex()` accepts 3 digits or `1` + 3 digits; the form takes 11-digit
  phones (1 + area code + number). The earlier "Fix 4-digit area codes" rewrite (`fixAreaCodes()`,
  `POST .../area-codes/fix`) was removed.
- **Gate camera snapshots (built 2026-10-19, not yet run against the recorder from the app):** the test gate's
  Dahua recorder (serial `<serial>`; the serial is treated as public, the login is what protects it) is
  reached through `tools/bin/dahua-p2p-*.exe`. Verified by hand 2026-10-19: live view and
  `rtsp://<user>:<pass>@127.0.0.1:<port>/cam/playback?channel=<N>&starttime=YYYY_MM_DD_HH_MM_SS` work, with
  **local time** (UTC returns nothing). Channel 1 = Front gate, channel 2 = Back gate. The bridge exits when
  its connection drops; `createCameraRunner` starts it with `-listen 127.0.0.1:0`, reads the port from its
  "listening on" log line, stops it after 2 min unused and starts it again on the next use. Observed
  2026-10-19: the recorder can stop answering mid-stream; the bridge logs "device stopped consuming our data
  ... closing tunnel" but keeps running, and ffmpeg fails with "Invalid data found when processing input". The
  runner then replaces the bridge and retries the frame once (`TUNNEL_DEAD`, `STREAM_NOT_OPENED`). Settings, snapshot
  runs after transaction pulls, thumbnails and the viewer are in place (README "Gate camera snapshots").
  First app run 2026-10-19: frames took about 1 s each; some playback times returned `404 Not Found` (treated as
  "No recording at this time"; that it means no recording is assumed, not verified); some
  frames saved part-green (cut off in transfer, mostly while 3 grabs ran at once). Since then: playback grabs
  run one at a time, ffmpeg decodes keyframes only and a frame with decoder errors (`DAMAGED`) is deleted and
  retried once, a bridge that fails to connect is started again after 10 s and 20 s (`connectTries`,
  `connectWaitMs`; then error code `NO_CONNECTION` ends the run after that minute, result `error`), and minutes
  with missing frames are `partial` and retried for the missing frames only. Damaged pictures saved before this
  change are still on disk. Seen 2026-10-19: "direct P2P failed after 3 attempts: timeout waiting for device
  response (try relay mode)"; the bridge has no relay mode.
  Seen 2026-10-19: single 404s at random seconds inside minutes whose other frames were recorded (e.g.
  20261018-1946 ch1-00), so a 404 is not always "no recording". Every failed frame (404 included) is now tried
  once more after `retryWaitMs` (2 s); minutes recorded `done` with a 404 before this change are not re-fetched.
  Probing showed the recorder 404s whole 2–8 s stretches (e.g. 19:46:00–19:46:06) every time. When a frame
  still gets "No recording at this time", `grabNearby` tries −2 s, then +2 s (`NEARBY_SECS`, one try each) and
  saves the first picture; the snapshot log's `shifts` column ({ file: seconds }) records it and the picture's
  tooltip shows the actual time. Runs and the refresh button both use it.
  Unverified: these changes against the recorder, and the gate/recorder clock difference (the 10:04 frames
  matched the transaction minute, so **Clock offset** 0 looks right).
- **Gate camera video clips (built 2026-10-19):** camera setting `mode` ('snapshots' default, or 'video'). Video
  jobs (`frameJobs`) are one `ch<N>.mp4` per channel: `VIDEO_SECS` (120) from the minute's start
  (`clipQuery`: `starttime` + `endtime`), copied with `-c copy` to a fragmented MP4 (`ch<N>.rec<i>.mp4`), then
  `finishClip` joins the parts (concat demuxer), tags H.265 `hvc1`, adds `+faststart` and saves the first keyframe
  to `ch<N>.jpg`. The bridge is not stopped as idle while a grab uses it (`b.busy`). `afterMs` makes video minutes
  wait one more minute, like `framesAfter`. Measured against the test recorder (channel 1): H.265 Main,
  2688×1520, ~30 fps, ~4.1 Mbit/s; playback streams at ~1.05x real time (a 2-minute clip took 122-126 s, about
  62 MB). `subtype=1` (substream) playback is refused. ffmpeg's MPEG-TS writer fails on this stream ("Invalid data
  found when processing input"), so the raw container is fragmented MP4. Seen: a clip that stopped at 42 s with
  the bridge gone (P2P drop), playbacks that opened but sent ~2 KB in 30 s, and playbacks that failed to open for a
  few minutes after several test sessions were killed without closing; `grabClip` asks for the rest from where it
  stopped (or again from the start when nothing came) while each part brings video, up to `CLIP_MAX_PARTS` (8)
  parts; `CLIP_RESUMES` (2) limits only the requests that bring no video. A video still more than
  `CLIP_SHORT_SECS` (5) short is fetched again from the start, up to the camera setting `clipTries` (System Settings → Gate cameras → Video tries, 1-5,
  default `CLIP_TRIES` = 2) times. The longest short video is kept (`saveClip`; also when a later try fails) and
  listed in the snapshot log's `short` column (`{ file: seconds }`); the minute is `partial` with the error ("The
  recorder sent only 7 s of 120 s of video"), `missingFrames`/`needsRun` grab it again on later runs, and a new
  video replaces it only when complete or longer. The refresh button does the same. The UI marks it "Partial"
  (a 7 s clip was seen 2026-10-19).
  A playback stream also stops at a gap in the recording, and a request just after it gets `404 Not Found` (Front
  Gate 2026-10-18 14:22: recording to about 14:22:43, 404 at :44 to :56, recording again by 14:22:58; another
  gap around 14:23:46; checked 2026-10-20). The stream stops a second or two before the gap, and a request in
  those last seconds can stall until the bridge closes the tunnel ("device stopped consuming our data"). Before
  this, every grab of that minute was 45 s. On "No recording", `grabClipOnce` moves on `CLIP_GAP_STEP` (5) seconds (once each, no retry)
  until the recording starts again, joins the parts, and counts the gap toward the 2 minutes, so such a video
  is complete, not partial ("no recording from +42 s to +57 s, skipped it" in the log). A clip with no recording
  at all is "No recording at this time" as before. An end-to-end run of
  `runSnapshots` in video mode saved a full 2:00 clip and a correct first-frame picture. Not yet tried: the
  resume path against the recorder, playback in a browser (H.265 support varies), and a whole run from the app.
  Video mode and earlier picture runs: `pendingMinutes` uses `needsRun`, so in video mode a minute without every
  `ch<N>.mp4` is pending until a video-mode run has tried it; after that `finished` and the snapshot log's
  `video_attempts` column (`videoAttempts`, counted by `recordSnapshot` with `video: true`, `MAX_ATTEMPTS`) decide.
  Before this, minutes finished with pictures were skipped, so runs only stopped at scattered unsaved minutes.

---

## 9. Safety notes (carry these forward)
- **Relay control and Send physically change the gate.** Relay "hold open" leaves the gate open until
  released. Keep the confirm dialogs.
- Login convenience stores only the user name in the browser — **never** the password or master code.
- The database holds master codes and saved DKS passwords, encrypted; `doorking.key` sits next to `config.json`
  (user's choice, 2026-10-16 and 2026-11-13): anyone with both the key and the database can decrypt them. Local only, never commit or share
  (git-ignored). `GET /api/gates` never returns master codes; no route returns saved passwords.
- The pre-database files (`gates.json` with plain-text master codes, `prefs.json`, `DOWNLOADED/sign-ins.json`,
  `DOWNLOADED/<phone>/history.jsonl`) were checked against the database and deleted on 2026-10-21.
- Scheduled entries with **Send** change the gate without a confirm at run time; the UI confirms on save.
- Test credentials used during development were to be destroyed post-testing; don't commit secrets.
- Prefs (database, formerly `prefs.json`) may contain gate config for real sites — treat as local, don't publish.
- **Files in the project that contain secrets:** `config.json` (database password) and `doorking.key`. The conversation exports
  and `export/ACCOUNT.txt`, which held the test DKS login and the gate master code, were deleted on
  2026-10-16. The old machine also had a user-level `DKS_PASSWORD` environment variable set for the CLI.
  Rotate the test credentials as planned and clear that variable.
- **Security review, 2026-10-21:** DKS Cloud default switched from `http://` to `https://dksdb.dksoftware.com/...`
  (same service; a `CheckLogin` with made-up credentials answered normally over HTTPS), so passwords and master
  codes no longer travel in clear text. Added: sign-in limit (5 failures per user name in 15 min → 429, without
  calling DKS), a sweep that removes idle sessions (and their in-memory DKS passwords) every minute, JSON bodies
  limited to 10,000 bytes (413) and required to be objects. Checked and fine: file routes match strict name
  patterns, gate/schedule/history lookups are scoped to the gate and user, child processes get argument arrays
  (no shell). Debug log gained areas `dks`, `change`, `gates` and more `session`/`schedule`/`camera` lines.
  Docs: `INSTALL.md`, `MANUAL.md`, `API.md`, `DB.md` (README now links to them).
- **Public deployment, 2026-11-12** (an AWS machine, Ubuntu 26.04, project at `/home/ubuntu/doorkings`, Node
  v26.13.0 via nvm; names and addresses below are placeholders):
  - Public at **`https://gate.example.com`**, open to anyone (user's choice; the sign-in (local accounts since
    2026-11-13) and its failure limit protect it). The machine's public (Elastic) IP is on a second network interface with its own private address
    (`<public-interface IP>`); the first interface goes out through NAT, and a Docker container on it holds port
    8080 there, no clash with the app on `127.0.0.1:8080`.
  - **Caddy 2.6.2** (apt) on `<public-interface IP>:80/443`, `/etc/caddy/Caddyfile` (original kept as `Caddyfile.orig`):
    Let's Encrypt only (`cert_issuer acme`), HSTS and security headers, `reverse_proxy 127.0.0.1:8080` with
    `flush_interval -1`. Certificate issued 2026-11-12 by Let's Encrypt (YE2, expires 2027-02-10; Caddy renews it).
    Check the spelling of the domain the DNS A record is on (a first setup used a misspelled one). "no OCSP stapling" in Caddy's log is expected (Let's Encrypt dropped OCSP).
  - **systemd** `doorking.service` (user `ubuntu`, `--public-host gate.example.com`, the nvm node path,
    `Restart=on-failure`) and `caddy` are enabled at boot. Logs: `journalctl -u doorking` / `-u caddy`.
    Restart the app with `sudo systemctl restart doorking` (don't start a second copy by hand).
  - Verified 2026-11-12: Let's Encrypt validated the name from the internet (so 80/443 are open), HTTP → 308 to
    HTTPS, `/`, `/help`, `/api/session` 200 over HTTPS, security headers present, foreign `Origin` → 403, `sid`
    cookie `Secure`. Not yet done: a real sign-in and pull through the public address.
  - On the move: `node_modules` (Windows ARM build) was replaced by `npm ci`; the Linux camera tools got their
    execute bit back; `DB/key` set to `600`.
  - **PostgreSQL (2026-11-12; SQLite removed):** the machine's own PostgreSQL 18.6 (apt, `postgresql@18-main`,
    `127.0.0.1:5432`, enabled at boot) has role `doorking` owning databases `doorking` (the app) and `doorking_test`
    (tests: one `t_<random>` schema per test, dropped after). Login in `DB/postgres.url` and `DB/pgpass`
    (0600). `doorking.service` now starts after `postgresql.service`.
  - Code: `src/db.ts` on `pg` (`Pool`, max 5): `openStore(dir, { url?, schema? })` is async and creates the tables;
    helpers `all`/`one`/`run` and `transaction(store, async (tx) => …)`; TIMESTAMPTZ come back as ISO strings and
    BIGINT as numbers (type parsers). Every DB function in `gate-list`, `prefs`, `notes`, `tx-history`, `audit`,
    `schedules`, `cameras` and `debug-log` is async. Column `user` is now `username` (reserved word). JSON columns
    are JSONB. `setPrefs` reads `FOR UPDATE` in a transaction; `mergeTransactions` holds a per-gate advisory lock.
  - `server.ts`: top-level `await openStore` (exit 1 "Database not available" on failure); the Debug logs setting
    is cached in `debugOn`. `startJob` claims the job synchronously and builds the DKS request inside, so the
    `busy(g) || startPull(...)` check can't race. Working-copy/prefs changes run one at a time per gate (`serial`),
    so a History patch holds exactly its own change.
  - Data copied 2026-11-12 with a one-time script (since deleted) and checked row by row, including that every
    encrypted value decrypts: meta 2, gates 1, prefs 1, sign_ins 1, history 89, credentials 1, schedules 1,
    cameras 1, snapshots 346, notes 0, tx_history 13833. The old `DB/data.db` files were deleted the same day
    (user's choice). No PostgreSQL backups yet (user: not now), so PostgreSQL holds the only copy of this data.
- **Config file, 2026-11-13:** `config.json` (gitignored, mode 0600; template `config.example.json`) holds every
  server setting including the database password; `doorking.key` (the old `DB/key`, byte for byte) sits next to it.
  `loadConfig` (`src/config.ts`) refuses unknown names, wrong values and files other users can read. `DB/` was
  deleted after checking that every encrypted value decrypts with the moved key; its `pgpass` became `~/.pgpass`.
  `DOWNLOADED/` became `media/`. The systemd unit no longer passes `--public-host` (it's `server.publicHost`).
- **Schema file and db-setup, 2026-11-13:** the schema moved from a string in `src/db.ts` to `sql/schema.sql` (not
  `db/`: `.gitignore`'s `DB/` would hide it on case-insensitive filesystems); later columns are folded into the
  `CREATE TABLE`s, the `ALTER … IF NOT EXISTS` lines kept for older databases. `node cli.ts db-setup [--test-db]`
  (`setupDatabase`) creates the login role and databases through an admin URL asked for hidden (or
  `DATABASE_ADMIN_URL`), then opens the store. Checked with a throwaway non-superuser admin (CREATEROLE +
  CREATEDB): on PostgreSQL 16+ such an admin only gets ADMIN on roles it creates, and `CREATE DATABASE … OWNER`
  needs SET, so it grants itself membership first.

---

## 10. Quick orientation for the next AI
- Start the server (§5), open the UI, log in, **Pull residents**.
- The **write path** you'll most likely extend is `src/residents-edit.ts` (+ its tests) and the
  `/api/gates/:phone/residents` routes in `web/server.ts`, with UI in `web/ui/panes/ResidentForm.tsx`
  (edit/add/delete/remove code), `Directory.tsx` and `WorkingCopyBar.tsx` (Reset/Send). Run `npm run build`
  after UI changes.
- The **parse path** is `src/board-files.ts`; UI data shaping is `web/data.ts`.
- To decode a new field, follow §7 and add a byte-exact test.
- Run `node --test` before and after any change; keep it green.
