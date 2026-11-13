# BITMAP — board file address map

Which bytes of the board files hold which setting. Offsets are hex. The source of truth is the code:
`src/gate-settings.ts` (the `FIELDS` list, names.bin settings), `src/board-files.ts` (file layouts) and
`src/residents-edit.ts` (directory writes). The `BAK\` snapshots named below were deleted on 2026-11-12.

- **Block:** the `.MAP` files flag changed 128-byte blocks, one byte per block. Block = offset ÷ 128 (offset `>> 7`).
- **Key:** the setting's key in `gate-settings.ts`; the page is where the app edits it.
- **Read-only:** decoded, shown (System Settings) and stored, but users can't change them; written back from the
  stored value, so sent exactly as pulled. Taken from the decompiled DoorKing32 (`research/`, 2026-11-13) and checked
  against a pull, not by one-change diffs.
- **Blank:** DoorKing32 writes `FF` (spaces in display text) here on every send and nothing reads it.
- **Unknown:** not decoded. Blank and unknown bytes before the directory that hold anything but their blank value are
  stored as raw bytes (`gate_working.extra`, DB.md) and written back, so they are sent exactly as pulled.
- **Samples:** the values in this gate's pull of 2026-11-13.

## Encodings

| Name | Bytes | Meaning |
|---|---|---|
| digit | 1 | `00`–`09`; `FF` = blank |
| tone | 1 | `01`–`09`; `FF` = none |
| BCD | 2 | packed decimal, e.g. `12 34` = 1234; `F` nibbles pad; `FF FF` = blank |
| BE16 | 2 | 16-bit big-endian number; `FF FF` = blank |
| on/off | 1 | `00` = on, `FF` = off |
| digit flag | 1 | `01` = on, `0A` = off (written like a digit, `0A` = 0) |
| Unix time | 4 | seconds since 1970-01-01 UTC, little-endian; `FF FF FF FF` = none |
| time | 2 | hour byte (`80` = set, `+20` = PM, low 5 bits = BCD hour 1–12), then BCD minute; `FF` hour = unset |
| day mask | 1 | bit 7 = Sun … bit 1 = Sat; `FF` = not set (kept apart from `00`, no days) |
| bit mask | 1 | bit *n* = relay *n* (postal/rotary), elevator *n*+1, or hold-open row *n*+1 (bit 7 = Hol) |
| text | n | ASCII, space padded |

## names.bin (64000 bytes; 63104 in 10-area-code mode)

### Header and settings

| Offset | Size | Setting | Encoding | Key / page | Notes |
|---|---|---|---|---|---|
| `000`–`003` | 4 | Master code | one digit per byte, `00` = 0 | `masterCode` / System Settings (read-only) | written from the master code saved with the gate's login (`managed_gates`), not copied from the pull. `00` = 0 is what DoorKing32's send builders write (character − `'0'`) and its receive check expects; the app also reads `0A` as 0 |
| `004` | 1 | Relay 1 strike time (s) | byte | `relay1Time` / Relays | `00` while Tracker 1 is ticked |
| `005` | 1 | Relay 2 strike time (s) | byte | `relay2Time` / Relays | `00` while Tracker 2 is ticked |
| `006` | 1 | Multiple systems | `01` = yes, `0A` = no (digit-style flag) | `multipleSystems` / System Settings (read-only) | System Information checkbox (account record `+0x118`); name from the manual's list; samples `0A` |
| `007`–`00A` | 4 | Relay 1 tones: Momentary, Hold, Release, Hold 1 Hr | tone | `relay1Tone…` / Relays | |
| `00B`–`00E` | 4 | Relay 2 tones | tone | `relay2Tone…` / Relays | |
| `00F` | 1 | Dial type | `01` = Rotary, `0A` = Tone | `dialType` / System Settings (read-only) | labelled "Dial Type:" in DoorKing32's settings report; samples `0A` |
| `010` | 1 | Talk time | seconds, `FF` = unset (shown m:ss) | `talkTime` / System Settings | |
| `011` | 1 | Relay 0 strike time (s) | byte | `relay0Time` / Relays | |
| `012` | 1 | blank (`FF`) | | | |
| `013`–`014` | 2 | unknown | | | DoorKing32 also writes relay 1's entry code range To here (BCD), but samples hold `FF FF` while that range is 0000–9999 |
| `015`–`018` | 4 | Last download stamp 1 | Unix time, little-endian | `downloadStamp1` / System Settings (read-only) | written by the program that last sent; on a receive DoorKing32 compares it with its own copy and, if different, switches to "Send All Data because another PC has downloaded to this System"; samples 2026-11-05 17:40:00 UTC |
| `019`–`01C` | 4 | Last download stamp 2 | Unix time, little-endian | `downloadStamp2` / System Settings (read-only) | compared the same way; samples 5 seconds after stamp 1 |
| `01D` | 1 | Outside line digit | digit | `outsideLineDigit` / System Settings | confirmed with 9, 0, blank |
| `01E`–`031` | 20 | Facility codes 1–10 | BE16 each (0–255) | `facilityCode1`–`10` / Facility Codes | |
| `032` | 1 | Facility codes enabled | on/off | `facilityEnabled` / Facility Codes | |
| `033`–`03F` | 13 | blank (`FF`), except `037` | | | `037` is unknown: `01` in samples, though DoorKing32 writes `FF` |
| `040` | 1 | Num of digits in dir code | `01`–`04` | System Settings → Gate configuration | |
| `041` | 1 | Postal switch activates relays | bit mask (relay) | `relayPostalSwitch` / Relays | confirmed relays 0, 1 (`tracker5`) |
| `042` | 1 | Rotary dial 9 activates relays | bit mask (relay) | `relayRotaryDial9` / Relays | confirmed relays 0, 1 (`tracker6`) |
| `043` | 1 | unknown | | | DoorKing32 writes `FF` (both modes); `01` in samples |
| `044`–`057` | 20 | Area-code table, **10-area-code mode only** (10 × BCD) | BCD | Residents (phone area codes) | `FF` in 255 mode |
| `058`–`05B` | 4 | Relay 0 tones | tone | `relay0Tone…` / Relays | |
| `05C`–`06E` | 19 | Hold Open relays 0–18 (`05C` + relay) | bit mask (row) | `holdOpenRelay0`–`18` / Hold Open | confirmed relay 5 row 1 (`trk_relays_3_18`) |
| `06F`–`096` | 40 | Hold Open rows 1–7 + Hol, 5 bytes each (`06F` + row × 5) | time begin, time end, day mask | `holdOpen{1–7,Hol}{Begin,End,Days}` / Hold Open | |
| `097`–`09E` | 8 | Elevator Reference ER1–ER8 floor-button time (s) | byte, `FF` = unset | `elevator{1–8}Time` / Elevator Reference | |
| `09F`–`0AB` | 13 | blank (`FF`) | | | |
| `0AC`–`0AF` | 4 | Relay 0 entry code range From, To | BCD, BCD | `relay0EntryCodeRange{From,To}` / Relays | confirmed (`tracker7`) |
| `0B0`–`0B3` | 4 | Relay 1 entry code range | BCD, BCD | `relay1EntryCodeRange…` / Relays | |
| `0B4`–`0B7` | 4 | Relay 2 entry code range | BCD, BCD | `relay2EntryCodeRange…` / Relays | confirmed (`tracker8`) |
| `0B8`–`0BE` | 7 | blank (`FF`) | | | |
| `0BF`–`0C4` | 6 | System memory | 24-bit BE end of the directory area (`F80` + memory × 20), then of `phone.bin` (`10D80` + memory × 10) | `systemMemory` / System Settings (read-only) | written from the account's system memory, not the directory size; samples `00F9E0 0182B0` = 3000 |
| `0C5` | 1 | unknown | | | never written by DoorKing32; `FF` in samples |
| `0C6`–`0CD` | 8 | Elevator Reference ER1–ER8 elevators | bit mask (elevator) | `elevator{1–8}Elevators` / Elevator Reference | |
| `0CE`–`0F6` | 41 | blank (`FF`) | | | |
| `0F7` | 1 | Relay / Elevator: relay 0 | bit mask (elevator) | `relay0Elevators` / Relay / Elevator | confirmed (`elev3_relay0_elev1`) |
| `0F8`–`0FA` | 3 | Middle shown directory entry pointer | 24-bit BE offset, counted from `F80` in both modes | written on save (`residents-edit.ts`) | browsing the directory on the gate starts here |
| `0FB` | 1 | Memory chips (reported by the gate) | `00` Standard, `01` MemPLUS, `05` anti-pass back | `memoryChips` / System Settings (read-only) | DoorKing32 writes its MemPLUS choice (0/1) on a send; on a receive (block 1, byte `7B`) it requires `05` for an anti-pass back account and refuses a mismatch ("MemPLUS ENABLE ERROR", "…does not have Anti Pass Back memory chips installed"); samples `05` |
| `0FC`–`0FF` | 4 | blank (`FF`) | | | |

### Display

| Offset | Size | Setting | Encoding | Key / page |
|---|---|---|---|---|
| `100`–`113` | 20 | blank (spaces) | | |
| `114`–`143` | 48 | System message (single-line display), up to 27 characters | text, padded to 48 | `systemMessage` / Display |
| `144` | 1 | blank (space) | | |
| `145`–`178` | 52 | System instruction (single-line display) | text | `systemInstruction` / Display |
| `179`–`18C` | 20 | blank (spaces) | | |
| `18D`–`18F` | 3 | blank (`FF`) | | |
| `190`–`22F` | 160 | 8-line display: User message 1–4, Instructions 1–4 (20 each) | text | `displayLine1`–`8` / Display |

### Relay / Elevator, Security Levels, Holidays, Anti-Pass Back

| Offset | Size | Setting | Encoding | Key / page | Notes |
|---|---|---|---|---|---|
| `230` | 1 | not part of the Relay / Elevator table | | never written | `FF` in samples |
| `231`–`242` | 18 | Relay / Elevator: relays 1–18 (`230` + relay) | bit mask (elevator) | `relay1Elevators`–`relay18Elevators` / Relay / Elevator | confirmed relays 2, 5 |
| `243`–`982` | 1856 | Security Levels: 116 records × 16 (levels 02–30 × TZ1–4) | see below | `sec{L}tz{T}…` / Security Levels | |
| `983`–`9C2` | 64 | blank (`FF`) | | | |
| `9C3`–`A02` | 64 | Holidays 1–32 (`9C3` + row × 2) | BCD month, BCD day | `holiday1`–`32` / Holidays | names are not on the gate |
| `A03` | 1 | Holidays for Security Levels | on/off | `holidaysForSecurity` / Holidays | confirmed (`hol1_holidays_for_sl`) |
| `A04` | 1 | True Anti Passback mode | `FF` Off, `01` Passive, `02` Active, `03` Trap | `apbMode` / Anti-Pass Back | |
| `A05`–`A0E` | 10 | APB Relays In | up to 10 relay numbers, sorted, `FF` = empty | `apbRelaysIn` / Anti-Pass Back | relay 12 confirmed |
| `A0F`–`A18` | 10 | APB Relays Out | same | `apbRelaysOut` / Anti-Pass Back | |
| `A19` | 1 | Record Facility Counter Every | `FF` Off, `01` 15 Mins, `02` 30 Mins, `03` Hour | `apbCounterEvery` / Anti-Pass Back | |
| `A1A`–`A28` | 15 | blank (`FF`) | | | |
| `A29`–`A2A` | 2 | Reset Facility Counter to | BE16 | `apbCounterReset` / Anti-Pass Back | |
| `A2B` | 1 | Re-Sync All Devices | on/off | `apbResyncAll` / Anti-Pass Back | |
| `A2C`–`A36` | 11 | Re-Sync List | `00` = on (`FF` = off), then 5 × BE16 (`0000` = empty box) | `apbResyncList` / Anti-Pass Back | |
| `A37` | 1 | Enable Scheduled Re-Sync All | on/off | `apbScheduleEnabled` / Anti-Pass Back | |
| `A38`–`A3E` | 7 | Scheduled Re-Sync All days | Sat … Sun; ticked day holds 7 − day (Sun = 0), else `FF` | `apbScheduleDays` / Anti-Pass Back | |
| `A3F`–`A40` | 2 | Scheduled Re-Sync All time | time | `apbScheduleTime` / Anti-Pass Back | |

**Security Levels record.** Record *i* = (level − 2) × 4 + (TZ − 1), at `243` + *i* × 16 (L02 TZ1 = `243`,
L30 TZ4 = `973`). An all-`FF` record is unused.

| Record byte | Size | Field | Encoding | Notes |
|---|---|---|---|---|
| +0 | 2 | Begin | time | |
| +2 | 2 | End | time | |
| +4 | 1 | Days | day mask | |
| +5 | 3 | Relays 0–18 | 24-bit BE, relay *r* = bit *r* + 5 | confirmed relays 0, 1, 7, 18 |
| +8 | 8 | Floors 1–64 | floor *f* = record byte 15 − ((*f* − 1) ÷ 8), bit (*f* − 1) mod 8 | confirmed floors 1–8 |

With Holidays for Security Levels on (`A03`), TZ4 of every level is the Holiday time zone.

### Area codes and directory

| Offset (255 mode) | Offset (10 mode) | Size | Content |
|---|---|---|---|
| `A41`–`C3E` | `044`–`057` | 255 / 10 × 2 | Area-code table, BCD (F-padded); phone.bin's area-code index picks the entry |
| `C3F`–`F7F` | `A41`–`BFF` | 833 / 447 | blank (`FF`): between the area-code table and the directory |
| `F80`– | `C00`– | 20 per entry | Directory, A–Z |

Switching modes moves the table and the directory and changes the file length by `0x380`. The middle pointer
(`0F8`) still counts from `F80`.

**Directory entry (20 bytes)**

| Byte | Size | Field | Encoding |
|---|---|---|---|
| 0–14 | 15 | Name | text |
| 15 | 1 | Flag | bit 0 = vendor, bit 5 = shown in directory (clear = hidden); `00` = empty slot |
| 16–19 | 4 | Directory code | ASCII digits, right-justified, space padded (length from `040`) |

The directory ends at the first entry without a valid code; free space after it is `FF`.

## phone.bin (10 bytes per directory code)

| Byte | Size | Field | Encoding |
|---|---|---|---|
| 0–1 | 2 | Directory code | BCD, F-padded; `FF FF` = unused record |
| 2 | 1 | Area-code index (255 mode) | `FF` = none |
| 3–5 | 3 | Phone number, 7 digits (255 mode) | 24-bit BE; `FF FF FF` = none |
| 2–5 | 4 | 10 mode instead: high nibble of byte 2 = area-code index (`F` = none), then 7 BCD digits | |
| 6–7 | 2 | Entry code | BCD; `FF FF` = none |
| 8 | 1 | Security level (bits 0–4, 0–30) and Elevator reference (bits 5–7, stored 0–7, shown 1–8) | packed |
| 9 | 1 | Floor | byte; `FF` = unset |

Hidden lives in names.bin (directory flag), not here.

## cards.bin (4 bytes per card)

| Byte | Size | Field | Encoding |
|---|---|---|---|
| 0–1 | 2 | Card number | BE16 |
| 2–3 | 2 | Directory code | BCD, F-padded |

An all-`FF` record is unused.

## rcv_out.bin (transactions, read only)

10,000 records of 10 bytes (a ring buffer), then a 6-byte trailer: byte 0 = `99` when the buffer has wrapped,
bytes 3–5 = next write address (`A0000` + index × 10).

| Byte | Size | Field | Encoding |
|---|---|---|---|
| 0 | 1 | Month | BCD |
| 1 | 1 | Day | BCD |
| 2 | 1 | Hour | bit 6 = admit (clear = deny), bits 7–6 = event flags, bit 5 = PM, bits 4–0 = BCD hour |
| 3 | 1 | Minute | BCD |
| 4 | 1 | Event type | `00` Directory, `01` Entry Code, `02` Card, `04` Open Request, … (`decodeRcvEvent`) |
| 5–6 | 2 | Number | BCD (codes) or BE16 (cards) |
| 7 | 1 | Relay | `12` = relay 0, `00` = relay 1, `01` = relay 2, `FC`–`FF` = combinations |
| 8–9 | 2 | blank | `FF FF`; DoorKing32's decoder reads bytes 0–7 only (`FF FF` in all 13,833 sample records) |

The board stores no year; it is inferred when the file is read.

## Not on the gate

DoorKing32 keeps these in `ACCOUNT.DAT` only; one-change diffs left every board file unchanged. The app keeps
them in its own database (or uses a built-in list), never in the board files.

| Setting | ACCOUNT.DAT | In the app |
|---|---|---|
| Tracker | `312` | System Settings → Tracker |
| Additional Relays For Tracker 1 / Tracker 2 | `449` / `44A` | Relays page |
| Interface with 1816/1820 | `31F` | Gate configuration; sent as the `Interface1816` cloud session parameter |
| Relay names 0–18 | — | System Settings → Relay names |
| Holiday names | ~`1982` | built-in list |
| Device association | `CDeviceRecord` | System Settings → Device association |

DoorKing32 also mirrors some gate settings in `ACCOUNT.DAT`, for example relay 0 postal switch `127`, relay 0
rotary dial 9 `12A`, Relay / Elevator table `180E` (19 bytes) and Holidays for Security Levels `197E`. The gate
uses the names.bin bytes.
