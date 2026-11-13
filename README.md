# DoorKing Gate Manager

A JavaScript rebuild of the discontinued **DoorKing32.exe** desktop app ("DoorKing Account Manager"). It
manages DoorKing telephone-entry gate systems through **DKS Cloud** (DoorKing's SOAP web service): pull
residents and transactions from the gate, edit residents, vendors and gate settings, send the changes back,
and control relays live.

It is a local Node.js app with a web page and a REST API, written in TypeScript. The server runs directly on
Node 24; its data is in a PostgreSQL database (through the `pg` driver, its one runtime npm package); the web page (React +
Radix Themes) is built once with `npm run build`. It can also save camera pictures or video clips for each
gate transaction from a Dahua/Amcrest recorder, and show the cameras live.

> **Sending and relay control change the physical gate.** A relay set to Active holds the gate open until it
> is set back to Inactive.

## Documentation

| File | For | Contents |
|---|---|---|
| [`INSTALL.md`](docs/INSTALL.md) | whoever sets it up | requirements, install on a new machine, moving an install, running it as a service, updates, backups, troubleshooting |
| [`MANUAL.md`](docs/MANUAL.md) | users | the user guide, in plain language; shown in the app at `/help` (**Help** in the sidebar, on the gate list and on the sign-in page) |
| [`API.md`](docs/API.md) | scripts | the REST API |
| [`DB.md`](docs/DB.md) | developers | database files, encryption and every table |
| [`BITMAP.md`](docs/BITMAP.md) | developers | which bytes of the gate's board files hold which setting |
| [`HANDOFF.md`](docs/HANDOFF.md) | developers | format notes, reverse-engineering history and open questions |

This README is the technical overview.

## Contents
1. [Signing in and gate access](#signing-in-and-gate-access)
2. [Features](#features)
3. [How settings are stored](#how-settings-are-stored)
4. [Scheduled transfers](#scheduled-transfers)
5. [Cameras](#cameras)
6. [Debug logs](#debug-logs)
7. [How data flows](#how-data-flows)
8. [REST API](#rest-api)
9. [Command-line tool](#command-line-tool)
10. [Tests](#tests)
11. [Security](#security)
12. [Project layout](#project-layout)

Installing, the server's settings (`config.json`, every setting listed in INSTALL §4; `config.example.json` has the
defaults), public HTTPS access and updating are in [`INSTALL.md`](docs/INSTALL.md).

## Signing in and gate access
```
Sign in (local account) ──> Your gates (admin / read only) ──> Open a gate ──> every DKS call uses the gate's DKS login
   users + sessions tables      gate_access                                   managed_gates (encrypted)
```
1. **Accounts** (`src/users.ts`). People sign in with a local username and password; usernames and emails are
   case-insensitive and unique. Passwords are scrypt hashes (minimum 12 characters). There is no sign-up page:
   gate admins create accounts (with a temporary password the user must replace at their first sign-in). Nobody
   can read or set another user's password from the web; whoever runs the server can (`node cli.ts reset-password`).
   After 5 failed sign-ins within 15 minutes a username is refused for the rest of that time.
2. **Sessions.** A random token in the `sid` cookie (HttpOnly, SameSite=Strict, Secure over HTTPS); the database keeps
   only its SHA-256 hash (table `sessions`), so sessions survive a restart. They end after **30 minutes idle**, on
   **Sign out**, or when the user changes their password (other sessions). The open gate is kept in the session.
3. **First start.** While no account exists, the page offers to create the first one, which needs the one-time
   **setup code** the server prints in its console (journalctl) at start, or `node cli.ts create-admin <username>`.
   The first account becomes admin of every gate without an admin (gates moved over from DKS sign-in on 2026-11-13).
4. **Gates** (`src/gate-list.ts`, table `managed_gates`). A gate is added once: phone, master code, its **DKS login**
   and gate configuration. The server checks the DKS login (`CheckLogin`), then pulls residents with these values;
   only when that succeeds is the gate saved, with the adder as its admin (so nobody can claim a gate by typing its
   phone number). Adding a gate already managed here is refused: "ask one of its gate admins to add you". The DKS
   login and master code are encrypted and never sent back; every pull, send, relay call and scheduled transfer of
   the gate uses them. Admins change them under System Settings → Gate login (a new login is checked with DKS
   Cloud; a new master code by a residents pull, saved only when it succeeds).
5. **Roles** (table `gate_access`). Per gate: **admin** (everything, including the gate's users and login) or
   **read only** (view, pull, camera pictures and live view). Routes are scoped `gate` (any role) or `gate-admin`.
   Admins create accounts for their gate, share it with existing accounts, change roles and remove users; a gate
   always keeps at least one admin. **Leave** removes your own access.
6. **API keys** (`src/api-keys.ts`, table `api_keys`). Scripts don't sign in: a gate admin creates a key under System
   Settings → API keys (name, role, optional expiry of 30/90/365 days); it is shown once and stored as a SHA-256
   hash. A key belongs to its gate (it keeps working if its creator leaves) and is sent as
   `Authorization: Bearer <key>`. It reaches only that gate's routes, with its role; web-only routes (gate login,
   users, API keys, deleting the gate's data, leaving) refuse it. History shows key actions as `api:<key name>`.
   Revoking deletes it at once. See [API.md](docs/API.md).

## Features
Every page works on the open gate. Edits to gate data go to the **working copy** first (blue = unsaved on this
page, green = saved to the working copy but not on the gate yet; hover a value to see the gate's value), and reach
the gate only with **Send to gate**. Anything that changes the gate asks for confirmation first.

**Sidebar.** Gate name and **All gates**; the pages below; pinned at the bottom: History, Scheduled Transfers,
System Settings, **Gate connection** and your user name and role with **User settings** and **Sign out**. Read-only users
see every page with the edit controls hidden or disabled.

**Gate connection.** **Pull residents** / **Pull transactions** start a DKS Cloud session with the gate; the
progress window (bottom right; minimize or close it, **Show progress** reopens it) shows the log. One gate
connection runs at a time across all gates. When a pull or send finishes, the data reloads and its page opens.

| Page | Features |
|---|---|
| **Residents / Vendors** | Table of the working copy: directory code, name, hidden, phone, entry code, security level, floor, elevator, cards, notes (vendors: name, entry code, security level, cards, notes). Security level shows **Enabled** for 1 and **Disabled** for 0 (display only; the gate stores the number). Filter, sort by any column, **Download CSV**. Card numbers show their Device Association name on hover (red when no range holds them). **Duplicates** (a directory code, entry code or card held by more than one entry, `findDuplicates` in `src/residents-edit.ts`) are listed in a red alert and marked red, and **Send to gate is refused** until they're fixed; edits never create one (409). Click a row for its last 5 transactions (green = admitted, red = denied; with camera pictures) and **Edit**: name, phone (formats as you type; 7 digits, 10 with area code, or 11 as 1 + area code for long distance), entry code, security level, floor, elevator reference, hidden, cards (add/remove; device codes 00001-65407), notes (up to 500 characters, saved in the shared database so every user of the gate sees them, never sent to the gate; the column shows one line, hover for all of it), **Delete** (blank the slot; also clears the note) or **Remove code** (take the code off the gate). **Add resident / Add vendor** suggests vacant codes, other than 000 and 001 (they always get the maximum talk time, so they're best kept for the office or an emergency number). Working-copy badge with **Reset to gate** (back to the last pull) and **Send to gate** (shows the changed blocks first; a residents pull afterwards checks the gate). |
| **Transactions** | The gate's transaction history, newest first (every pull is added to it, so events stay after they roll out of the gate's buffer): last 24 hours / 7 days / 30 days / all, filter, sort (clicking Time after Date sorts times within each date), **Download CSV**. Rows are green (admitted), red (denied) or amber (system events). Names and numbers link to the resident or vendor. With cameras set up: a Camera column, **Get camera snapshots** (or videos), **Stop**, progress (see [Cameras](#cameras)). |
| **Display** | LCD messages. Choose Single Line or 8 Line (remembered in this browser; the gate stores both). Each box allows the gate's limit: System message 27 characters, System instruction 52, each 8-line message 20. |
| **Relays** | **Live relay control**: buttons for relays 0-2, plus the Tracker relays when their box is ticked, read from the gate when the page opens (green = held open, red = released); tapping one changes the gate **immediately**. A Tracker command relay is greyed out (the server refuses it too). Relay settings: **name** (a box per relay, saved on leaving it; Tracker relays get a name-only row), strike time, the four open tones, entry-code range, and whether the postal switch and rotary dial 9 activate each relay. A tone digit used twice turns both boxes red with an alert, and saving is refused (also by the server) until they differ. With **Tracker** on (Gate configuration): **Additional Relays For Tracker 2** (relays 3-10, commanded by relay 2) and **... Tracker 1** (relays 11-18, commanded by relay 1); ticking one sets that command relay's strike time to 00 in the working copy ("times are set at the hardware"), as DoorKing32 does (unticking puts the earlier time back), and locks that relay's whole row: strike time, tone open numbers, entry code range, postal switch and rotary dial 9. Per the DoorKing manual (3.1.3), tones, postal switch and rotary dial 9 then go on relay 0. The boxes are saved for the page only. |
| **Hold Open** | Begin/end times, days and relays (0-2, plus 3-10 / 11-18 with the Tracker boxes) for 7 rows plus the Holiday row. |
| **Holidays** | 32 holiday dates: pick from the built-in fixed-date list or enter M/D. **Holidays for Security Levels** (asks first): TZ4 of every security level becomes the Holiday time zone, shown as HOL on Security Levels. |
| **Security Levels** | Pick a level (02-30); for each of its 4 time zones: begin/end, days, relays (0-2, plus 3-10 / 11-18 with the Tracker boxes), floors. |
| **Facility Codes** | Enable flag and up to 10 codes (000-255). |
| **Elevator Reference** | The Elevator Reference table, ER1-ER8 (a resident's Elevator reference picks the row): which elevators (1-8) the resident's visitors may use and how long the resident's floor button stays active, in seconds. |
| **Relay / Elevator** | Which elevators (1-8) each relay controls: relays 0-2, plus 3-10 / 11-18 with the Tracker boxes. Hidden with the Elevator Reference page when **Elevators** is off. |
| **Anti-Pass Back** | Mode, In/Out relays (up to 10; 0-2, plus 3-10 / 11-18 with the Tracker boxes), facility counter, one-time re-sync, scheduled Re-Sync All. Applies only to cards in security levels 02-27; levels 01, 28, 29 and 30 are never limited by it. |
| **History** | Every user's last sign-in; this gate's pulls, sends, relay changes, camera setting changes and working-copy changes, newest first. Click a change for a From/To table; **Revert** undoes it in the working copy (refused if a later change touched the same data). |
| **Scheduled Transfers** | Entries the server runs on set days and times: send, pull residents, pull transactions, camera snapshots. Edit, Run now, Delete. They run with the gate's DKS login. See [Scheduled transfers](#scheduled-transfers). |
| **System Settings** | (admins) **Gate login** (DKS user/password and master code, checked before saving) and **Gate users** (create accounts for the gate, share with existing accounts, roles, remove); **Gate configuration** (must match the gate; a new gate starts at 255 area codes, the default in the DoorKing 6.5 manual; also lists the working copy's area codes, where a 4-digit code is 1 + area code for long-distance dialing, and **Num of digits in dir code** (1-4), where decreasing wipes all resident data; **Show on the page**: switch off **Floors** to hide the Residents Floor column and field and the Security Levels Floors column, or **Elevators** to hide the Residents Elevator column and field and the Elevator Reference page; page only, the stored values are kept). **Gate settings** (master code read-only; talk time as m:ss, up to 4:14; outside line digit). **Working copy files** (download `names.bin`, `names.map`, `phone.bin`, `cards.bin`). **Tracker** (shows the Additional Relays boxes on the Relays page; page only). **Device association** (names for card-number ranges), **Gate cameras**, **Debug logs**, **Appearance** (dark mode), **Delete stored gate data** (after a warning, deletes every database row about the gate for every user, including its gate-list entries, and its `media/<phone>/` folder; nothing on the gate changes). |

Hold Open, Holidays, Facility Codes, Elevator and Anti-Pass Back have **Save to working copy**, **Discard unsaved**
and **Clear** (fills every setting on the page with its unset value as an unsaved edit; nothing changes until Save).

## How settings are stored
Settings live in one of five places, depending on what they belong to:

| Where | What | Shared by |
|---|---|---|
| **The gate** (and its working copy in the database, `gate_files`) | Residents, vendors, cards, and every gate setting: Display, relay settings, Hold Open, Holidays, Security Levels, Facility Codes, Elevator, Anti-Pass Back, master code, talk time, outside line digit, directory code digits, area codes. Read by pulls, edited in the working copy, written by **Send to gate**. | Everyone who manages the gate |
| **Database, per gate** (PostgreSQL, keyed by phone number) | Gate configuration, Floors/Elevators switches, relay names, Device Association (`prefs` table); resident/vendor notes (`notes`, by directory code without leading zeros); transaction history (`tx_history`, every event pulled); camera settings (`cameras`, password encrypted); snapshot log (`snapshots`); scheduled transfers (`schedules`); history (`history`). Not sent to the gate (DoorKing32 kept relay names and Device Association in `ACCOUNT.DAT`). | Every account that manages the gate on this PC |
| **Database, per account** | Account (`users`: scrypt password hash, email, dark mode, last sign-in), sessions (`sessions`, token hashes), access to gates (`gate_access`: role per gate). | That user (access: the gate's admins) |
| **Database, per gate (system)** | The gate's master code and DKS login (`managed_gates`, encrypted). | The gate's admins |
| **Database, whole server** | Debug logs on/off (`meta` key `debugLogs`). | Everyone |
| **This browser** (localStorage) | Remember user and the username, the last dark mode (for the sign-in page), the Display page's layout choice. Never a password or master code. | That browser |

`config.json` (`gateDefaults`) gives gate-match
defaults.

**Encryption.** On first start the server creates `doorking.key` next to `config.json` (`paths.keyFile`): 32 random
bytes as 64 hex digits, mode 0600. Master codes, gates' DKS passwords, recorder passwords and the stored gate files
are encrypted with AES-256-GCM using that key; everything else in the database is plain. Keep the database and the
key together: without the key the encrypted values can't be read, and anyone with both can read them. The database
login is in `config.json` (`database`); tables and setup are in [DB.md](docs/DB.md). The server refuses to start
while `config.json` or the key can be read by other users (Linux/macOS).

| File | Contents | Share? |
|---|---|---|
| PostgreSQL database `doorking` | tables `users`, `sessions`, `managed_gates`, `gate_access`, `prefs`, `history` (per phone, with before/after resident data), `schedules`, `cameras`, `snapshots`, `notes`, `tx_history`, `meta` | **No** |
| `config.json` | the server's settings, including the database password (`config.example.json` is the committed template) | **No** |
| `doorking.key` | AES-256-GCM key for the encrypted columns | **No**: with the database it decrypts master codes and passwords |
| `media/<phone>/` | `snapshots/` (camera pictures and videos). The board files are in the database (`gate_files`) | No: camera pictures |
| `logs/debug.log` | written only while Debug logs is on | No: holds phone numbers and recorder serials |

## Scheduled transfers
DoorKing32's Scheduled Transfers, reworked: each gate has its own list of entries instead of four shared
schedules A-D.
- An entry has days of the week, a time (the server's local time, 24-hour) and any of: **Send working copy to
  gate**, **Pull residents**, **Pull transactions**, **Get camera snapshots**. They run in that order. Send is
  skipped when the working copy has no changes; it is the same send as the UI's (upload, then a check pull).
- **Get camera snapshots** is the same run as the Transactions page's button (see [Cameras](#cameras)). With
  **Pull transactions** in the same entry, it waits for the run that pull starts instead of starting another.
  It does not use the gate connection, is not recorded in History, and is skipped (noted in the last result)
  when the gate's camera settings are not saved or off. A stopped run, or one that ends early because the
  recorder cannot be reached, fails the entry.
- The server checks every 30 seconds. A time missed while the server was stopped runs once when it starts
  (DoorKing32 also runs past-due jobs). A new or edited entry waits for its next time; **Run now** queues it
  immediately.
- Due entries queue and run one at a time; each transfer waits for any running gate connection. A failed
  transfer does not stop the entry's other transfers. Each transfer is recorded in History with
  `(scheduled)` in its summary, and the entry shows its last result.
- Entries run with the gate's DKS login (System Settings → Gate login); "Saved by" shows who last saved the entry.
  Before 2026-11-13 each entry ran with its saver's own stored DKS password.

## Cameras
A gate can have a **Dahua or Amcrest recorder** (NVR/DVR) watching it. The app pairs the gate's transactions with
the recorder's footage: for each transaction it saves pictures (or a 2-minute video) from the moment it happened,
shows them on the Transactions page, and can show the cameras live. The recorder is reached the way Dahua's
DMSS and SmartPSS apps reach it, **by serial number through Dahua's P2P cloud**, so it needs no port forwarding
or VPN at the gate.

### How it connects
```
server ──spawns──> dahua-p2p bridge ──Dahua P2P cloud──> recorder
   │                 (tools/bin)        (by serial)
   └──spawns──> ffmpeg ──rtsp://127.0.0.1:<port>──> bridge
                 /cam/playback  (recorded footage, for pictures and videos)
                 /cam/realmonitor (live picture, for Test and the live view)
```
- **The bridge** (`tools/bin/dahua-p2p-<x64|arm64>.exe` on Windows, `dahua-p2p-linux-<x64|arm64>` on Linux,
  picked by `process.platform` and `process.arch`) logs in to the recorder through the P2P cloud and serves its
  RTSP streams on a free port on `127.0.0.1` only. It gets the serial and username on its command line and the
  password in the `DAHUA_PASSWORD` environment variable. It is started when the recorder is needed, stopped after
  2 minutes unused, and started again if its connection drops. A failed connection is tried again after 10 s and
  20 s; after the third failure the run stops with "Could not reach the recorder after 3 tries".
- **ffmpeg** reads those streams and writes the pictures, videos and the live stream: `tools/bin/ffmpeg.exe` or
  `ffmpeg-linux-<x64|arm64>` when present, else `ffmpeg` on the PATH (`ffmpegCommand`). The binaries are too large
  for the git repository, so a fresh install uses the system's (Ubuntu: `sudo apt install ffmpeg`).
- Recorder playback uses the **recorder's local time**. **Clock offset** (seconds) is added to the gate's
  transaction time to match the recorder's clock.
- The bridge is bundled with its license in `tools/licenses/` (dahua-p2p MIT; also ffmpeg's GPLv3 texts, for
  a local copy in `tools/bin/`). The bridge binaries are built, unmodified, from upstream
  [blackjid/dahua-p2p](https://github.com/blackjid/dahua-p2p) at commit `345f724` (rebuild steps in `HANDOFF.md`).

### Setting up
**System Settings → Gate cameras** (shared by every account that manages the gate; the password is encrypted in
the database and never sent back to the browser):

| Field | Meaning |
|---|---|
| Recorder serial, Username, Password | the recorder's login, as used in DMSS/SmartPSS. Leave Password blank to keep the saved one. |
| Channels | up to 4 rows on the page (the server accepts up to 8): channel number (1-64) and a name |
| Clock offset (seconds) | added to the gate's time to match the recorder's clock |
| Save | **Snapshots (pictures)** or **2-minute video clips** |
| Frames per transaction | pictures per minute in snapshot mode: 1, 2, 3 (default), 4 or 6, evenly spaced |
| Frames after the minute | 0 (default) to 6 more pictures from the following minute |
| Video tries | how many times a short video is downloaded again (1-5, default 2) |
| Transactions | **Admitted and denied entries** (default) or **All** |
| Look back (hours) | only transactions this recent get footage (default 24, up to 720), since recorders keep only so many days |
| Keep pictures | 15, 30, 60 or 90 days, or Forever (default): older minutes are deleted (see Clean-up) |
| Save snapshots after transaction pulls | on/off for the automatic runs |

**Save camera settings**, then **Test (live picture)** to grab a live frame from each channel (saved as
`snapshots/live/ch<N>.jpg`); it shows which channels work. **Remove** deletes the settings (saved pictures stay);
**Delete all pictures** deletes every saved picture, video and the snapshot log for the gate. Saving or removing
camera settings is recorded in History (never the password).

### When footage is fetched
- After every successful **transactions pull** (manual or scheduled), and on **Get camera snapshots** on the
  Transactions page or in a scheduled transfer.
- A run takes the wanted transactions from the look-back period, newest first, up to 60 minutes per run. Gate
  transaction times are to the minute, so every transaction in a minute shares the same footage.
- Runs are separate from gate connections: one run per gate at a time, and a pull doesn't wait for them.

### Pictures
- For each minute not done yet, ffmpeg saves frames from the recording (`/cam/playback`) for each channel at
  evenly spaced seconds (the default 3 frames: :00, :20, :40), one frame at a time, as `ch<N>-<SS>.jpg`.
- **Frames after the minute** adds frames spaced the same way from the following minute (`ch<N>-a<SS>.jpg`,
  shown as "+SS s after the minute"); with it set, a minute waits one more minute before it is fetched. Minutes
  already finished are not fetched again when the setting changes.
- Only keyframes are decoded. A frame with decoder errors (cut off in transfer) is deleted and tried once more
  ("Picture damaged in transfer"); any other failed frame, including a recorder 404, is tried once more after
  2 s. With **Debug logs** on, each retry and each frame that still fails is written to `debug.log`.

### Video clips
- **Save → 2-minute video clips** saves video instead of frames: for each channel, 2 minutes of recording from
  the start of the transaction minute (`/cam/playback` with `starttime` and `endtime`) as `ch<N>.mp4`, plus its
  first frame as `ch<N>.jpg` (the thumbnail). A minute waits one more minute before it is fetched.
- The video is copied without re-encoding (the test recorder sends H.265, 2688×1520, about 4 Mbit/s: about 62 MB
  per clip) and tagged `hvc1` so Safari plays it. Playing H.265 needs browser support (current Safari; Chrome
  and Edge on most computers with hardware H.265 decoding).
- The recorder sends playback at normal speed, so each clip takes about 2 minutes, one at a time: a run of 10
  minutes on 2 channels takes about 40 minutes.
- When the stream ends early or sends no video, the rest is asked for from where it stopped (up to 2 more times)
  and the parts are joined. A clip still more than 5 s short is deleted and fetched again, up to **Video tries**
  downloads in total; if it is still short it fails ("The recorder sent only 7 s of 120 s of video"), the old
  video (if any) is kept, and later runs try it again (up to 3 runs).
- Frame settings don't apply to videos. Minutes already saved in the other mode keep what they have: in video
  mode a minute with only pictures shows **Get video**, and once it has a video only the video is shown (the
  pictures stay on disk). Video-mode runs also fetch a video for every minute that has only pictures. The
  Transactions buttons then read **Get camera videos** / **Stop videos**.

### Retries
- A minute with missing frames is tried again on the next run (only the missing frames), up to 3 runs. A frame
  that gets a recorder 404 on both tries ("No recording at this time") is not asked for on later runs.
- When the P2P connection fails three times, the run ends after that minute and the next run carries on.

### On the page
- **Camera column** (Transactions, and each resident's recent transactions): each channel's first picture of the
  minute (▶ on a video; "Partial" on a short video). Click it to open the **viewer** with every frame or video of
  that minute, one row per channel.
- While a run is going the Transactions page shows a progress bar (pictures and minutes done), a status line
  and **Stop snapshots**, which kills the frame in progress; the unfinished minute and the rest are done on the
  next run. Each transaction whose minute is still to be fetched gets a small bar in the Camera column
  ("Waiting", or "2 of 6" pictures while it downloads).
- A frame with no picture is shown as a box with a question mark (in the Camera column when a channel has no
  picture, and in the viewer for each missing frame of the current settings). Every picture and "?" box has a
  refresh button (↻) in its corner that fetches that one frame again (tried twice like a run's frames). The
  saved picture is replaced only when the new one is saved; a minute whose frames are then all saved becomes
  done. Refreshes run one at a time per gate and are refused while a snapshot run is going.
- A transaction with no snapshots has a **Get pictures** button (**Get video** in video mode) in the Camera
  column. It runs a snapshot run for that transaction's minute only, whatever its transaction type, age or
  earlier tries (refused while a run is going; a minute less than about 2½ minutes old is not fetched yet).

### Live view
- The **camera button** at the top right of the page (shown when camera settings are saved) opens the **View
  Camera** window: pick the channel and **Low quality** (the recorder's sub stream, the default) or **High
  quality** (the main stream).
- The server re-encodes the live stream with ffmpeg to MJPEG at 8 pictures a second, at most 960 pixels wide, and
  sends it to the browser; nothing is saved.
- Minimizing or closing the window ends the stream. The page pauses it after 10 minutes (**Try again** restarts
  it), and the server ends any live stream after 15 minutes. If no picture comes, it shows "Could not show the
  live view" with **Try again**.

### Files
`media/<phone>/snapshots/<YYYYMMDD-HHMM>/` per transaction minute: `ch<N>-<SS>.jpg` (pictures),
`ch<N>-a<SS>.jpg` (pictures from the next minute), `ch<N>.mp4` and its first frame `ch<N>.jpg` (videos);
`snapshots/live/` holds the Test pictures. The database's `snapshots` table logs each minute's status, files,
errors and tries.

### Clean-up
`tidySnapshots` (`src/cameras.ts`) runs at startup, every hour, at the start of each snapshot run and when **Keep
pictures** changes (skipped while a run or refresh uses the folder):
- deletes leftover pieces of videos whose fetch was cut off (`ch<N>.rec<n>.mp4`, `.best.mp4/.jpg`, `.new.mp4/.jpg`;
  e.g. after a restart during a download);
- deletes minute folders older than **Keep pictures** (recorded in History as user `app`);
- marks log entries whose files are all gone as `removed` (an entry missing only some files lists just the rest).
  Removed minutes show **Removed** on the Transactions page and are not fetched again; minutes older than Keep
  pictures are not fetched either.

## Debug logs
System Settings → **Debug logs** turns logging on or off for the whole server (saved in the database, `meta`
key `debugLogs`; off by default). While on, `logs/debug.log` (see `--logs`) gets one line per entry:
`<ISO time> [area] message`. Areas:

| Area | Written for |
|---|---|
| `dks` | each DKS Cloud call: operation, time taken, reply size or error (never its parameters); `GetSessionStatus` polls only when they fail |
| `gate` | every gate connection line, as in the Gate connection window, without repeated statuses, and how it ended; live relay changes |
| `change` | every working-copy, preference, note and revert change recorded in History, with the user and the files it touched |
| `gates` | gates added (or a failed add), users created, shared, changed or removed, the gate login or master code changed, a gate's stored data deleted (with the rows removed per table) |
| `session` | sign-ins, refused sign-ins (wrong password, too many failures), sign-outs (also after 30 minutes idle), password changes, the first account, the gate a user opens |
| `api` | API keys created or revoked; requests refused for a wrong, expired or revoked key |
| `schedule` | entries added, changed, deleted or queued with Run now; each run started and its result |
| `camera` | snapshot runs started, stopped and finished, frame retries and failures, minutes not done, bridge starts, connections, exits and connection failures, live views opened and ended, camera tests, settings saved or removed, pictures deleted |
| `request` | requests answered with an error status |
| `server` | start, the one-time import, uncaught errors |

Above 5 MB the file is moved to `debug.log.1`. **Open log** shows the file. Passwords and master codes are never
written (the DKS session request is masked); the file still holds gate phone numbers, user names and recorder
serials, so `logs/` is in `.gitignore`.

## How data flows
```
gate ──pull──> gate_files 'pulled' ──Reset/refresh──> 'base' (what the gate holds)
                   │                     └──decode──> working copy as values: gate_residents, gate_cards,
                   │                                  gate_settings, gate_working (edited by every page)
                   └──round-trip check──> gate_state
base + values ──build──> files ──send──> gate ──verify pull──> base := what was sent when they match
```
- The pulled board files are kept in the database table `gate_files` (encrypted: `names.bin` holds the master
  code): the latest pull and the base copy (what the gate holds).
- The **working copy is values**: `gate_residents`, `gate_cards`, `gate_settings` and `gate_working` (the text the
  app shows; the master code left out). Its board files are built from the base copy plus these values whenever
  they're needed (to show, compare or send); bytes nothing decodes come from the base copy. A file's change map
  (1 byte per 128-byte block: 1 = changed, the `.map` a send uploads) compares the built file with the base.
- An edit runs on the built files as before, then is stored as values, but only if building from those values
  gives the same files byte for byte; otherwise it's refused and nothing is saved.
- After each residents pull (and each send's check pull) the **round-trip check** writes the pull's values back over
  a copy whose decoded bytes were overwritten first; it must come out byte for byte the same. The result is in
  `gate_state` and the job log; a gate whose base fails it is locked for editing. Details in [DB.md](docs/DB.md).
- The gate's `.bin` memory images are the source of truth. The desktop app's `.DAT` files are not used.
- Every edit (residents, settings, area codes, digits) changes only the **working copy**. Nothing reaches the
  gate until **Send**.
- A residents pull refreshes the working copy only if it has no saved edits. Otherwise it is kept, and
  **Reset to gate** (`DELETE .../working-copy`) starts again from the last pull.
- A send uploads the changed blocks, then pulls residents again. If the pull matches, the working copy becomes
  the new base; if not, the working copy is kept and the differing blocks are logged.
- One gate connection (pull or send) runs at a time across all gates.
- Transactions (`rcv_out.bin`) are read-only. A pull reads the gate's whole buffer (10,000 events, oldest
  overwritten first); the events after the part already saved are added to the transaction history
  (`tx_history`), which the Transactions page shows. The first time, the last pulled `rcv_out.bin` is imported.
  If a pull doesn't overlap the saved history at all, the job log says events may be missing (the buffer wrapped
  since the last pull, or it was cleared).
- A card transaction's Event Type is the Device Association name whose range holds the card number (blank when
  none does), as in DoorKing32.

## REST API
Every UI action goes through the REST API, so scripts can do anything the UI does. Routes, bodies, access levels
and error codes are in [`API.md`](docs/API.md).

## Command-line tool
`node cli.ts` prints usage. Read-only parsers for local files (`transactions`, `board`, `phones`, `cards`,
`directory`, `rcvout`; `--out <file>` writes CSV) and DKS Cloud commands (`cloud-login`, `cloud-status`,
`cloud-download`, `cloud-pull`) that read `DKS_USER`, `DKS_PASSWORD`, `DKS_MASTER_CODE`, `DKS_PHONE` and
`DKS_URL` from the environment.

## Tests
```
node --test
```
Suites: `board-files`, `gate-cache`, `relay-control`, `residents-edit`. Encodings are checked byte for byte
against changes observed on the gate. The database tests use the `doorking_test` PostgreSQL database
(`database.testName`, with `config.json`'s login; or `TEST_DATABASE_URL`), one throwaway schema per test (see [DB.md](docs/DB.md)).

## Security
- The server binds to `127.0.0.1` and checks the `Host` and `Origin` headers. Public access goes through an HTTPS
  reverse proxy (Caddy) and `server.publicHost` (config.json): that host and `https://<name>` origins are accepted, and the
  `sid` cookie gets `Secure` there (INSTALL.md section 6a).
- DKS Cloud is reached over **HTTPS** by default (`DEFAULT_URL` in `src/dks-cloud.ts`), so the DKS password and
  master codes are encrypted on the way. `DKS_URL` can override it.
- Sign-in: local accounts with scrypt password hashes; after 5 failed sign-ins for a username within 15 minutes,
  further tries are refused (429) for the rest of that time. A wrong username takes as long as a wrong password.
- Sessions: random tokens, stored only as SHA-256 hashes; idle sessions are removed every minute after 30 minutes
  without use. A user whose password was set by someone else reaches nothing but the password change until they
  choose their own.
- The first account needs the setup code printed in the server's console, so a fresh public install can't be
  claimed by a stranger. A gate is only added after a successful pull with its DKS login and master code.
- Each gate's DKS login and master code are encrypted with AES-256-GCM in the database; the key is `doorking.key`,
  so anyone with the key and the database (or a dump of it) can decrypt them. They are never sent to the browser or
  logged. Pull/send logs mask credentials. The debug log (all gates) is open only to users who are admin of a gate.
- API keys: 256-bit random secrets, stored only as SHA-256 hashes, limited to one gate and its role, never accepted
  on web-only routes; requests with an `Authorization` header never use a cookie session, so a browser page on
  another site can't use them (no CORS).
- Request bodies must be JSON objects of at most 10,000 bytes (413 otherwise). Files are served only by name
  patterns (`cacheFilePath`, `snapshotFile`), so paths can't leave the gate's folder; gate, schedule and history
  lookups are always scoped to the gate in the URL and the signed-in user's access to it (role checked per route).
- Master codes and recorder passwords are encrypted the same way. The recorder password goes to the bridge in
  an environment variable; ffmpeg gets it in its `rtsp://` URL on 127.0.0.1, which other programs running on
  the same PC can see in the process list. Tool output is masked before it is shown or stored.
- The browser stores only the remembered user name, never the password or master code.
- `GET /api/gates` never returns master codes; `GET .../settings` masks secret fields.
- The page may only load scripts from this server (Content-Security-Policy `default-src 'self'`); inline styles
  are allowed for the style element Radix dialogs add.

## Project layout
```
<root>/                  project root: the web app (run commands from here)
  README.md              technical overview (this file)
  docs/
    INSTALL.md, MANUAL.md  install guide, user manual
    API.md, DB.md          REST API, database schema
    BITMAP.md, HANDOFF.md  board file address map, reverse-engineering notes
  index.ts               re-exports every module in src/
  cli.ts                 command-line tool
  package.json           npm scripts and packages (TypeScript, React, Vite, Radix Themes)
  tsconfig.json          type check settings for the server code (tsc, no output)
  config.json            server settings incl. the database password (not in git; copy config.example.json)
  doorking.key           the encryption key (created on first start; not in git)
  logs/                  debug.log (only while Debug logs is on)
  src/
    config.ts            server settings: config.json + environment + flags, checked at startup
    types.ts             shapes shared by the server and the web page (types only)
    board-files.ts       parsers for names.bin / phone.bin / cards.bin / rcv_out.bin
    residents-edit.ts    resident/vendor edits on the board buffers (pure functions)
    gate-settings.ts     gate settings field table (offsets, encodings and text limits in names.bin)
    gate-cache.ts        board files in the database (gate_files): working copy, change maps, send preparation and verification
      gate-state.ts        plain gate tables decoded from each pull, and the round-trip check
    gate-pull.ts         DKS Cloud pull/send sessions, relay read/control
    dks-cloud.ts         DKS Cloud SOAP client
    db.ts                PostgreSQL connection (pg), schema, query helpers, AES-256-GCM encryption
    users.ts             local accounts (scrypt passwords) and sessions
    gate-list.ts         managed gates (DKS login, master code, encrypted), access roles, the move from DKS sign-in
    api-keys.ts          per-gate API keys (hashed), role and expiry
    prefs.ts             gate-scoped preferences, Device Association
    notes.ts             resident/vendor notes (database only, not on the gate)
    tx-history.ts        transaction history: merges each pulled rcv_out.bin into tx_history
    audit.ts             history log, sign-ins, revert patches
    schedules.ts         scheduled transfers (run with the gate's DKS login)
    cameras.ts           camera settings, the dahua-p2p bridge, ffmpeg pictures, videos and live view
    holidays.ts          fixed-date holiday names
    transactions.ts      reader for the desktop app's TRANSnnn.TRA files
    carchive.ts          MFC CArchive reader (used by transactions.ts)
    debug-log.ts         debug log file, on only while Debug logs is checked
    markdown.ts          renders docs/MANUAL.md as the /help page (small Markdown subset, all text escaped)
  web/
    server.ts            HTTP server: the built page, /help + REST API
    data.ts              shapes board files into UI rows (residents, transactions, schedules)
    ui/                  web page (React + Radix Themes, TypeScript), built by Vite: App, GateApp (sidebar),
                         panes/ (residents, transactions, history, schedules), settings/ (System pages),
                         camera/ (snapshots, viewer, live view), HelpTip.tsx + help.ts ("?" hover tips and
                         their texts)
    dist/                build output of ui/ (npm run build), served at /
  test/                  node --test suites
  tools/                 bin/ (Windows: dahua-p2p-x64.exe, dahua-p2p-arm64.exe; Linux: dahua-p2p-linux-<x64|arm64>;
                         optionally ffmpeg.exe / ffmpeg-linux-<x64|arm64>, not in git), licenses/ (keep with
                         the binaries)
  media/<phone>/         per-gate camera pictures and videos (snapshots/)
  research/              reference material (local only, not in git: DoorKing's copyrighted files): decompiled
                         DoorKing32 (DoorKing32.exe.c / .h), the 1835 manual PDF
```

