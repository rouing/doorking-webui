// Board memory images exchanged with DKS Cloud (names.bin, phone.bin, cards.bin, rcv_out.bin)
// and their .MAP change flags (one byte per 128-byte block, 1 = block changed).
import type { ResidentRow } from './types.ts';

export interface NamesLayout { areaCodeMode: 255 | 10; areaCodeOffset: number; areaCodeSlots: number; directoryOffset: number }
export interface PhoneFields { areaCodeIndex: number | null; phone: string | null }
export interface PhoneEntry {
  recordOffset: number; directoryCode: string | null; areaCodeIndex: number | null; phone: string | null;
  entryCode: string | null; securityLevel: number; elevatorRef: number; floor: number | null;
}
export type ResidentsData = { rows: ResidentRow[]; unassignedCards: string[] };
export interface CardEntry { cardNumber: string; directoryCode: string | null }
export interface DirectoryEntry { entryOffset: number; directoryCode: string; name: string; flag: number; vendor: boolean; hidden: boolean }
export interface RcvRecord {
  month: number; day: number; hour: number; minute: number; pm: boolean; eventFlags: number;
  codeType: number; code: string | null; raw: string; year?: number;
}
export interface RcvEvent {
  eventType: string; number: string | null; name: string; access: string; relay: string; apb: string;
  lookup: 'directory' | 'entryCode' | 'card' | null;
}

const BLOCK_SIZE = 128;
const NAMES_ENTRY_SIZE = 20;
// names.bin layout depends on the gate's "Area codes" setting (DoorKing32 snapshots, 255 vs 10):
//   255: area-code table at 0xA41 (255 entries), directory at 0xF80.
//   10:  area-code table at 0x44 (10 entries), directory at 0xC00; the file is 0x380 bytes shorter.
// The middle-entry pointer (0xF8) always counts as if the directory started at 0xF80.
export const NAMES_LAYOUTS: Record<255 | 10, NamesLayout> = {
  255: { areaCodeMode: 255, areaCodeOffset: 0xa41, areaCodeSlots: 255, directoryOffset: 0xf80 },
  10: { areaCodeMode: 10, areaCodeOffset: 0x44, areaCodeSlots: 10, directoryOffset: 0xc00 },
};
const NAMES_10_LENGTH = 63104; // DoorKing32 names.bin in 10-area-code mode (64000 in 255 mode)

// "Num of Digits in Dir Code" (1-4, per the DoorKing manual) at names.bin 0x40. The entry's code field (bytes
// 16-19) holds the code right-justified and space padded ("   5", "  12", " 701", "1701"); phone.bin/cards.bin hold
// it as F-padded BCD. 1 and 2 digits are not yet checked against DoorKing32 snapshots.
export const NAMES_DIR_DIGITS_OFFSET = 0x40;
export const namesDirDigits = (buf: Buffer): number => ([1, 2, 3, 4].includes(buf[NAMES_DIR_DIGITS_OFFSET]) ? buf[NAMES_DIR_DIGITS_OFFSET] : 3);

// Directory code of the entry at o, or null when o is not a directory entry.
export function namesEntryCode(buf: Buffer, o: number): string | null {
  if (o + NAMES_ENTRY_SIZE > buf.length) return null;
  const m = /^ {0,3}(\d{1,4})$/.exec(buf.toString('latin1', o + 16, o + 20));
  return m ? m[1] : null;
}

export const isNamesEntryAt = (buf: Buffer, o: number): boolean => namesEntryCode(buf, o) !== null;

// Layout of a names.bin: from where the directory starts, else (empty directory) from the file length.
export function namesLayout(buf: Buffer): NamesLayout {
  if (isNamesEntryAt(buf, NAMES_LAYOUTS[255].directoryOffset)) return NAMES_LAYOUTS[255];
  if (isNamesEntryAt(buf, NAMES_LAYOUTS[10].directoryOffset)) return NAMES_LAYOUTS[10];
  return buf.length === NAMES_10_LENGTH ? NAMES_LAYOUTS[10] : NAMES_LAYOUTS[255];
}

// phone.bin bytes 2-5 (area-code index + 7-digit local number).
//   255 mode: byte 2 = index (0xFF = none), bytes 3-5 = number as 24-bit big-endian (0xFFFFFF = none).
//   10 mode: high nibble of byte 2 = index (0xF = none), then the 7 digits as BCD (all 0xF = none).
export function readPhoneFields(rec: Buffer, areaCodeMode = 255): PhoneFields {
  if (areaCodeMode === 10) {
    const hex = rec.subarray(2, 6).toString('hex');
    return {
      areaCodeIndex: hex[0] === 'f' ? null : parseInt(hex[0], 16),
      phone: /^f+$/.test(hex.slice(1)) ? null : hex.slice(1),
    };
  }
  const phoneBytes = rec.subarray(3, 6);
  return {
    areaCodeIndex: rec[2] === 0xff ? null : rec[2],
    phone: allFF(phoneBytes) ? null : String(phoneBytes.readUIntBE(0, 3)).padStart(7, '0'),
  };
}

// Writes bytes 2-5 of the phone record at offset o. phone = up to 7 digits or null.
export function writePhoneFields(
  buf: Buffer, o: number,
  { areaCodeIndex, phone }: { areaCodeIndex?: number | null; phone?: string | number | null },
  areaCodeMode = 255,
): void {
  if (areaCodeMode === 10) {
    if (areaCodeIndex != null && !(areaCodeIndex >= 0 && areaCodeIndex <= 9)) throw new Error(`Area-code index ${areaCodeIndex} does not fit 10-area-code mode`);
    const hex = (areaCodeIndex == null ? 'f' : String(areaCodeIndex)) + (phone == null ? 'fffffff' : String(phone).padStart(7, '0'));
    Buffer.from(hex, 'hex').copy(buf, o + 2);
    return;
  }
  buf[o + 2] = areaCodeIndex == null ? 0xff : areaCodeIndex;
  if (phone == null) buf.fill(0xff, o + 3, o + 6);
  else buf.writeUIntBE(Number(phone), o + 3, 3);
}
const NAMES_DISPLAY_LINES_OFFSET = 0x190; // user message 1-4, instructions 1-4 (matches ACCOUNT.DAT)
const NAMES_DISPLAY_LINE_COUNT = 8;
const NAMES_DISPLAY_LINE_SIZE = 20;

// Security level time zones: 16 bytes each, levels 02-30 x TZ1-TZ4, in level order. Confirmed: begin and end
// time (hour byte: 0x80 = set, 0x20 = PM, low 5 bits = BCD hour; BCD minute byte), 0xFF hour = not set.
// Byte 4 = days; bytes 5-7 = relays; bytes 8-15 = floors (all confirmed against ACCOUNT.DAT, see helpers below).
const NAMES_SECURITY_OFFSET = 0x243;
const NAMES_SECURITY_RECORDS = 29 * 4;
const NAMES_SECURITY_RECORD_SIZE = 16;
// Holidays: 32 rows, month and day in packed decimal, 0xFF 0xFF = not set. Holiday NAMES are not stored
// in names.bin (gate only keeps month/day); the names live only in ACCOUNT.DAT / our own records.
const NAMES_HOLIDAY_OFFSET = 0x9c3;
const NAMES_HOLIDAY_ROWS = 32;

function namesTime(h: number, m: number): string {
  if (h === 0xff) return '';
  const hour = bcd([h & 0x1f]);
  const minute = bcd([m]);
  if (!(h & 0x80) || hour === null || minute === null) return `? (${h.toString(16)} ${m.toString(16)})`;
  return `${hour}:${minute} ${h & 0x20 ? 'PM' : 'AM'}`;
}

// Day-of-week flags used by both hold-open and security time zones: day d (0=Sun..6=Sat) is bit (7-d),
// i.e. bit7=Sun .. bit1=Sat (the reverse of ACCOUNT.DAT's array). Confirmed byte-for-byte.
function namesDayFlags(byte: number): boolean[] {
  return Array.from({ length: 7 }, (_, d) => Boolean(byte & (1 << (7 - d))));
}

// Security relays: 24-bit big-endian field over bytes 5-7, relay r (0..18) at bit (r+5). Confirmed for
// relays 0, 1, 7 and 18; the linear pattern covers the rest.
function namesSecurityRelays(buf: Buffer, o: number): number[] {
  const v = (buf[o + 5] << 16) | (buf[o + 6] << 8) | buf[o + 7];
  const relays: number[] = [];
  for (let r = 0; r <= 18; r++) if (v & (1 << (r + 5))) relays.push(r);
  return relays;
}

// Security floors: bytes 8-15, floor f at byte (15 - floor((f-1)/8)), bit ((f-1)%8). Confirmed for floors 1-8
// (byte 15); the higher bytes extend the same scheme to floor 64 but are not yet sampled.
function namesSecurityFloors(buf: Buffer, o: number): number[] {
  const floors: number[] = [];
  for (let f = 1; f <= 64; f++) {
    if (buf[o + 15 - ((f - 1) >> 3)] & (1 << ((f - 1) & 7))) floors.push(f);
  }
  return floors;
}

function parseNamesSecurityTimes(buf: Buffer) {
  if (buf.length < NAMES_SECURITY_OFFSET + NAMES_SECURITY_RECORDS * NAMES_SECURITY_RECORD_SIZE) return null;
  return Array.from({ length: NAMES_SECURITY_RECORDS }, (_, i) => {
    const o = NAMES_SECURITY_OFFSET + i * NAMES_SECURITY_RECORD_SIZE;
    const base = { level: 2 + (i >> 2), timeZone: (i & 3) + 1 };
    if (buf[o] === 0xff) return { ...base, begin: '', end: '', days: Array<boolean>(7).fill(false), relays: [] as number[], floors: [] as number[] };
    return {
      ...base,
      begin: namesTime(buf[o], buf[o + 1]), end: namesTime(buf[o + 2], buf[o + 3]),
      days: namesDayFlags(buf[o + 4]), relays: namesSecurityRelays(buf, o), floors: namesSecurityFloors(buf, o),
    };
  });
}

export function parseNamesHolidays(buf: Buffer): ({ month: number; day: number } | null)[] | null {
  if (buf.length < NAMES_HOLIDAY_OFFSET + NAMES_HOLIDAY_ROWS * 2) return null;
  return Array.from({ length: NAMES_HOLIDAY_ROWS }, (_, i) => {
    const rec = buf.subarray(NAMES_HOLIDAY_OFFSET + i * 2, NAMES_HOLIDAY_OFFSET + i * 2 + 2);
    const month = allFF(rec) ? null : bcd(rec.subarray(0, 1));
    const day = allFF(rec) ? null : bcd(rec.subarray(1, 2));
    return month && day ? { month: Number(month), day: Number(day) } : null;
  });
}

// Elevator Reference table (ER1-ER8; `relay` in the result is the ER number): one byte each at 0xc6 — bit (e-1)
// set means visitors may use elevator e (1-8) — and the floor-button time in seconds, one byte each at 0x97
// (0xFF = unset). Confirmed byte-for-byte against a known pattern and time values.
const NAMES_ELEVATOR_RELAY_OFFSET = 0xc6;
const NAMES_ELEVATOR_TIME_OFFSET = 0x97;
const NAMES_ELEVATOR_COUNT = 8;

export function parseNamesElevator(buf: Buffer): { relay: number; elevators: number[]; seconds: number | null }[] | null {
  if (buf.length < NAMES_ELEVATOR_RELAY_OFFSET + NAMES_ELEVATOR_COUNT) return null;
  return Array.from({ length: NAMES_ELEVATOR_COUNT }, (_, i) => {
    const byte = buf[NAMES_ELEVATOR_RELAY_OFFSET + i];
    const elevators: number[] = [];
    for (let e = 1; e <= 8; e++) if (byte & (1 << (e - 1))) elevators.push(e);
    const t = buf[NAMES_ELEVATOR_TIME_OFFSET + i];
    return { relay: i + 1, elevators, seconds: t === 0xff ? null : t };
  });
}

// Facility codes: an enable flag at 0x32 (0xFF = off, 0x00 = on) and 10 codes at 0x1e, each a 16-bit
// big-endian value (0xFFFF = unused). Confirmed against a disabled/enabled sample pair.
const NAMES_FACILITY_OFFSET = 0x1e;
const NAMES_FACILITY_COUNT = 10;
const NAMES_FACILITY_ENABLE = 0x32;

export function parseNamesFacilityCodes(buf: Buffer): { enabled: boolean; codes: { row: number; code: string }[] } | null {
  if (buf.length < NAMES_FACILITY_ENABLE + 1) return null;
  const codes = Array.from({ length: NAMES_FACILITY_COUNT }, (_, i) => {
    const o = NAMES_FACILITY_OFFSET + i * 2;
    const v = (buf[o] << 8) | buf[o + 1];
    return { row: i + 1, code: v === 0xffff ? '' : String(v) };
  });
  return { enabled: buf[NAMES_FACILITY_ENABLE] !== 0xff, codes };
}

// Relay hold-open schedule: 8 rows (7 time rows + a Holiday row), 5 bytes each at 0x6f.
// Record = [beginHour, beginMin, endHour, endMin, dayFlags]; begin hour 0xFF = unused row.
// Day bits run Sun..Sat in bit7..bit1 (the reverse of ACCOUNT.DAT's array), bit0 unused.
// Confirmed byte-for-byte against ACCOUNT.DAT (times and days).
// Relay assignments: 19 bytes at 0x5c, one per relay 0-18; bit i set means row i (bit 7 = Holiday)
// holds that relay open. Taken from DoorKing32's hold-open grid code; confirmed for relay 5 row 1.
const NAMES_HOLDOPEN_OFFSET = 0x6f;
const NAMES_HOLDOPEN_ROWS = 8; // rows 1-7 + Holiday
const NAMES_HOLDOPEN_SIZE = 5;
const NAMES_HOLDOPEN_RELAY_OFFSET = 0x5c;
const NAMES_HOLDOPEN_RELAYS = 19;

export function parseNamesHoldOpen(buf: Buffer): { row: string; begin: string; end: string; days: boolean[]; relays: number[] }[] | null {
  if (buf.length < NAMES_HOLDOPEN_OFFSET + NAMES_HOLDOPEN_ROWS * NAMES_HOLDOPEN_SIZE) return null;
  return Array.from({ length: NAMES_HOLDOPEN_ROWS }, (_, i) => {
    const o = NAMES_HOLDOPEN_OFFSET + i * NAMES_HOLDOPEN_SIZE;
    const row = i < 7 ? String(i + 1) : 'Hol';
    const relays: number[] = [];
    for (let r = 0; r < NAMES_HOLDOPEN_RELAYS; r++) if (buf[NAMES_HOLDOPEN_RELAY_OFFSET + r] & (1 << i)) relays.push(r);
    if (buf[o] === 0xff) return { row, begin: '', end: '', days: Array<boolean>(7).fill(false), relays };
    return { row, begin: namesTime(buf[o], buf[o + 1]), end: namesTime(buf[o + 2], buf[o + 3]), days: namesDayFlags(buf[o + 4]), relays };
  });
}

// Packed decimal digits; 0xF nibbles are padding.
export function bcd(bytes: Iterable<number>): string | null {
  let s = '';
  for (const b of bytes) {
    for (const n of [b >> 4, b & 0x0f]) {
      if (n <= 9) s += n;
      else if (n !== 0x0f) return null;
    }
  }
  return s;
}

const allFF = (bytes: Uint8Array): boolean => bytes.every((b) => b === 0xff);

// phone.bin: 10 bytes per directory code. Bytes 2-5 depend on the area-code mode (see readPhoneFields).
// Byte 8 is packed: bits 0-4 = security level (0-30), bits 5-7 = elevator reference index
// (stored 0-7, shown +1 so 0 -> "1"). Byte 9 = floor number (0xFF = unset). Both confirmed by
// isolated before/after gate pulls (hide lives in names.bin, not here).
export function parsePhoneBin(buf: Buffer, areaCodeMode = 255): PhoneEntry[] {
  const entries: PhoneEntry[] = [];
  for (let o = 0; o + 10 <= buf.length; o += 10) {
    const rec = buf.subarray(o, o + 10);
    if (allFF(rec.subarray(0, 2))) continue;
    const { areaCodeIndex, phone } = readPhoneFields(rec, areaCodeMode);
    entries.push({
      recordOffset: o,
      directoryCode: bcd(rec.subarray(0, 2)),
      areaCodeIndex,
      phone: phone && `${phone.slice(0, 3)}-${phone.slice(3)}`,
      entryCode: allFF(rec.subarray(6, 8)) ? null : bcd(rec.subarray(6, 8)),
      securityLevel: rec[8] & 0x1f,
      elevatorRef: (rec[8] >> 5) + 1,
      floor: rec[9] === 0xff ? null : rec[9],
    });
  }
  return entries;
}

// cards.bin: 4 bytes per card: card number (16-bit big-endian), directory code (BCD, F-padded).
export function parseCardsBin(buf: Buffer): CardEntry[] {
  const cards: CardEntry[] = [];
  for (let o = 0; o + 4 <= buf.length; o += 4) {
    const rec = buf.subarray(o, o + 4);
    if (allFF(rec)) continue;
    cards.push({
      cardNumber: String(rec.readUInt16BE(0)).padStart(5, '0'),
      directoryCode: bcd(rec.subarray(2, 4)),
    });
  }
  return cards;
}

// names.bin: settings header, display messages, area code table, then the A-Z directory (see NAMES_LAYOUTS).
// Area code table: 2-byte BCD entries (F-padded), indexed by phone.bin's area code index.
// Directory entry (20 bytes): name (15, space padded), flag byte, directory code (bytes 16-19, see namesEntryCode).
export function parseNamesBin(buf: Buffer) {
  const layout = namesLayout(buf);
  const areaCodes: (string | null)[] = [];
  for (let i = 0; i < layout.areaCodeSlots; i++) {
    const o = layout.areaCodeOffset + i * 2;
    if (o + 2 > buf.length) break;
    const rec = buf.subarray(o, o + 2);
    areaCodes.push(allFF(rec) ? null : bcd(rec));
  }
  while (areaCodes.length && areaCodes[areaCodes.length - 1] === null) areaCodes.pop();
  const directory: DirectoryEntry[] = [];
  for (let o = layout.directoryOffset; o + NAMES_ENTRY_SIZE <= buf.length; o += NAMES_ENTRY_SIZE) {
    const code = namesEntryCode(buf, o);
    if (!code) break;
    const flag = buf[o + 15];
    directory.push({
      entryOffset: o,
      directoryCode: code,
      name: buf.toString('latin1', o, o + 15).trimEnd(),
      flag,
      // flag byte 15 bitfield: bit 0 = vendor, bit 5 = shown in directory (clear = hidden).
      vendor: Boolean(flag & 0x01),
      hidden: !(flag & 0x20),
    });
  }
  const displayLines = buf.length >= NAMES_DISPLAY_LINES_OFFSET + NAMES_DISPLAY_LINE_COUNT * NAMES_DISPLAY_LINE_SIZE
    ? Array.from({ length: NAMES_DISPLAY_LINE_COUNT }, (_, i) => {
      const o = NAMES_DISPLAY_LINES_OFFSET + i * NAMES_DISPLAY_LINE_SIZE;
      const rec = buf.subarray(o, o + NAMES_DISPLAY_LINE_SIZE);
      return rec.every((c) => c >= 0x20 && c < 0x7f) ? rec.toString('latin1') : null;
    })
    : null;
  return {
    areaCodeMode: layout.areaCodeMode, dirDigits: namesDirDigits(buf), areaCodes, displayLines, directory,
    securityTimes: parseNamesSecurityTimes(buf), holidays: parseNamesHolidays(buf),
  };
}

// rcv_out.bin: raw 10-byte transaction records read from the board.
// Hour byte: bits 7-6 = event flags, bit 5 = PM, bits 4-0 = BCD hour (1-12).
// Code type 0x01 = keypad code (BCD), 0x02 = card number (16-bit big-endian).
export function parseRcvOut(buf: Buffer): RcvRecord[] {
  const records: RcvRecord[] = [];
  for (let o = 0; o + 10 <= buf.length; o += 10) {
    const rec = buf.subarray(o, o + 10);
    const codeType = rec[4];
    const codeBytes = rec.subarray(5, 7);
    let code: string | null = null;
    if (!allFF(codeBytes)) {
      code = codeType === 0x02 ? String(codeBytes.readUInt16BE(0)).padStart(5, '0') : bcd(codeBytes);
    }
    records.push({
      month: Number(bcd([rec[0]])),
      day: Number(bcd([rec[1]])),
      hour: Number(bcd([rec[2] & 0x1f])),
      minute: Number(bcd([rec[3]])),
      pm: Boolean(rec[2] & 0x20),
      eventFlags: rec[2] >> 6,
      codeType,
      code,
      raw: rec.toString('hex'),
    });
  }
  return records;
}

// Event types from DoorKing32's transaction decoder (byte 4 of each rcv_out.bin record).
const SYSTEM_EVENTS: Record<number, string> = { 5: 'H/U', 6: 'Admit', 7: 'Hold', 8: 'Rels', 9: '1 Hour', 10: 'Hr Rel' };
const LINK_EVENTS: Record<number, [string, string]> = {
  0x0d: ['Modem-to-Modem', 'Download Data'], 0x0e: ['Modem-to-Modem', 'Upload Data'],
  0x0f: ['Modem-to-Modem', 'Upload Transaction'], 0x10: ['Modem-to-Modem', 'Unsuccessful'],
  0x11: ['Modem-to-Modem', 'Download Changes Only Data'], 0x12: ['Modem-to-Modem', 'Download Data Failed'],
  0x13: ['Modem-to-Modem', 'Upload Data Failed'], 0x14: ['Modem-to-Modem', 'Upload Transactions Failed'],
  0x15: ['Modem-to-Modem', 'Download Chgs Only Failed'],
  0x16: ['RS232', 'Download Data'], 0x17: ['RS232', 'Upload Data'], 0x18: ['RS232', 'Upload Trans'],
  0x19: ['RS232', 'Download Data - Failed'], 0x1a: ['RS232', 'Upload Data - Failed'],
  0x1b: ['RS232', 'Upload Trans - Failed'], 0x1c: ['RS232', 'Unsuccessful'],
  0x1d: ['RS232', 'Database is Up To Date'], 0x1e: ['Modem', 'Database is Up To Date'],
};
const APB_RESYNC = ['Re-Sync All Manually', 'Re-Sync All By Download', 'Re-Sync One Manually',
  'Re-Sync List By Download', 'Scheduled Re-Sync All'];
const APB_COUNTER = ['Set Facility Counter Manually', 'Set Facility Counter By Download',
  'Users In Facility', 'Dec Facility Counter Past Zero'];
const DEFAULT_RELAY_NAMES = ['Relay 0', 'Entry', 'Exit'];

// Decodes one parsed rcv_out.bin record into the columns of DoorKing32's transaction view.
// Byte 2 bit 6 = admit (else deny); byte 7 = relay (0x12 = relay 0, 0 = relay 1, 1 = relay 2,
// 0xFC-0xFF = combinations). lookup = 'directory' | 'entryCode' | 'card' when the number names a resident.
export function decodeRcvEvent(t: { raw: string }, relayNames: string[] = DEFAULT_RELAY_NAMES): RcvEvent {
  const rec = Buffer.from(t.raw, 'hex');
  const type = rec[4];
  const card = String(rec.readUInt16BE(5)).padStart(5, '0');
  const isApb = type >= 0x22 && type <= 0x25;
  const [r0, r1, r2] = relayNames;
  const ev: RcvEvent = { eventType: '', number: '', name: '', access: '', relay: '', apb: '', lookup: null };

  ev.access = !(rec[2] & 0x40) ? 'Deny' : isApb ? 'Open' : 'Admit';
  if (!(type === 5 || (type > 0x0c && !isApb))) {
    const b7 = rec[7];
    const combos: Record<number, string[]> = { 0xfc: [r0, r1], 0xfd: [r0, r2], 0xfe: [r1, r2], 0xff: [r0, r1, r2] };
    ev.relay = b7 === 0x12 ? r0 : b7 === 0 ? r1 : b7 === 1 ? r2
      : b7 >= 2 && b7 <= 0x11 ? `Relay code ${b7}`
        : combos[b7]?.join(', ') || '';
  }

  if (type === 0 || type === 1) {
    ev.eventType = type === 0 ? 'Directory' : 'Entry Code';
    ev.number = bcd(rec.subarray(5, 7));
    ev.lookup = type === 0 ? 'directory' : 'entryCode';
    if (ev.access === 'Deny') ev.relay = '';
  } else if (type === 2) {
    const n = rec.readUInt16BE(5);
    if (n >= 0xff80) {
      Object.assign(ev, { number: card, access: '', name: n === 0xff80 ? 'Gate Close Edge Activated' : `Board status ${n - 0xff80}` });
    } else {
      Object.assign(ev, { eventType: 'Cards', number: card, lookup: 'card' });
    }
  } else if (type === 4) {
    ev.eventType = 'Open Request';
  } else if (SYSTEM_EVENTS[type]) {
    Object.assign(ev, { eventType: 'System', access: SYSTEM_EVENTS[type] });
  } else if (type === 0x0b || type === 0x0c) {
    Object.assign(ev, { eventType: type === 0x0b ? 'Hold Begin' : 'Hold End', access: type === 0x0b ? 'Hold' : 'Rels' });
  } else if (LINK_EVENTS[type]) {
    Object.assign(ev, { eventType: LINK_EVENTS[type][0], name: LINK_EVENTS[type][1], access: '' });
  } else if (type === 0x20) {
    Object.assign(ev, { eventType: 'APB Re-Sync', name: APB_RESYNC[rec[7]] || '', access: '', relay: '' });
    if (rec[7] === 2 || rec[7] === 3) ev.number = card;
  } else if (type === 0x21) {
    Object.assign(ev, { eventType: 'APB Counter', name: APB_COUNTER[rec[7]] || '', number: card, access: '', relay: '' });
  } else if (isApb) {
    Object.assign(ev, {
      eventType: type <= 0x23 ? 'APB Okay' : 'APB Violation',
      apb: type % 2 === 0 ? 'IN' : 'OUT', number: card, lookup: 'card',
    });
  } else {
    Object.assign(ev, { eventType: `Type 0x${type.toString(16).padStart(2, '0')}`, access: '', relay: '' });
  }
  return ev;
}

// rcv_out.bin is a 10,000-record ring buffer followed by a 6-byte trailer:
// byte 0 = 0x99 when the buffer has wrapped, bytes 3-5 = next write address (0xA0000 + index * 10).
// Returns records oldest -> newest with a year inferred backwards from pulledAt (the board stores no year).
export function orderRcvOut(buf: Buffer, pulledAt: Date = new Date()): RcvRecord[] {
  const records = parseRcvOut(buf);
  let ordered = records;
  if (buf.length % 10 === 6) {
    const trailer = buf.subarray(buf.length - 6);
    const next = (trailer.readUIntBE(3, 3) - 0xa0000) / 10;
    if (Number.isInteger(next) && next >= 0 && next <= records.length) {
      ordered = trailer[0] === 0x99
        ? [...records.slice(next), ...records.slice(0, next)]
        : records.slice(0, next);
    }
  }
  const dayKey = (t: RcvRecord) => t.month * 100 + t.day;
  let year = pulledAt.getFullYear();
  let newer = (pulledAt.getMonth() + 1) * 100 + pulledAt.getDate();
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (dayKey(ordered[i]) > newer) year--;
    newer = dayKey(ordered[i]);
    ordered[i] = { ...ordered[i], year };
  }
  return ordered;
}

// .MAP: indexes of 128-byte blocks flagged as changed.
export function parseMap(buf: Buffer): { blocks: number; changedBlocks: number[]; blockSize: number } {
  const changedBlocks: number[] = [];
  buf.forEach((v, i) => v && changedBlocks.push(i));
  return { blocks: buf.length, changedBlocks, blockSize: BLOCK_SIZE };
}

// DKS Cloud transfers files as hex text; accept base64 as a fallback.
export function decodeFileText(text: unknown): Buffer {
  const s = String(text).trim();
  if (/^([0-9a-f]{2})*$/i.test(s)) return Buffer.from(s, 'hex');
  return Buffer.from(s, 'base64');
}

// Hex text for SendResidentData (DoorKing32 writes two hex digits per byte).
export const encodeFileText = (buf: Uint8Array): string => Buffer.from(buf).toString('hex').toUpperCase();

// The two counts DoorKing32 embeds in the send session's UserID as "{residents,vendors}"
// (DoorKing32 FUN_004f7320 counts resident records with FL 0 and FL 2). Both are directory
// facts, so we derive them from names.bin instead of reading RESIDENT.DAT:
//   vendors   = directory entries with the vendor flag bit set (flag & 1), the FL 2 records;
//   residents = every other occupied directory entry, the FL 0 records.
// Confirmed against the sample data: flag&1 reproduces the vendor count exactly, and
// residents + vendors equals the occupied directory size (the binary's memory-fit guard).
export function namesResidentCounts(buf: Buffer): [number, number] {
  const { directory } = parseNamesBin(buf);
  const vendors = directory.filter((d) => (d.flag & 1) === 1).length;
  return [directory.length - vendors, vendors];
}

// The same join from buffers ({ names, phone, cards }; any may be missing).
export function residentRows(bufs: { names?: Buffer | null; phone?: Buffer | null; cards?: Buffer | null }): ResidentsData {
  const names = bufs.names && { data: bufs.names };
  const phones = bufs.phone && { data: bufs.phone };
  const cards = bufs.cards && { data: bufs.cards };
  const rows = new Map<string, ResidentRow>();
  const row = (code: string): ResidentRow => {
    if (!rows.has(code)) {
      rows.set(code, {
        directoryCode: code, name: '', type: 'Resident', hidden: false,
        areaCode: '', areaCodeIndex: null, phone: '', entryCode: '',
        securityLevel: '', elevatorRef: '', floor: '', cards: [],
        entryOffset: null, recordOffset: null,
      });
    }
    return rows.get(code)!;
  };
  const namesBin = names && parseNamesBin(names.data);
  // A directory entry's flag byte (byte 15): bit 0 = vendor, bit 5 = shown (clear = hidden).
  if (namesBin) for (const e of namesBin.directory) Object.assign(row(e.directoryCode), {
    name: e.name, type: e.vendor ? 'Vendor' : 'Resident', hidden: e.hidden, entryOffset: e.entryOffset,
  });
  if (phones) {
    for (const p of parsePhoneBin(phones.data, namesBin ? namesBin.areaCodeMode : 255)) {
      const areaCode = (namesBin && p.areaCodeIndex !== null && namesBin.areaCodes[p.areaCodeIndex]) || '';
      Object.assign(row(p.directoryCode as string), {
        areaCode, areaCodeIndex: p.areaCodeIndex, phone: p.phone || '', entryCode: p.entryCode || '',
        securityLevel: p.securityLevel, elevatorRef: p.elevatorRef, floor: p.floor == null ? '' : p.floor,
        recordOffset: p.recordOffset,
      });
    }
  }
  const unassignedCards: string[] = [];
  if (cards) {
    for (const c of parseCardsBin(cards.data)) {
      if (c.directoryCode) row(c.directoryCode).cards.push(c.cardNumber);
      else unassignedCards.push(c.cardNumber);
    }
  }
  const list = [...rows.values()].sort((a, b) => a.directoryCode.localeCompare(b.directoryCode));
  return { rows: list, unassignedCards };
}
