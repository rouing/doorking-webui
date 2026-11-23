# TODO

Open work, unverified hardware tests, planned 10x features, and backlog items.

## Planned next (10x roadmap — active plan)
- [x] **#11 Human-readable diff in "Send to Gate" dialog:** show the exact From → To summary of every unsent resident, card, and setting change inside the Send confirmation dialog (`GET /send` + `SendSummary`).
- [x] **#14 Floating US holidays auto-fill (year-aware):** compute floating US holidays (MLK Day, Presidents' Day, Memorial Day, Labor Day, Columbus Day, Thanksgiving, Day after Thanksgiving) for a chosen year in `src/holidays.ts` with one-click fill on the Holidays page.
- [x] **#12 Global quick-jump search (`Cmd/Ctrl+K`):** instant search modal across residents, vendors, cards, entry codes, phone numbers, notes, and recent transactions from anywhere inside an open gate.
- [x] **#6 Timed "Safe Hold-Open" relay auto-release:** "Hold open for 15m / 30m / 1h / Until time" option with persisted PostgreSQL timer (`relay_timers`), live countdown, automatic `SetRelays` release with retries, and failure alert.
- [x] **#15 Point-in-time pull archive & rollback:** keep the last N residents pulls in `gate_pull_archive` with compare and one-click restore to the working copy from History.
- [x] **#8 Access hygiene & "Ghost Card / Leaked Code" audit dashboard:** Insights/Audit page mining `tx_history` + `gate_residents` + `gate_cards` for dormant credentials (90/180/365d), active unassigned cards (with camera snapshots), high-frequency/leaked entry codes, and gate traffic/cycle counts.
- [x] **#9 Outbound webhooks & automation bridge:** per-gate HMAC-SHA256 signed webhooks backed by a retry outbox (`webhooks`, `webhook_deliveries`) firing on gate/transaction/relay/send/snapshot events.
- [x] **#10 Maker-checker (`editor` role) & bulk operations:** multi-select bulk actions on Residents/Vendors (bulk security level, disable, delete, CSV import preview) plus an `editor` role that can modify the working copy while `gate-admin` approves and sends to the gate.

## Later / Backlog (10x ideas for after the planned set)
- [ ] **#1 Auto-expiring visitor & contractor passes:** time-boxed guest/vendor entry codes auto-sent before start and auto-removed at expiry (requires live Send validation first).
- [ ] **#2 Multi-gate property fleet sync:** group gates into a Property, propagate resident/card/code changes across all panels, show fleet drift, and queue sends across gates.
- [ ] **#3 Property roster sync & Move-In / Move-Out turnover wizard:** diff external HOA/property CSVs against `gate_residents`/`gate_cards` and guide unit turnover (revoke outgoing tenant cards/codes, provision incoming).
- [ ] **#4 Local vision / ALPR sidecar on saved camera snapshots:** opt-in container indexing license plates, tailgating, and multi-plate card sharing linked to `tx_history`.
- [x] **#5 Resident self-service portal & "Buzz Me In" PWA:** `resident` role with email-only login (password or passkey, no SSO), multi-gate & existing-email binding, per-resident email + enable checkbox with full zero-residue turnover wipe (clears password, passkeys, push subs, sessions), fail-safe momentary "Buzz Me In" backed by `relay_timers` + live `%` busy status, synthetic `Portal Open` events in `portal_events` (keeping `tx_history` pure), daily-capped entry-code reroll with scheduled-send ETA & lock-screen-safe Push/Email notifications, own-unit activity/snapshots + **Report as suspicious** admin alerts, self-service change requests queue, and admin **Login audit log**.
- [ ] **#7 Gate health & security anomaly alerts:** alert via email/push/webhook on stuck hold-open, repeated denied attempts (with snapshot), consecutive pull failures / daytime silence, buffer wrap gaps, and out-of-band gate edits.
- [x] **#13 One-click safe entry code generator, welcome message & pre-filled `ResidentInstructions.pdf`:** generate non-colliding random 4-digit codes in `ResidentForm` (`generateSafeEntryCode`), copy formatted resident keypad instructions (`buildWelcomeMessage`), and download an auto-filled copy of `docs/ResidentInstructions.pdf` (`POST /residents/instructions.pdf` via `pdf-lib` with admin phone, Relay 0 grant-access digit, resident name, directory code, and 4-digit entry code).
- [ ] **#16 Backup health indicator & one-click encrypted backup export:** `node cli.ts backup` + UI status warning when backups are overdue (extends automated PostgreSQL backups below).

## Security & tests
- [ ] **Passkey step-up on live relay control:** add `PUT /api/gates/:phone/relays` to `STEP_UP` in `web/requests.ts` so holding a gate open requires a recent passkey confirmation (same as Send to gate).
- [ ] **Missing route & unit tests:**
  - Live relays (`GET` / `PUT /api/gates/:phone/relays`)
  - HTTP password reset and invitation acceptance flows
  - `POST /api/gates/:phone/delete-data` full cleanup verification (beyond the busy-refusal test)
  - Forced password change cleared for accounts linked to a `passwords: false` SSO provider
  - `recordGateState` rebuild check with master code
  - `doorKingCsv` export format

## Physical gate & hardware checks (unverified against a real gate)
- [ ] **First real Send to gate built from values:** test a small working-copy change end to end with a post-send verify pull.
- [ ] **Middle-entry pointer (`names.bin` `0xF8`):** live gate holds `0x141C` (entry 59) where `updateMiddlePointer()` computes `0x1430` (entry 60). Procedure: note the first name shown when browsing on the gate → hide/show one resident on the gate or in DoorKing32 → Pull residents → note the new first name and compare `0xF8` with the formula.
- [ ] **New / removed directory codes on a real gate:** confirm a send adding and removing a code matches on the subsequent pull.
- [ ] **Tracker relays 3–18 live switching:** verify `SetRelays` on expansion banks against a Tracker-equipped gate.
- [ ] **10 Area Codes resized send:** verify DKS Cloud accepts a `63104`-byte `names.bin` and check what layout a pull returns.
- [ ] **Master code containing `0`:** confirm `0x00` encoding against a real gate pull (`FUN_0045b490` writes `0x00`, newer firmware sends `AAAA`).
- [ ] **Read-only board settings:** confirm `dialType` (`0x0F`) and `multipleSystems` (`0x06`) via one-change diffs before making them editable; investigate unexplained bytes `0x13`–`0x14`, `0x37`, `0x43`, `0xC5`.
- [ ] **Dahua video mode edge cases:** test the gap-skip / resume path and browser H.265 playback across a full app snapshot run.

## Other platform roadmap items
- [x] **Web Push notifications** to installed apps (PWA) for failed sends, scheduled transfers, and timed relay releases (`push` VAPID config or auto-generated encrypted keys in `meta`, `push_subscriptions` table, `sw.ts` via `injectManifest`, Push notifications card in User Settings, `node cli.ts vapid-keys`).
- [x] **Single sign-on enhancements (code complete):**
  - [x] Count strong SSO logins toward step-up (`amr` MFA/hardware methods or configured `strongAcrs` + recent `auth_time`, persisted in `user_identities.last_claims`)
  - [x] Optional per-gate "strong sign-in required for admins" (`requireStrongAdmin` gate pref + Admin security toggle in System Settings)
  - [x] Optional Entra / Google group-to-gate-role mapping (`roleMap` on SSO providers) and an **SSO** badge in Gate users
  - [ ] Configure and test against a real Entra ID or Google Workspace tenant
- [ ] **Incremental transaction pulls:** send the last-read 12-byte marker instead of `ZERO_MARKER` so pulls fetch only new events rather than the full 10,000-event buffer.
- [ ] **Multi-channel live camera view:** handle queued streams on `dahua-p2p` (one stream at a time) so simultaneous viewers don't hit ffmpeg's 45 s open timeout.
- [ ] **Non-Cellular DKS communication types:** add `comType` option in `gateConfig` (currently hardcoded to `'DKS Cellular'`).
- [ ] **Automated PostgreSQL backups** (`pg_dump` + `doorking.key` rotation/offsite copy).

## Code cleanup (low priority)
- [ ] Split remaining large modules/components if they keep growing (`gatesRoutes`, `createSnapshots`, `createAuth`, large settings page components) and simplify remaining nested ternaries.
