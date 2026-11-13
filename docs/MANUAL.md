# DoorKing Gate Manager: user guide

DoorKing Gate Manager lets you look after your DoorKing telephone-entry gates from a web browser. It does the job of
the old DoorKing32 program ("DoorKing Account Manager"): you can see and change residents, vendors, entry codes,
cards and gate settings, read the list of who came and went, and open or hold the gate.

It talks to your gates through **DKS Cloud**, DoorKing's online service. You sign in to this app with your own
account; each gate's DKS Cloud login is saved once by its gate admin and used for everyone.

> **Only two things change the real gate straight away:** **Send to gate**, and the buttons under **Live relay
> control** on the Relays page. Everything else is a change on this computer only, until you send it.

Throughout the app, a small **?** next to a setting explains it in more detail: hold the mouse over it.

## Contents
1. [Quick start](#1-quick-start)
2. [Signing in](#2-signing-in)
3. [Your gates](#3-your-gates) (also gate users, roles and User Settings)
4. [How changes reach the gate](#4-how-changes-reach-the-gate)
5. [Getting data from the gate and sending changes](#5-getting-data-from-the-gate-and-sending-changes)
6. [Residents and vendors](#6-residents-and-vendors)
7. [Transactions](#7-transactions)
8. [Gate settings pages](#8-gate-settings-pages)
9. [History](#9-history)
10. [Scheduled transfers](#10-scheduled-transfers)
11. [System Settings](#11-system-settings)
12. [Cameras](#12-cameras)
13. [Words used in this guide](#13-words-used-in-this-guide)
14. [When something goes wrong](#14-when-something-goes-wrong)

## 1. Quick start

1. **Sign in** with the username and password a gate admin gave you. The first time, choose your own password.
2. Your gates are listed. **Open** one. (To add a new gate, see [Your gates](#3-your-gates).)
3. Click **Pull transactions** (bottom of the left-hand menu) to fetch the latest visits.
4. Make your changes, for example add a resident (gate admins only).
5. Click **Send to gate** to put your changes on the gate.

## 2. Signing in

Open the app in your browser at the address you were given (for example **https://gate.yourdomain.com**, or
**http://localhost:8080** on the computer it is installed on) and sign in with your **username and password**.
- Accounts are created by gate admins (see [Gate users and roles](#gate-users-and-roles)). There is no sign-up page.
- **The first time** you sign in with a password someone else set, the app asks you to choose your own (at least
  12 characters). Nobody else can see or change it.
- **Sign in with a passkey:** once you've added a passkey (see [User Settings](#user-settings)), click it and use your
  fingerprint, face or device PIN. No username or password needed. Your password keeps working too.
- **Sign in with your work account** (for example **Sign in with Microsoft** or **Sign in with Google**), if the server
  is set up for it: click the button and sign in at Microsoft or Google; you come straight back, signed in. It works
  once your work account is linked to your account here: through an invitation, by your work email if your
  organization is set up for that, or with **Link** in [User Settings](#user-settings). If it says there's no account
  for you, ask a gate admin to invite you.
- **Remember user** keeps only your username in this browser, never your password.
- You are signed out after **30 minutes** without activity, or when you click **Sign out**.
- After 5 wrong passwords in a row, sign-in for that username is paused for 15 minutes.
- **Forgot your password?** Click **Forgot your password?** on the sign-in page and enter your username or email. If your
  account has a confirmed email, you get a link (valid 1 hour, usable once) to choose a new one; you are then signed
  out everywhere. Without a confirmed email, ask the person who runs the server for a temporary password.
- **Invitation email:** if a gate admin invited you by email, open the link in it (valid 72 hours) and choose your
  password; you're signed in straight away. Or click **Accept with Microsoft** (or Google, …) instead, to sign in with
  your work account from then on, without a password.
- **Brand-new installation:** the very first visit asks to create the first account. It needs a **setup code** that
  the server prints in its log when it starts, so only the person running the server can do it. That first account
  becomes the admin of every gate already on the server.

## 3. Your gates

After signing in you see **your gates**: the gates you have access to, each marked **Admin** or **Read only**.
- **Open** a gate to work on it. **All gates** (top of the left-hand menu) takes you back to the list.
- **Leave** takes you off a gate. Its data stays for its other users. (A gate's last admin can't leave.)
- **Add a gate:** its system phone number, 4-digit master code, the **DKS user and password** that manage it, and
  its **gate configuration** (site name, memory, area codes, model, anti-passback, interface 1816; they must match
  the gate, ask your installer if unsure). The app checks the DKS login, then pulls the residents with these
  details. Only when that works is the gate added, with **you as its admin**. If something doesn't match, the
  message says what, and nothing is saved.
- If the gate is **already managed here**, you get a message to ask one of its gate admins to add you.

### Gate users and roles

Each person has one of two roles on each gate:

| Role | Can |
|---|---|
| **Admin** | everything: residents, settings, Send to gate, relays, schedules, cameras, the gate's login and its users |
| **Read only** | look at everything, pull from the gate, see camera pictures and the live view; can't change anything |

Gate admins manage people under **System Settings → Gate users**:
- **Create an account for this gate:** username, role and either
  - their **email** (and no password): they get an **invitation** email with a link to choose their own password
    (marked "invited" in the list until they do; **Send again** sends a new link), or
  - a **temporary password** (12+ characters): give it to them; they choose their own at their first sign-in.
  (Invitations need email to be set up on the server.)
- If the username **already exists**, the app says so and offers **Share this gate with them instead**.
- **Share with an existing account:** type their username and pick the role. This is how one person gets access to
  several gates, each with its own role.
- Change someone's **role**, or **Remove** them from the gate (their account stays).
- A gate always keeps **at least one admin**. Make someone else an admin before stepping down.
- Admins can't see or change anyone's password.

### User Settings

**User settings** (on the gate list, or under your name at the bottom of the left-hand menu) holds your own settings,
which follow you to any browser: **Dark mode**, your **email**, your **phone** number, **email notifications**,
**Single sign-on**, **Passkeys** and **changing your password** (asks for your current one, and signs you out everywhere
else).

**Email:** after you type a new address, the app sends it a **confirmation link** (valid 24 hours); it shows "check
your inbox" until you open it, and **Send the link again** if needed. Only a confirmed email is used. Each email can
belong to one account only. If you had a confirmed email, it is told about the change.

**Phone:** optional. Admins of your gates see it in their Gate users list, to reach you. Type a 10-digit US/Canada
number, or `+` and the country code for other countries; it's saved in international form (for example
+1 (214) 555-0100).

**Email notifications** (to your confirmed email):
- when you're given access to a gate, removed from one, or your role changes (you can turn this off);
- **gate alerts** for gates you're admin of: a Send to gate or a scheduled transfer failed (you can turn this off);
- security emails, always: your password was changed or reset, a passkey was added or removed, or a work account was
  linked or unlinked.

**Single sign-on** (when the server offers it) links your work account, so its button on the sign-in page signs you in:
- **Link Microsoft** (or Google, …): type your current password first (if your account has one), then sign in at the
  provider; you come back here with it linked. Your organization may only allow its own work accounts.
- **Unlink** removes it. You can't unlink your only way to sign in: add a passkey or link another account first.
- If your account was made through single sign-on, it has no password. To get one, use **Forgot your password?** on the
  sign-in page (it needs a confirmed email). Some organizations turn passwords off for work accounts: the Password card
  then says so.

**Passkeys** let you sign in with your fingerprint, face or device PIN instead of your password:
- **Add a passkey:** give it a name (such as "iPhone"), type your current password, click **Add a passkey** and follow
  your browser's prompt. Phones and password managers often sync passkeys to your other devices ("synced").
- A passkey works on the address you added it on (for example **https://gate.yourdomain.com**). Add another one if
  you also use a different address.
- **Rename** or **Remove** a passkey any time. If you lose a device, remove its passkey here (sign in with your password).

## 4. How changes reach the gate

The app keeps two versions of each gate's information on this computer:
- **what the gate has**, as of the last time you pulled from it (each pull updates it);
- **your working copy**, where all your changes go.

Your changes reach the gate only when you click **Send to gate**. Until then you can change your mind. Colours show
where each value stands:

| Colour | Meaning |
|---|---|
| **Blue** | changed on this page but not saved yet: click **Save to working copy**, or **Discard unsaved** to undo |
| **Green** | saved, but not on the gate yet: click **Send to gate** |
| No colour | the same as on the gate |

Hold the mouse over a value to see what the gate has. **Reset to gate** throws away every change you haven't sent, so
your working copy matches the gate again.

## 5. Getting data from the gate and sending changes

The buttons at the bottom of the left-hand menu talk to the gate:
- **Pull residents** fetches residents, vendors, cards and all gate settings.
- **Pull transactions** fetches the list of who came and went.

**Send to gate** (on the Residents page, and on the settings pages) first shows what will change and asks you to
confirm. After sending, the app fetches the residents again to check the gate really has your changes.

Talking to the gate takes a minute or more. A progress window in the bottom-right corner shows each step; you can
make it smaller, and **Show progress** brings it back. Only one gate can be contacted at a time; if someone else is
using the connection, wait for them to finish.

If you pull residents while you have changes you haven't sent, the app takes what's new at the gate and keeps your
changes on top of it. The progress window says how many of each.
- **Conflicts:** if someone changed the same thing at the gate (for example the same resident's phone, or a setting)
  and you changed it differently, a red box on the Residents page and the settings pages lists it, with what the gate
  has and what you have. Your change stays until you choose **Keep mine** or **Take the gate's**. Send to gate waits
  until every one is decided.
- **Big changes at the gate:** if the number of digits in directory codes or the area-code setting changed (at the gate
  or in your unsent changes), the app takes the gate's version and your unsent changes are dropped; the progress
  window says so.
- A change that no longer fits (for example an entry code the gate has given to someone else in the meantime) is left
  out and named in the progress window.

Use **Reset to gate** if you'd rather throw away your unsent changes and start again from what the gate has.

## 6. Residents and vendors

**Residents** and **Vendors** show everyone on the gate: directory code, name, hidden, phone, entry code, security
level, floor, elevator, cards and notes. (Vendors have no phone, floor or elevator.)
- **Security level** shows **Enabled** (level 1: the code or card always works), **Disabled** (level 0: it never
  works), or a level number 2–30 (it works at the times set on the Security Levels page).
- Type in **Filter** to find someone; click a column heading to sort; **Download CSV** saves the list as a
  spreadsheet file.
- **Click a row** to see that person's last 5 visits (green = let in, red = refused, with camera pictures if you have
  cameras) and to **Edit** them.

When adding or editing:

| Field | What to enter |
|---|---|
| Name | as it should appear on the gate's directory (up to 15 characters) |
| Phone | the number the gate calls: 7 digits, 10 with the area code, or 11 starting with 1 for long distance |
| Entry code | the code they type at the keypad. Two people can't share one. |
| Cards | their card or remote numbers (00001–65407). Two people can't share one. |
| Security level | Enabled, Disabled, or a level 2–30 |
| Floor, elevator reference | only for buildings with elevators |
| Hidden | leaves them out of the directory shown on the gate's screen |
| Notes | anything you want to remember (up to 500 characters). Notes stay on this computer and are never sent to the gate. Everyone who manages this gate here can see them. |

- **Delete** empties the entry but keeps its directory code free for someone else. **Remove code** takes the
  directory code off the gate completely.
- **Add resident / Add vendor** suggests free codes. Codes 000 and 001 aren't suggested: the gate gives them extra
  talk time, so keep them for the office or an emergency number.
- **Duplicates:** if two people share a **directory code**, an **entry code** or a **card/remote** (this can happen
  when another program changed the gate), a red message at the top lists them and marks them red. **Send to gate
  won't work until you fix them**, because the gate can't tell the two apart.

## 7. Transactions

The list of everything that happened at the gate, newest first: who came in, who was refused, and gate events. The
app keeps every transaction it has ever pulled, so old ones stay here even after the gate itself has forgotten them.
- Choose the last 24 hours, 7 days, 30 days or everything; filter; sort; **Download CSV**.
- **Green** rows were let in, **red** rows were refused, **amber** rows are gate events (for example a gate held open
  by its schedule).
- Click a name or number to jump to that resident or vendor.
- With cameras set up, a **Camera** column shows a picture of each visit (see [Cameras](#12-cameras)).

## 8. Gate settings pages

The pages under **System** in the left-hand menu change how the gate behaves. Like everything else, changes go to
your working copy first: click **Save to working copy**, then **Send to gate**. Most of these pages also have
**Clear**, which empties every box on the page (nothing is saved until you click Save).

### Display
The messages on the gate's screen. Pick **Single Line** or **8 Line** to match your gate's screen. Each box stops at
the most characters the gate can show.

### Relays
A **relay** is a switch in the gate's control box. Usually relay 1 opens the entry gate and relay 2 the exit; relay 0
can run something else, such as a door. Give each one a name so everyone knows which is which.
- **Live relay control** shows each relay as a button: green means held open, red means released. **Tapping a
  button changes the gate straight away** (it asks first). A held-open gate stays open until you release it.
- **Relay settings**: for each relay its **name** (typed straight into the table and saved when you click away; the
  name appears on the buttons), how many seconds it stays open (**strike time**), the keypad digits a resident can
  press during a call to open it (**tone to open**), an **entry code range**, and whether the postal switch or
  rotary dial 9 opens it.
- **Each tone-to-open digit can only be used once.** If the same digit is used twice, both boxes turn red and Save
  stays off until you change one.
- **Tracker** expansion boards (only if your installer fitted them) add relays 3–18. Turn Tracker on in System
  Settings, then tick the boxes on this page. The relay that controls the expansion board is then greyed out; use
  the extra relays instead.

### Hold Open
Times when the gate stays open by itself, for example during business hours: up to 7 time slots plus a holiday slot,
each with start and end times, days of the week, and which relays to hold open.

### Holidays
Up to 32 holiday dates: pick one from the list or type a date such as 12/25. **Holidays for Security Levels** makes
the 4th time zone of every security level the holiday time zone (it's then labelled **HOL**).

### Security Levels
Levels 2–30 decide **when** an entry code or card works. Each level has 4 time zones; each time zone has start and
end times, days of the week, which relays it may open and, in buildings with elevators, which floors. Give a resident
a level on the Residents page.

### Facility Codes
A card's facility code is a number shared by a batch of cards. Turn the check on and list up to 10 facility codes
(000–255) the gate should accept.

### Elevator Reference and Relay / Elevator
Only for buildings with elevators (hide them in System Settings if you have none). **Elevator Reference** sets, for
each of 8 references, which elevators a resident's visitors may use and how long the resident's floor button works.
**Relay / Elevator** sets which elevators each relay controls.

### Anti-Pass Back
Stops one card being used to let several people in: a card used to go **in** must be used to go **out** before it
works for **in** again. Choose the mode, which relays are "in" and "out", and the counter and re-sync options. It
only affects cards with security levels 2–27.

## 9. History

**History** (bottom of the left-hand menu) shows everything done to this gate, newest first, with who did it and when:
pulls, sends, relay buttons, changes to residents and settings, notes, camera settings, the gate's login and its users.
It also lists the gate's users and when each last signed in.
- Click an entry to see exactly what changed (before and after).
- **Revert** undoes a change in your working copy; it reaches the gate the next time you send. If a later change
  touched the same thing, revert that one first. Pulls, sends and relay buttons can't be reverted.

## 10. Scheduled transfers

**Scheduled Transfers** lets the app do jobs on its own, for example fetching transactions every night.
- Choose the days, a time (24-hour clock) and what to do: **Send working copy to gate**, **Pull residents**, **Pull
  transactions** and/or **Get camera snapshots**. Send is skipped when there's nothing to send.
- Schedules use the gate's DKS login (**System Settings → Gate login**), so they keep working whoever saved them.
- **Run now** does the job straight away. **Edit** and **Delete** change or remove it.
- The app must be running at the scheduled time. Each schedule shows how its last run went.

## 11. System Settings

Read-only users see the gate configuration and settings here, greyed out. Everything else on this page is for gate
admins.

### Gate login
The **DKS user and password** and the **master code** this gate's pulls, sends, relay buttons and schedules use, for
everyone. Leave the password or master code empty to keep the saved one. A new DKS login is checked with DKS Cloud
before it's saved; a new master code is checked by pulling the residents with it, and saved only when that works.
None of them is ever shown again.

### Gate users
See [Gate users and roles](#gate-users-and-roles).

### API keys
For connecting other systems or scripts (for example home automation) to this gate without a username and password.
- **Create API key:** give it a name (such as "Home Assistant"), a role (**Read only**: look and pull; **Admin**:
  also make changes and send) and when it expires (never, 30 or 90 days, or 1 year). The key is shown **once**:
  copy it straight away and keep it like a password.
- A key belongs to the gate, not to you: it keeps working if you leave. It only works on this gate, and it can never
  change the gate login, users or API keys, or delete the gate's data.
- The list shows when each key was last used. **Revoke** stops a key at once.
- Whoever sets up the other system needs the key and the address shown on the card. **API documentation** (the link
  on the card, or `/api/docs`) lists everything a key can do, and lets you try calls with the key.

### Gate configuration
These settings tell DKS Cloud what kind of gate it is talking to, so they **must match how the gate is set up**:
site name, system memory, area codes, model, anti-passback and interface 1816/1820. If one is wrong, pulls fail with a
message such as "Anti-Passback Mismatch"; fix the setting it names. Your installer can tell you the right values.
If the gate's last pull records a different system memory, or anti-pass back memory chips while Anti-passback is N
(or the other way round), a red note under the settings says so.
- **Tracker**: tick only if Tracker expansion boards are fitted (adds relays 3–18 on the Relays page).
- **Show on the page**: untick Floors or Elevators if your building has none, to hide those columns and pages.
- **Num of digits in dir code**: how many digits directory codes have (1–4). **Making it smaller deletes all
  residents**, so the app asks first.

### Gate settings
Talk time (how long a call to a resident can last, up to 4 minutes 14 seconds) and the digit the gate dials first to
get an outside line, if your phone line needs one. The master code is shown but can't be changed here.

These are read from the gate and shown for information; they can't be changed here:
- **Dial type**: Tone (almost every line) or Rotary.
- **Multiple systems**: Yes when more than one entry system shares the resident list.
- **System memory**: how many residents the gate's memory holds. It must match System memory under Gate configuration.
- **Memory chips**: Standard, MemPLUS or Anti-pass back, as the gate reports them.
- **Last download stamp 1 and 2**: when another program (for example DoorKing's own software) last sent data to the
  gate. Sending from this app keeps them as they are.

### Device association
Names for ranges of card numbers, for example "Residents 00001–00500". The name appears in the Transactions list for
card visits.

### Gate cameras
See [Cameras](#12-cameras).

### Debug logs
Leave this off unless someone supporting the app asks you to turn it on. It records detailed information to help
them find a problem. Turn it off again afterwards.

### Delete stored gate data
Deletes **everything this app has stored about the gate**, for everyone on this computer: the gate itself and
everyone's access to it (with its DKS login and master code), settings, notes, transaction history, History, schedules, camera settings and pictures, and any
changes not yet sent. It asks first and **can't be undone**. Nothing on the gate itself changes. Use it only when
the gate is no longer managed here.

## 12. Cameras

If a **Dahua or Amcrest video recorder** watches the gate, the app can save a picture (or a 2-minute video) of each
visit and show the cameras live.

**Setting up** (System Settings → **Gate cameras**): enter the recorder's serial number, user name and password (the
same ones as in the DMSS or SmartPSS app), and the camera channels to use. Click **Save camera settings**, then **Test
(live picture)** to check each camera shows a picture.

**Using it:**
- Pictures are fetched after each **Pull transactions**, when you click **Get camera snapshots** on the Transactions
  page, or by a schedule. **Stop snapshots** stops; the rest is fetched next time.
- The **Camera** column shows a picture of each visit; click it to see all pictures or the video. The ↻ button on a
  picture fetches it again.
- Gate events never get pictures: data transfers (**RS232**, **Modem**), the hold-open schedule (**Hold Begin** /
  **Hold End**), anti-pass back upkeep and the gate's hold/release commands. Their Camera column shows a dash. A
  momentary open by phone tone (**System**, **Admit**) still gets pictures, since someone was let in.
- The **camera button** at the top right of the page shows the cameras live.
- If the pictures are from the wrong moment, the recorder's clock differs from the gate's: change **Clock offset**.
- **Keep pictures** sets how long pictures and videos stay: 15, 30, 60 or 90 days, or **Forever**. Older ones are
  deleted automatically, and the visit then shows **Removed**. Videos are large (about 65 MB each), so with videos
  a limit is a good idea.

## 13. Words used in this guide

| Word | Meaning |
|---|---|
| **Pull** | fetch information from the gate |
| **Send** | put your changes on the gate |
| **Working copy** | your changes, kept on this computer until you send them |
| **Gate admin** | someone with the Admin role on a gate: can change it and manage its users |
| **DKS login** | the DKS Cloud user and password that manage a gate, saved once per gate by its admin |
| **API key** | a secret that lets another system use one gate, with its own role, without signing in |
| **Directory code** | the number a visitor enters on the gate's keypad to call a resident |
| **Entry code** | a private code a resident types to open the gate themselves |
| **Card / remote** | a card or transmitter that opens the gate; each has a number |
| **Relay** | a switch in the gate's control box that opens a gate, door or barrier |
| **Strike time** | how many seconds a relay stays open |
| **Tone to open** | the keypad digit a resident presses during a call to let the visitor in |
| **Security level** | when a resident's code or card works (Enabled = always, Disabled = never, 2–30 = at set times) |
| **Time zone** | a time window (start, end, days) inside a security level |
| **Hold open** | keeping the gate open for a period instead of opening it once |
| **Vendor** | a delivery company or contractor with an entry code but no phone listing |

## 14. When something goes wrong

| Message or problem | What to do |
|---|---|
| "Wrong username or password" | Check them. If you've forgotten your password, use **Forgot your password?** (needs a confirmed email), or ask the person who runs the server for a temporary one. |
| "This … link is invalid, used or expired" | Links work once and expire (confirmation 24 hours, reset 1 hour, invitation 72 hours). Ask for a new one. |
| No email arrives | Check spam. Make sure your email is confirmed (User Settings). If nothing ever arrives, tell the person who runs the server. |
| "Choose a new password first" | Your password was set by someone else; choose your own on the page shown. |
| "The passkey request was cancelled or timed out" | Try again and complete the fingerprint, face or PIN prompt. |
| "Passkey sign-in failed: this passkey is not registered here" | It was removed, or added on a different address. Sign in with your password. |
| "Passkeys work only at …" | Open the app at the address shown (passkeys need the site's proper name). |
| "There is no account for … here" after signing in with Microsoft/Google | Your work account isn't linked yet. Ask a gate admin to invite you, then use **Accept with …** in the invitation email. |
| "… can't sign in here: only accounts from … can" | Use your work account from the domain shown (not a personal one). |
| "This sign-in has expired or was already used" / "was started in another browser" | Click the sign-in button again and finish within 10 minutes in the same browser. |
| "… password sign-in is turned off for it" | Use the work account button (for example **Sign in with Microsoft**) instead of your password. |
| "Only a gate admin can do this" | Your access to this gate is read only. Ask a gate admin. |
| "This gate is already managed here" | Ask one of the gate's admins to add you to it. |
| "DKS Cloud refused that DKS user and password" | The gate's DKS login is wrong. Check it (gate admins: **System Settings → Gate login**). |
| "This gate has no DKS login yet" | A gate admin needs to set it under **System Settings → Gate login**. |
| "Too many failed sign-ins" | Wait 15 minutes, then try again. |
| A pull fails with "… Mismatch" | A Gate configuration setting doesn't match the gate. Fix the one named. |
| "A gate connection is already running" | Someone (or a schedule) is talking to a gate. Wait and try again. |
| Send to gate won't work | Read the red message: usually duplicates on the Residents page, or conflicts to decide (**Keep mine** or **Take the gate's**). |
| Save is greyed out on the Relays page | Two tones use the same digit; change one of the red boxes. |
| "This change can't be stored as gate values" | The app couldn't record that change safely, so nothing was saved. Tell the person who supports the app what you changed. |
| "Editing is locked for this gate" | The app found something in the gate's data it can't rebuild exactly, so it won't let changes through. Tell the person who supports the app. |
| Anything else | Ask the person who supports the app. They may ask you to turn on **Debug logs**. |