# Web UI Layout Audit & Refinement Plan (`web/ui/`)

Audit findings from codebase review and live Playwright visual inspection (`1280×900` desktop and `390×844` mobile) for eliminating unused trailing horizontal space on rows and streamlining **Gate Settings > System**.

---

## 1. Shared Foundation (`web/ui/panes/fields.tsx`, `SettingsBar.tsx`, `GroupPage.tsx`)

- [ ] **`Field` (`web/ui/panes/fields.tsx`):** Add optional `sx?: SxProps<Theme>` on the outer `Box` wrapper (plus `fullWidth` pass-through where needed) so any `<Field>` inside a horizontal `Stack` can cleanly stretch via `flex: '1 1 ...', minWidth: 0`.
- [ ] **`CardsEditor` (`web/ui/panes/fields.tsx`):** Change the card-number `TextField` from fixed `width: 150` to `flex: '1 1 160px', minWidth: 0` with `flexShrink: 0` on **Add device** and a right-aligned count caption.
- [ ] **`SettingInput` (`web/ui/settings/SettingsBar.tsx`):** Add optional `fullWidth?: boolean` so non-LCD inputs can expand inside full-width grids/cards while keeping fixed widths in `RelayTable` and character-measured widths for LCD fields.
- [ ] **`GroupPage` (`web/ui/settings/GroupPage.tsx`):** Remove `width: 'fit-content'` on the default `<TableContainer>` wrapper so non-`bare` pages (`Anti-Pass Back`, `Elevator Reference`, `Relay / Elevator`) span `100%` container width cleanly.

---

## 2. Streamline **Gate Settings > System** (`web/ui/settings/GateSettingsEditor.tsx`)

- [ ] **Remove redundant `"System"` header:** Suppress the `group` subheading when `view === 'prefs'` and `group === 'System'` (the enclosing **Gate settings** card header already labels it).
- [ ] **Compact layout for System fields (Master Code + surrounding settings):**
  - Replace the narrow `<FieldRows>` table for `System` with a compact, full-width responsive CSS grid (`gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' }`, `gap: 1`):
    - **Editable & key settings** (`Master code`, `Talk time (m:ss)`, `Outside line digit`): render as sleek horizontal mini-cards (`Paper variant="outlined"`, `px: 1.5, py: 1`) with label + `?` help tip on the left and compact input (or masked read-only pill for `Master code`) on the right.
    - **Read-only board info** (`Dial type`, `Multiple systems`, `System memory`, `Memory chips`, `Last download stamp 1`, `Last download stamp 2`): render in a tight 2/3-column grid of tinted pill-cards (`Paper elevation={0}`, `bgcolor: 'action.hover'`) showing concise label + value chip (preserving full `names.bin` offset hover tooltips and unsaved/pending highlights).
- [ ] **Display table (`view === 'display'`):** Remove `width: 'fit-content'` so the Display settings table stretches cleanly to `100%` width.

---

## 3. Eliminate Unused Trailing Horizontal Space Across All Pages

### Settings Cards (`web/ui/settings/`)
- [ ] **`GateAccess.tsx` — API key creation row (`ApiKeysCard`):** Expand the **Name** `Field` (`flex: '1 1 220px', minWidth: 0`, `fullWidth` `TextField`) alongside compact `Role`, `Expires`, and `flexShrink: 0` **Create API key** button.
- [ ] **`GateAccess.tsx` — Share with an existing account (`AddGateUserCard`):** Expand the **Username** `Field` (`flex: '1 1 220px', minWidth: 0`, `fullWidth` `TextField`) alongside `Role` and `flexShrink: 0` **Share** button.
- [ ] **`GateAccess.tsx` — Create an account grid (`AddGateUserCard`):** Add `alignItems: 'end'` so multi-line labels align evenly along the input baseline.
- [ ] **`GateConfig.tsx` — Directory code digits row:** Expand the `Num of digits in dir code` row (`Choice` + **Change digits** button) to fill the full card width cleanly (`flex: '1 1 200px', minWidth: 0` on the `Field`, `flexShrink: 0` on the button).
- [ ] **`LocalPrefs.tsx` (`DeviceAssociation`):** Remove the `maxWidth: 640` cap so the 10 device rows span `100%` of the card width (`Device name` already flexes).
- [ ] **`CameraForm.tsx` — Channels list:** Remove the `maxWidth: 540` cap on the camera channels list so channel rows span `100%` of the card width (`Channel name` already flexes).
- [ ] **`PortalAdminCards.tsx` (`ResidentPortalSettingsCard`):** Remove `maxWidth: 420` on the half-empty 2-column grid and pair `Max entry code rerolls per 24h` cleanly at full width (and align the `Pulse (sec)` row cleanly).
- [ ] **`Webhooks.tsx`:** Add `minWidth: 0` on the flexing `Name` / `URL` fields and `flexShrink: 0` on **Add webhook**.
- [ ] **`ListPages.tsx` (`HolidaysPage`, `FacilityPage`):** Remove `maxWidth: 680` / `maxWidth: 640` caps so every row fills `100%` of the available content width with even padding.
- [ ] **`SchedulePages.tsx` (`HoldOpenPage`, `SecurityPage`):** Remove `maxWidth: 680` caps so time-zone and hold-open cards fill `100%` width, and flex the `Floors` input (`flex: '1 1 11ch'`).
- [ ] **`RelaysDisplay.tsx` (`LiveRelays`):** Switch the live relay buttons row to a responsive CSS grid (`gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fit, minmax(220px, 1fr))' }`) so relay buttons fill the full card width evenly instead of leaving trailing blank space.

### Main Panes (`web/ui/panes/`)
- [ ] **`Directory.tsx`:** Give the `Filter rows` search `TextField` `flex: '1 1 220px', minWidth: 160`, right-align the row-count caption (`ml: { md: 'auto' }`), and set full message width on the bulk-selection `Alert` so **Delete selected** / **Clear** pin cleanly to the right.
- [ ] **`ResidentForm.tsx`:** Remove `maxWidth: 640` on the `Notes` textarea so it aligns flush with the 3-column field grid and portal box; harden `minWidth: 0` / `flexShrink: 0` on the `Entry code` + **Generate** row.
- [ ] **`Transactions.tsx`:** Give `Filter rows` `flex: '1 1 220px', minWidth: 160` and right-align the count + **Load older** group on wide viewports.
- [ ] **`Audit.tsx`:** Combine the **Access Insights** title with the period `Select` + **Refresh** controls on one `justifyContent: 'space-between'` header row (eliminating the nearly empty toolbar row).
- [ ] **`Schedules.tsx`:** Move `Enabled` to a `Switch` on the right of the form card header and arrange `Time`, `Days`, and `Transfers` in a clean full-width responsive grid.

### Account & Resident Portal (`web/ui/account/`, `web/ui/portal/`)
- [ ] **`UserSettings.tsx`:** Remove `maxWidth: 480` on the `Email` and `Phone` cards; place input (`flex: '1 1 240px', minWidth: 0`) + Save button (`flexShrink: 0`) cleanly across the full card width.
- [ ] **`passwords.tsx` (`PasswordForm`):** Remove `maxWidth: 360` (and lay out the 3 password fields in a 3-column grid on `md+` when rendered inside `UserSettings`, keeping single-column in narrow auth dialogs).
- [ ] **`Passkeys.tsx`:** Stretch the `Name`, optional `Approval code`, and optional `Current password` fields (`flex: '1 1 200px', minWidth: 0`) alongside `flexShrink: 0` **Add a passkey**.
- [ ] **`PushNotifications.tsx`:** Replace fixed `width: '14rem'` on `Device label` with `flex: '1 1 200px', minWidth: 0` alongside `flexShrink: 0` action buttons.
- [ ] **`SingleSignOn.tsx`:** Stretch the password `Field` (`flex: '1 1 220px', minWidth: 0`) alongside `flexShrink: 0` **Link** button(s).
- [ ] **`ResidentPortal.tsx`:** Stretch `My Gate Access` action buttons cleanly across the card width (full-width **Get a new gate code** above a 2-column grid for **Download Instructions PDF** and **Copy instructions**) and make **Send request to management** `fullWidth`.

---

## 4. Verification & Deployment Sequence

- [ ] Run `npm run typecheck`, `npm run build`, and `node --test`.
- [ ] Restart the live service (`sudo systemctl restart doorking`) and verify `systemctl is-active doorking`.
- [ ] Run Playwright visual verification on the live server (`http://localhost:8080`) across both desktop (`1280×900`) and mobile (`390×844`) viewports, visually inspecting the **after** screenshots for:
  - API keys creation row, Share account row, Resident Portal settings, Gate cameras channels, Device association
  - **Gate Settings** (confirming the `"System"` subheader is gone and Master Code + surrounding fields are compact, readable, and balanced)
  - Security Levels, Hold Open, Holidays, Facility Codes, Display, Live Relays, Directory, Transactions, Insights, and User Settings
  - Zero horizontal overflow on both desktop and mobile.
