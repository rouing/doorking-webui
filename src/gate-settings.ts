import { bcd } from './board-files.ts';

// Gate settings read directly from names.bin (positions from DoorKing32's send builder, FUN_004aad40).
// Only fields whose position and encoding are confirmed are editable; the rest are shown read-only.
const BLOCK_SIZE = 128;
const DISPLAY_LINES_OFFSET = 0x190;
const HOLIDAY_OFFSET = 0x9c3;
const HOLIDAY_ROWS = 32;

// maxLength: text types only, the most characters encode accepts.
export interface FieldType { size: number; decode: (b: Buffer) => string; encode?: (v: string) => Buffer; maxLength?: number }
export interface GateSettingField {
  key: string; group: string; name: string; offset: number; type: FieldType; editable?: boolean; secret?: boolean; note?: string;
}
export interface GateSetting {
  key: string; group: string; name: string; offset: number; size: number; value: string;
  editable: boolean; secret: boolean; note: string | null; maxLength: number | null;
}

const allFF = (b: Uint8Array): boolean => b.every((x) => x === 0xff);
const toBcd = (n: number): number => ((Math.floor(n / 10) << 4) | (n % 10));
const ft = (t: FieldType): FieldType => t;

// Field types: size in bytes, decode(bytes) -> string, encode(string) -> Buffer (throws when invalid).
const TYPES = {
  text: (size: number): FieldType => ({
    size,
    maxLength: size,
    decode: (b) => b.toString('latin1').trimEnd(),
    encode: (v) => {
      if (v.length > size || !/^[\x20-\x7e]*$/.test(v)) throw new Error(`up to ${size} printable characters`);
      return Buffer.from(v.padEnd(size), 'latin1');
    },
  }),
  tone: ft({
    size: 1,
    decode: (b) => (b[0] === 0xff ? '' : b[0] >= 1 && b[0] <= 9 ? String(b[0]) : `? (0x${b[0].toString(16)})`),
    encode: (v) => {
      if (v === '') return Buffer.from([0xff]);
      if (!/^[1-9]$/.test(v)) throw new Error('a digit 1-9, or blank for none');
      return Buffer.from([Number(v)]);
    },
  }),
  digit: ft({
    size: 1,
    decode: (b) => (b[0] === 0xff ? '' : b[0] <= 9 ? String(b[0]) : `? (0x${b[0].toString(16)})`),
    encode: (v) => {
      if (v === '') return Buffer.from([0xff]);
      if (!/^[0-9]$/.test(v)) throw new Error('a digit 0-9, or blank for none');
      return Buffer.from([Number(v)]);
    },
  }),
  code4: ft({
    size: 2,
    decode: (b) => (allFF(b) ? '' : bcd(b) ?? `? (${b.toString('hex')})`),
    encode: (v) => {
      if (v === '') return Buffer.from([0xff, 0xff]);
      if (!/^\d{4}$/.test(v)) throw new Error('4 digits, or blank');
      return Buffer.from(v, 'hex');
    },
  }),
  holiday: ft({
    size: 2,
    decode: (b) => {
      if (allFF(b)) return '';
      const m = bcd(b.subarray(0, 1));
      const d = bcd(b.subarray(1, 2));
      return m && d ? `${Number(m)}/${Number(d)}` : `? (${b.toString('hex')})`;
    },
    encode: (v) => {
      if (v === '') return Buffer.from([0xff, 0xff]);
      const m = /^(\d{1,2})\/(\d{1,2})$/.exec(v);
      if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31) throw new Error('month/day such as 12/25, or blank');
      return Buffer.from([toBcd(+m[1]), toBcd(+m[2])]);
    },
  }),
  digits: (size: number): FieldType => ({ size, decode: (b) => [...b].map((x) => (x <= 9 ? String(x) : x === 0x0a ? '0' : '')).join('') }),
  // Talk time: one byte of seconds (DoorKing32 writes minutes * 60 + seconds), shown as m:ss. 0xFF = unset.
  seconds: ft({
    size: 1,
    decode: (b) => (b[0] === 0xff ? '' : `${Math.floor(b[0] / 60)}:${String(b[0] % 60).padStart(2, '0')}`),
    encode: (v) => {
      if (v.trim() === '') return Buffer.from([0xff]);
      const m = /^(?:(\d{1,2}):)?(\d{1,3})$/.exec(v.trim());
      const secs = m ? Number(m[1] || 0) * 60 + Number(m[2]) : NaN;
      if (!m || (m[1] !== undefined && Number(m[2]) > 59) || !(secs >= 0 && secs <= 254)) {
        throw new Error('m:ss (or seconds) from 0:00 to 4:14');
      }
      return Buffer.from([secs]);
    },
  }),
  byte: ft({
    size: 1,
    decode: (b) => String(b[0]),
    encode: (v) => {
      if (!/^\d{1,3}$/.test(v) || Number(v) > 255) throw new Error('a number 0-255');
      return Buffer.from([Number(v)]);
    },
  }),
  // Facility code: 16-bit big-endian, 0xFFFF = blank.
  code16: ft({
    size: 2,
    decode: (b) => (allFF(b) ? '' : String((b[0] << 8) | b[1])),
    encode: (v) => {
      if (v === '') return Buffer.from([0xff, 0xff]);
      if (!/^\d{1,5}$/.test(v) || Number(v) > 65535) throw new Error('a number 0-65535, or blank');
      return Buffer.from([(Number(v) >> 8) & 0xff, Number(v) & 0xff]);
    },
  }),
  // Facility code: stored like code16, but valid codes are 000-255 (DoorKing manual 3.7.1).
  facility: ft({
    size: 2,
    decode: (b) => (allFF(b) ? '' : String((b[0] << 8) | b[1])),
    encode: (v) => {
      if (v === '') return Buffer.from([0xff, 0xff]);
      if (!/^\d{1,3}$/.test(v) || Number(v) > 255) throw new Error('a facility code 0-255, or blank');
      return Buffer.from([0, Number(v)]);
    },
  }),
  // On/off flag where 0x00 = on and 0xFF = off (facility codes enable).
  onoff: ft({
    size: 1,
    decode: (b) => (b[0] === 0xff ? 'No' : 'Yes'),
    encode: (v) => Buffer.from([/^(yes|on|1|true)$/i.test(v) ? 0x00 : 0xff]),
  }),
  // Hold-open time: hour byte (0x80 set, 0x20 PM, low 5 = BCD hour 1-12) + BCD minute. Value is 24h "HH:MM".
  holdTime: ft({
    size: 2,
    decode: (b) => {
      if (b[0] === 0xff) return '';
      const h12 = bcd(Buffer.from([b[0] & 0x1f]));
      const min = bcd(b.subarray(1, 2));
      if (h12 === null || min === null) return '';
      const h24 = (Number(h12) % 12) + ((b[0] & 0x20) ? 12 : 0);
      return `${String(h24).padStart(2, '0')}:${min.padStart(2, '0')}`;
    },
    encode: (v) => {
      if (v === '') return Buffer.from([0xff, 0xff]);
      const m = /^(\d{1,2}):(\d{2})$/.exec(v);
      if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('time as HH:MM (24-hour), or blank');
      const h24 = +m[1];
      const h12 = (h24 % 12) || 12;
      return Buffer.from([0x80 | (h24 >= 12 ? 0x20 : 0) | toBcd(h12), toBcd(+m[2])]);
    },
  }),
  // Day bitmap: day d (0=Sun..6=Sat) is bit (7-d). Value is a 7-char "0"/"1" string, Sun..Sat. 0xFF = none.
  // Day mask: bit 7 = Sun … bit 1 = Sat, as a 7-char "0"/"1" string. 0xFF = not set: '' (kept apart from 0x00, no days).
  dayMask: ft({
    size: 1,
    decode: (b) => (b[0] === 0xff ? ''
      : Array.from({ length: 7 }, (_, d) => ((b[0] & (1 << (7 - d))) ? '1' : '0')).join('')),
    encode: (v) => {
      if (v === '') return Buffer.from([0xff]);
      let byte = 0;
      for (let d = 0; d < 7; d++) if (v[d] === '1') byte |= 1 << (7 - d);
      return Buffer.from([byte]);
    },
  }),
  // Elevator bitmap: elevator e (1-8) is bit (e-1). Value is an 8-char "0"/"1" string. 0x00 = none.
  elevatorMask: ft({
    size: 1,
    decode: (b) => Array.from({ length: 8 }, (_, e) => ((b[0] & (1 << e)) ? '1' : '0')).join(''),
    encode: (v) => {
      let byte = 0;
      for (let e = 0; e < 8; e++) if (v[e] === '1') byte |= 1 << e;
      return Buffer.from([byte]);
    },
  }),
  // Text stored in a `size`-byte space-padded slot but limited to `max` input characters (e.g. the
  // single-line System Message: a 48-byte slot the gate only accepts 27 usable characters in; the gate
  // needs the space padding to 48 bytes for its marquee scrolling).
  textMax: (size: number, max: number): FieldType => ({
    size,
    maxLength: max,
    decode: (b) => b.toString('latin1').trimEnd(),
    encode: (v) => {
      if (v.length > max || !/^[\x20-\x7e]*$/.test(v)) throw new Error(`up to ${max} printable characters`);
      return Buffer.from(v.padEnd(size), 'latin1');
    },
  }),
  // Elevator hold time: one byte of seconds, 0xFF = unset.
  elevatorSeconds: ft({
    size: 1,
    decode: (b) => (b[0] === 0xff ? '' : String(b[0])),
    encode: (v) => {
      if (v === '') return Buffer.from([0xff]);
      if (!/^\d{1,3}$/.test(v) || Number(v) > 254) throw new Error('seconds 0-254, or blank');
      return Buffer.from([Number(v)]);
    },
  }),
  // Security relays: 3 bytes (big-endian), relay r (0-18) at bit (r+5). Value is a 19-char "0"/"1" string.
  // All-0xFF is the unused-record filler (bits 0-4 can never be a real relay), so it reads as none.
  relayMask: ft({
    size: 3,
    decode: (b) => {
      if (b[0] === 0xff && b[1] === 0xff && b[2] === 0xff) return '0'.repeat(19);
      const v = (b[0] << 16) | (b[1] << 8) | b[2];
      return Array.from({ length: 19 }, (_, r) => ((v & (1 << (r + 5))) ? '1' : '0')).join('');
    },
    encode: (v) => {
      let x = 0;
      for (let r = 0; r < 19; r++) if (v[r] === '1') x |= 1 << (r + 5);
      return Buffer.from([(x >> 16) & 0xff, (x >> 8) & 0xff, x & 0xff]);
    },
  }),
  // Security floors: 8 bytes, floor f (1-64) at byte (7 - (f-1)>>3) of this field, bit (f-1)&7.
  // Value is a comma-separated list of floor numbers. All-0xFF is the unused-record filler (reads as none).
  floorMask: ft({
    size: 8,
    decode: (b) => {
      if (b.every((x) => x === 0xff)) return '';
      const floors: number[] = [];
      for (let f = 1; f <= 64; f++) if (b[7 - ((f - 1) >> 3)] & (1 << ((f - 1) & 7))) floors.push(f);
      return floors.join(',');
    },
    encode: (v) => {
      const buf = Buffer.alloc(8, 0);
      for (const s of v.split(',').map((x) => x.trim()).filter(Boolean)) {
        const f = Number(s);
        if (!Number.isInteger(f) || f < 1 || f > 64) throw new Error('floors 1-64, comma-separated');
        buf[7 - ((f - 1) >> 3)] |= 1 << ((f - 1) & 7);
      }
      return buf;
    },
  }),
  // One choice stored as a byte: names[0] = 0xFF, names[i] = i.
  choice: (names: string[]): FieldType => ({
    size: 1,
    decode: (b) => (b[0] === 0xff ? names[0] : names[b[0]] ?? `? (0x${b[0].toString(16)})`),
    encode: (v) => {
      const i = names.indexOf(v);
      if (i < 0) throw new Error(`one of ${names.join(', ')}`);
      return Buffer.from([i === 0 ? 0xff : i]);
    },
  }),
  // Anti-pass back relay row: up to 10 relay numbers (0-18), sorted, 0xFF = empty. Value is a comma-separated list.
  relayList: ft({
    size: 10,
    decode: (b) => {
      const list = [...b].filter((x) => x !== 0xff);
      if (list.some((x) => x > 18)) return `? (${b.toString('hex')})`;
      return [...new Set(list)].sort((a, c) => a - c).join(',');
    },
    encode: (v) => {
      const list = [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean).map(Number))];
      if (list.some((r) => !Number.isInteger(r) || r < 0 || r > 18)) throw new Error('relays 0-18, comma-separated');
      if (list.length > 10) throw new Error('up to 10 relays');
      const buf = Buffer.alloc(10, 0xff);
      list.sort((a, c) => a - c).forEach((r, i) => { buf[i] = r; });
      return buf;
    },
  }),
  // Re-Sync List: enable byte (0x00 = on) + 5 big-endian numbers (0x0000 = empty box); all 0xFF when off.
  // Value is '' when off, else the 5 boxes comma-separated (blank boxes allowed).
  resyncList: ft({
    size: 11,
    decode: (b) => (b[0] === 0xff ? '' : Array.from({ length: 5 }, (_, i) => {
      const n = (b[1 + i * 2] << 8) | b[2 + i * 2];
      return n ? String(n) : '';
    }).join(',')),
    encode: (v) => {
      const buf = Buffer.alloc(11, 0xff);
      if (v === '') return buf;
      const slots = v.split(',').map((s) => s.trim());
      if (slots.length !== 5) throw new Error('5 comma-separated boxes (blank allowed), or blank for off');
      buf[0] = 0;
      slots.forEach((s, i) => {
        if (s !== '' && (!/^\d{1,5}$/.test(s) || +s < 1 || +s > 65535)) throw new Error('numbers 1-65535, or blank');
        const n = s === '' ? 0 : +s;
        buf[1 + i * 2] = n >> 8;
        buf[2 + i * 2] = n & 0xff;
      });
      return buf;
    },
  }),
  // Scheduled re-sync days: 7 bytes Sat..Sun; day d (0=Sun..6=Sat) at byte (6-d) holds (7-d) when ticked,
  // 0xFF when not. Value is a 7-char "0"/"1" string, Sun..Sat.
  dayList: ft({
    size: 7,
    decode: (b) => Array.from({ length: 7 }, (_, d) => (b[6 - d] === 0xff ? '0' : '1')).join(''),
    encode: (v) => {
      const buf = Buffer.alloc(7, 0xff);
      for (let d = 0; d < 7; d++) if (v[d] === '1') buf[6 - d] = 7 - d;
      return buf;
    },
  }),
};

const DISPLAY_LINE_NAMES = ['User message line 1', 'User message line 2', 'User message line 3', 'User message line 4',
  'Instructions line 1', 'Instructions line 2', 'Instructions line 3', 'Instructions line 4'];
const TONES = [['Momentary', 'ToneMomentary'], ['Hold', 'ToneHold'], ['Release', 'ToneRelease'], ['Hold 1 Hr', 'ToneHold1Hr']];
const TONE_OFFSETS: Record<number, number> = { 0: 0x58, 1: 0x07, 2: 0x0b };

// key, group, name, offset, type, editable, secret, note.
const FIELDS: GateSettingField[] = [
  { key: 'masterCode', group: 'System', name: 'Master code', offset: 0x00, type: TYPES.digits(4), secret: true },
  { key: 'talkTime', group: 'System', name: 'Talk time (m:ss)', offset: 0x10, type: TYPES.seconds, editable: true },
  // "Dial _ First, then Dial Phone Number": 0xFF = none, else the digit 0-9 (confirmed with 9, 0 and blank).
  { key: 'outsideLineDigit', group: 'System', name: 'Outside line digit (dialed before the phone number)', offset: 0x1d,
    type: TYPES.digit, editable: true },
  // Relay strike times (seconds). Confirmed by setting distinct values: relay 0 lives at 0x11 (after talk
  // time 0x10), relays 1 and 2 at 0x04/0x05.
  ...[[0, 0x11], [1, 0x04], [2, 0x05]].map(([r, offset]) => ({
    key: `relay${r}Time`, group: 'Relays', name: `Relay ${r} strike time (seconds)`, offset, type: TYPES.byte, editable: true,
  })),
  ...[0, 1, 2].flatMap((r) => TONES.map(([name, suffix], i) => ({
    key: `relay${r}${suffix}`, group: 'Relays', name: `Relay ${r} tone open: ${name}`, offset: TONE_OFFSETS[r] + i,
    type: TYPES.tone, editable: true,
  }))),
  // Postal switch and rotary dial 9: which relays they activate, a bitmask byte each (bit r = relay r), confirmed
  // by one-change diffs of DoorKing32's output (BAK\ACCT0001_tracker5/6). Same 8-bit layout as elevatorMask.
  { key: 'relayPostalSwitch', group: 'Relays', name: 'Postal switch activates relays', offset: 0x41, type: TYPES.elevatorMask, editable: true },
  { key: 'relayRotaryDial9', group: 'Relays', name: 'Rotary dial 9 activates relays', offset: 0x42, type: TYPES.elevatorMask, editable: true },
  // Entry code ranges, one per relay, 4 bytes apart: relay 0 at 0xac, relay 1 at 0xb0, relay 2 at 0xb4 (From, then
  // To, 2-byte BCD each; confirmed by one-change diffs, BAK\ACCT0001_tracker7/8).
  ...[[0, 0xac], [1, 0xb0], [2, 0xb4]].flatMap(([r, base]) => ['From', 'To'].map((end, i) => ({
    key: `relay${r}EntryCodeRange${end}`, group: 'Relays', name: `Relay ${r} entry code range: ${end.toLowerCase()}`,
    offset: base + i * 2, type: TYPES.code4, editable: true,
  }))),
  ...DISPLAY_LINE_NAMES.map((name, i) => ({
    key: `displayLine${i + 1}`, group: 'Display (8 line)', name, offset: DISPLAY_LINES_OFFSET + i * 20, type: TYPES.text(20),
    editable: true,
  })),
  // Single-line mode: System Message (48-byte slot, 27 chars max, space-padded to 48 bytes because the gate
  // scrolls it as a marquee) and System Instruction (52 bytes).
  { key: 'systemMessage', group: 'Display (single line)', name: 'System message', offset: 0x114, type: TYPES.textMax(48, 27), editable: true },
  { key: 'systemInstruction', group: 'Display (single line)', name: 'System instruction', offset: 0x145, type: TYPES.textMax(52, 52), editable: true },
  ...Array.from({ length: HOLIDAY_ROWS }, (_, i) => ({
    key: `holiday${i + 1}`, group: 'Holidays', name: `Holiday row ${i + 1}`, offset: HOLIDAY_OFFSET + i * 2,
    type: TYPES.holiday, editable: true,
  })),
  // "Holidays for Security Levels": TZ4 of every security level becomes the Holiday time zone. Right after the 32
  // holiday rows; 0x00 = on, 0xFF = off (confirmed by a one-change diff, BAK\ACCT0001_hol1).
  { key: 'holidaysForSecurity', group: 'Holidays', name: 'Holidays for Security Levels', offset: 0xa03, type: TYPES.onoff, editable: true },
  { key: 'facilityEnabled', group: 'Facility Codes', name: 'Facility codes enabled', offset: 0x32, type: TYPES.onoff, editable: true },
  ...Array.from({ length: 10 }, (_, i) => ({
    key: `facilityCode${i + 1}`, group: 'Facility Codes', name: `Facility code ${i + 1}`, offset: 0x1e + i * 2,
    type: TYPES.facility, editable: true,
  })),
  // Hold-open: 8 rows (1-7 + Holiday), 5 bytes each at 0x6f — begin (2), end (2), day bitmap (1).
  ...([['1', 0], ['2', 1], ['3', 2], ['4', 3], ['5', 4], ['6', 5], ['7', 6], ['Hol', 7]] as [string, number][]).flatMap(([label, i]) => [
    { key: `holdOpen${label}Begin`, group: 'Hold Open', name: `Row ${label} begin`, offset: 0x6f + i * 5, type: TYPES.holdTime, editable: true },
    { key: `holdOpen${label}End`, group: 'Hold Open', name: `Row ${label} end`, offset: 0x6f + i * 5 + 2, type: TYPES.holdTime, editable: true },
    { key: `holdOpen${label}Days`, group: 'Hold Open', name: `Row ${label} days`, offset: 0x6f + i * 5 + 4, type: TYPES.dayMask, editable: true },
  ]),
  // Hold-open relays: one byte per relay 0-18 at 0x5c, bit i = row i (bit 7 = Holiday). Same 8-bit layout
  // as elevatorMask: value is an 8-char "0"/"1" string, rows 1-7 then Hol.
  ...Array.from({ length: 19 }, (_, r) => ({
    key: `holdOpenRelay${r}`, group: 'Hold Open', name: `Relay ${r} hold-open rows`, offset: 0x5c + r, type: TYPES.elevatorMask, editable: true,
  })),
  // Elevator Reference table (ER1-ER8, the resident's "Elevator reference"): elevators a visitor may use (bitmap at
  // 0xc6) and how long the floor button stays active (seconds at 0x97). Keys keep their original elevatorN names.
  ...Array.from({ length: 8 }, (_, i) => [
    { key: `elevator${i + 1}Elevators`, group: 'Elevator', name: `ER${i + 1} elevators`, offset: 0xc6 + i, type: TYPES.elevatorMask, editable: true },
    { key: `elevator${i + 1}Time`, group: 'Elevator', name: `ER${i + 1} floor button time (s)`, offset: 0x97 + i, type: TYPES.elevatorSeconds, editable: true },
  ]).flat(),
  // Relay / Elevator table: which elevators (bit e-1 = elevator e) each relay 0-18 controls. Relay 0 at 0xf7, relays
  // 1-18 at 0x230 + relay (0x230 itself is not part of it). Confirmed for relays 0, 2 and 5 by one-change diffs
  // (BAK\ACCT0001_elev1-3); the other relays follow the spacing.
  ...Array.from({ length: 19 }, (_, r) => ({
    key: `relay${r}Elevators`, group: 'Relay Elevator', name: `Relay ${r} elevators`, offset: r === 0 ? 0xf7 : 0x230 + r,
    type: TYPES.elevatorMask, editable: true,
  })),
  // Security levels: 116 records (levels 2-30, TZ1-4) of 16 bytes at 0x243 — begin (2), end (2), days (1), relays (3), floors (8).
  ...Array.from({ length: 116 }, (_, i) => {
    const level = 2 + (i >> 2); const tz = (i & 3) + 1; const o = 0x243 + i * 16; const k = `sec${level}tz${tz}`;
    return [
      { key: `${k}Begin`, group: 'Security', name: `L${level} TZ${tz} begin`, offset: o, type: TYPES.holdTime, editable: true },
      { key: `${k}End`, group: 'Security', name: `L${level} TZ${tz} end`, offset: o + 2, type: TYPES.holdTime, editable: true },
      { key: `${k}Days`, group: 'Security', name: `L${level} TZ${tz} days`, offset: o + 4, type: TYPES.dayMask, editable: true },
      { key: `${k}Relays`, group: 'Security', name: `L${level} TZ${tz} relays`, offset: o + 5, type: TYPES.relayMask, editable: true },
      { key: `${k}Floors`, group: 'Security', name: `L${level} TZ${tz} floors`, offset: o + 8, type: TYPES.floorMask, editable: true },
    ];
  }).flat(),
  // Anti-Pass Back (block 20), confirmed by diffing DoorKing32's output one change at a time.
  { key: 'apbMode', group: 'Anti-Pass Back', name: 'True Anti Passback', offset: 0xa04,
    type: TYPES.choice(['Off', 'Passive', 'Active', 'Trap']), editable: true },
  { key: 'apbRelaysIn', group: 'Anti-Pass Back', name: 'Relays In', offset: 0xa05, type: TYPES.relayList, editable: true },
  { key: 'apbRelaysOut', group: 'Anti-Pass Back', name: 'Relays Out', offset: 0xa0f, type: TYPES.relayList, editable: true },
  { key: 'apbCounterEvery', group: 'Anti-Pass Back', name: 'Record Facility Counter Every', offset: 0xa19,
    type: TYPES.choice(['Off', '15 Mins', '30 Mins', 'Hour']), editable: true },
  { key: 'apbCounterReset', group: 'Anti-Pass Back', name: 'Reset Facility Counter to', offset: 0xa29, type: TYPES.code16, editable: true },
  { key: 'apbResyncAll', group: 'Anti-Pass Back', name: 'Re-Sync All Devices', offset: 0xa2b, type: TYPES.onoff, editable: true },
  { key: 'apbResyncList', group: 'Anti-Pass Back', name: 'Re-Sync List', offset: 0xa2c, type: TYPES.resyncList, editable: true },
  { key: 'apbScheduleEnabled', group: 'Anti-Pass Back', name: 'Enable Scheduled Re-Sync All', offset: 0xa37, type: TYPES.onoff, editable: true },
  { key: 'apbScheduleDays', group: 'Anti-Pass Back', name: 'Scheduled Re-Sync All days', offset: 0xa38, type: TYPES.dayList, editable: true },
  { key: 'apbScheduleTime', group: 'Anti-Pass Back', name: 'Scheduled Re-Sync All time', offset: 0xa3f, type: TYPES.holdTime, editable: true },
];
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
const MIN_SIZE = Math.max(...FIELDS.map((f) => f.offset + f.type.size));

function checkSize(buf: Buffer): void {
  if (buf.length < MIN_SIZE) throw new Error(`names.bin is too short (${buf.length} bytes) to contain the settings`);
}

// names.bin -> list of settings with their current values.
export function decodeGateSettings(buf: Buffer): GateSetting[] {
  checkSize(buf);
  return FIELDS.map((f) => ({
    key: f.key, group: f.group, name: f.name, offset: f.offset, size: f.type.size,
    value: f.type.decode(buf.subarray(f.offset, f.offset + f.type.size)),
    editable: Boolean(f.editable), secret: Boolean(f.secret), note: f.note || null, maxLength: f.type.maxLength ?? null,
  }));
}

// names.bin -> { key: value } (plain JSON form of the settings).
export function gateSettingsJson(buf: Buffer): Record<string, string> {
  return Object.fromEntries(decodeGateSettings(buf).map((s) => [s.key, s.value]));
}

// Returns a copy of names.bin with the changed settings written in place, the list of changed bytes and a
// names.map (one byte per 128-byte block, 1 = block changed). All other bytes stay as pulled from the gate.
export function applyGateSettings(buf: Buffer, changes: Record<string, unknown> | null | undefined) {
  checkSize(buf);
  const out = Buffer.from(buf);
  const changed: { key: string; name: string; from: string; to: string }[] = [];
  for (const [key, raw] of Object.entries(changes || {})) {
    const f = BY_KEY.get(key);
    if (!f) throw new Error(`Unknown setting ${key}`);
    if (!f.editable) throw new Error(`${f.name} is read-only`);
    const value = String(raw ?? '');
    let bytes: Buffer;
    try { bytes = f.type.encode!(value); } catch (e) { throw new Error(`${f.name}: ${(e as Error).message}`); }
    const from = f.type.decode(buf.subarray(f.offset, f.offset + f.type.size));
    bytes.copy(out, f.offset);
    if (!bytes.equals(buf.subarray(f.offset, f.offset + f.type.size))) changed.push({ key, name: f.name, from, to: value });
  }
  const bytes: { offset: number; from: number; to: number }[] = [];
  for (let i = 0; i < out.length; i++) if (out[i] !== buf[i]) bytes.push({ offset: i, from: buf[i], to: out[i] });
  const map = Buffer.alloc(Math.ceil(out.length / BLOCK_SIZE));
  for (const b of bytes) map[Math.floor(b.offset / BLOCK_SIZE)] = 1;
  return { buffer: out, changed, bytes, map };
}

export { FIELDS as GATE_SETTING_FIELDS };
