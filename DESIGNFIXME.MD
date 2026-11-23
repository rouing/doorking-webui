# Resident Portal Mobile Design Critique & Fixes

Actionable mobile-design audit of `web/ui/portal/ResidentPortal.tsx` (iOS Safari / standalone PWA & Android Chrome / standalone PWA, `320 pt`–`440 pt` portrait + `1280 px` desktop).

**Verdict:** Needs changes — fix all P1 items before rolling out to residents.

---

## P1 — Must Fix Before Rollout

- [ ] **Missing loading states & false empty state (`ResidentPortal.tsx:314, 444–446`)**
  - *Problem:* While `loadMe()` is in flight (`me === null`), the body below the tabs is blank; while `loadActivity()` is in flight (`activity === null`), the screen falsely renders *"No gate activity recorded for your unit yet."*
  - *Fix:* Track `loadingMe` and `loadingActivity` separately; render shaped skeleton placeholders while loading, keep existing rows visible during refresh, and show the empty state only when `activity !== null && activity.rows.length === 0` (with a **Retry** button on error).
- [ ] **No safe-area insets and no Back-button integration (`ResidentPortal.tsx:269–299`, `web/ui/styles.css`)**
  - *Problem:* Unlike `GateApp.tsx`, `ResidentPortal` has no `env(safe-area-inset-*)` padding and no `useBackLayer` handlers, so Android back exits the PWA instead of closing open dialogs or returning to the Gate tab, and content sits flush against the notch/home indicator.
  - *Fix:* Add top/bottom safe-area insets and wire `useBackLayer` for open dialogs (`reportRow`, `snapMinute`) and non-root tabs (`activity` / `account` → `gate`).
- [ ] **Primary navigation outside thumb reach & overloaded header (`ResidentPortal.tsx:271–312`)**
  - *Problem:* Top-mounted tabs below a 2-row header (`Admin view`, `Gates`, `Sign out`) push **Buzz Me In** and **My Gate Access** down and put destructive **Sign out** beside the title.
  - *Fix:* Move **Gate**, **Activity**, **Requests**, and **Account** into a fixed `56 px + env(safe-area-inset-bottom)` bottom tab bar (reusing the `PhoneTabBar` pattern from `web/ui/nav/PhoneNav.tsx`). Move **Sign out** into the **Account** tab, show **Gates** only when the user actually has `> 1` gate, and keep the top bar to community name + unit badge (+ **Admin view** when staff).
- [ ] **Request form buried below 80 activity rows, lacks validation/tel keyboard, prints raw enum keys (`ResidentPortal.tsx:504–536`)**
  - *Problem:* **Request a Change** sits underneath up to 80 activity rows, the phone input lacks `type="tel" inputMode="tel"`, empty submissions succeed, and past requests display raw enum keys (`cardIssue`, `hidden`, `phone`) at line `531`.
  - *Fix:* Promote **Requests** to its own tab (or top **Request change…** sheet button); add `type="tel" inputMode="tel"` and require a valid phone for `phone` requests (or non-empty note for `other`); map `kind` through a human label table (`Phone update`, `Directory listing`, `Lost remote / card`, `Other`).
- [ ] **Snapshot modal hardcodes `ch1.jpg`, lacks error/loading fallback, ignores video clips, unlabeled close buttons (`ResidentPortal.tsx:304, 323, 332, 582–597`)**
  - *Problem:* Missing `ch1.jpg` renders a broken image icon with no recovery; video-mode clips (`ch1.mp4`) cannot play; `IconButton` close/dismiss buttons lack `aria-label`.
  - *Fix:* Show a loading state + `onError` fallback (*"No photo was saved for this event"*), support `<video controls playsInline>` when an `.mp4` exists, and add `aria-label="Close"` / `aria-label="Dismiss"` to every `IconButton`.
- [ ] **Shared `busyAction` string overwrites unrelated buttons & weak cellular-buzz progress (`ResidentPortal.tsx:108–125, 355–363`)**
  - *Problem:* Clicking **Open Main Entrance Gate** changes the label of *every* entrance button and disables read-only actions without a spinner or step status.
  - *Fix:* Track per-action state (`buzzingRelay: number | null`, `rerolling: boolean`, `downloadingPdf: boolean`); keep the clicked button's label with an inline `<Spinner>` and clear phase text (`"Sending open command… (~5–10s)"`); keep read-only `Show`/`Copy` actions enabled.

---

## P2 — High-Impact UX Polish

- [ ] **Driveway-friendly Buzz confirmation (`ResidentPortal.tsx:109–115`)**
  - *Problem:* Centered modal confirmation on every gate open requires a second upper-screen reach while driving.
  - *Fix:* Replace centered dialog with a thumb-zone bottom confirmation sheet (or press-and-hold / slide-to-open with a visible tap-confirm fallback for switch/assistive-tech users).
- [ ] **Prominent entry code strip with tabular figures & auto-remask (`ResidentPortal.tsx:379–401`)**
  - *Problem:* Entry code (`#4827`) is inline at `size="3"` next to `size="1"` buttons and stays visible indefinitely once revealed.
  - *Fix:* Dedicated high-contrast strip with `fontVariantNumeric: 'tabular-nums'`, `24 px` bold digits, `44 px` touch targets on **Show/Hide** and **Copy**, and auto-mask after 30 seconds.
- [ ] **Plain resident-friendly copy (`ResidentPortal.tsx:128–155, 366, 421`)**
  - *Problem:* Internal/jargon labels (*"Reroll my gate code"*, *"cellular link"*, *"Press on phone to grant guest access"*).
  - *Fix:* Use **"Get a new gate code"** (*"Replaces your current code if it was shared or stolen"*), **"Opens the gate in about 5–10 seconds"**, **"Opened from app"** (with `Portal Open` badge), and **"Guest call key: Press 9 to open, # to deny"**.
- [ ] **Offline banner & cached read-only unit info (`ResidentPortal.tsx:69–104`)**
  - *Problem:* Opening the installed PWA in a garage dead zone hits a red error callout and hides unit info/management phone.
  - *Fix:* Cache non-sensitive unit info in `localStorage` with a timestamp, show an inline *"Offline — showing saved info from <time>"* banner, and disable only live network actions (**Open Gate**, **Get new code**).
- [ ] **Activity filters & last gate sync timestamp (`ResidentPortal.tsx:464–485`)**
  - *Problem:* Up to 80 flat rows with no filter and no indication of when gate transactions were last pulled (`tx_pulls`).
  - *Fix:* Add a compact filter (**All / Denied / App opens**) and display `"Last gate sync: <time>"` in the Activity header.

---

## P3 — Edge-Case Polish

- [ ] **Long resident names & many remotes on narrow `320 pt` / 200% text (`ResidentPortal.tsx:385–408`)**
  - *Fix:* Stack label-over-value below `360 px` and collapse `> 4` remote/card badges behind a `+N more` toggle.

---

## Scores & Audit Summary
- **Heuristics (Nielsen):** `24 / 40` (Needs improvement)
- **Trunk test (360 pt Gate tab):** `4 / 6` (Partial)
- **Strengths to keep:** Zero horizontal overflow down to `320 pt`, honest live `%` gate-busy progress bar, daily code-change limit + scheduled-send ETA + lock-screen-safe Push notifications, passkey/email-only auth (no SSO), and pre-filled `ResidentInstructions.pdf`.
- **Unverified checks to run after fixes:** Real iOS Safari standalone safe-area notch/home-indicator insets, VoiceOver/TalkBack traversal, WCAG AA contrast in dark mode at 200% system text scale, and real 8-second cellular Buzz latency on a phone.
