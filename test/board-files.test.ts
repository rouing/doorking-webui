// Run with: node --test test/board-files.test.ts
import test from 'node:test';
import assert from 'node:assert';
import * as dk from '../index.ts';

const DIRECTORY_OFFSET = 0xf80;
const ENTRY_SIZE = 20;

// Builds a names.bin with the given directory entries ({ code, name, flag }).
// A trailing non-matching entry stops the parser, mirroring a real board image.
function namesBinWith(entries) {
  const buf = Buffer.alloc(64000);
  entries.forEach((e, i) => {
    const o = DIRECTORY_OFFSET + i * ENTRY_SIZE;
    buf.write((e.name || '').padEnd(15).slice(0, 15), o, 'latin1');
    buf[o + 15] = e.flag;
    buf.write(` ${e.code}`, o + 16, 'latin1'); // " ddd"
  });
  return buf;
}

test('namesResidentCounts: vendor = flag & 1, residents = the rest', () => {
  const buf = namesBinWith([
    { code: '000', name: '', flag: 0x00 },      // resident, blank name
    { code: '002', name: 'Resident A', flag: 0x20 }, // resident, named
    { code: '010', name: 'Resident B', flag: 0x20 }, // resident, named
    { code: '901', name: 'Vendor', flag: 0x01 }, // vendor
  ]);
  assert.deepStrictEqual(dk.namesResidentCounts(buf), [3, 1]);
});

test('namesResidentCounts: vendor bit is isolated, not an equality on the whole byte', () => {
  // A vendor that also carries the 0x20 ("named/active") bit must still count as a vendor.
  const buf = namesBinWith([
    { code: '005', name: 'Resident', flag: 0x20 },
    { code: '906', name: 'Vendor', flag: 0x21 }, // 0x20 | 0x01
  ]);
  assert.deepStrictEqual(dk.namesResidentCounts(buf), [1, 1]);
});

test('namesResidentCounts: residents + vendors equals the occupied directory size', () => {
  const entries = [];
  for (let i = 0; i < 20; i++) entries.push({ code: String(i).padStart(3, '0'), name: `R${i}`, flag: 0x20 });
  for (let i = 0; i < 5; i++) entries.push({ code: String(900 + i), name: `V${i}`, flag: 0x01 });
  const [residents, vendors] = dk.namesResidentCounts(namesBinWith(entries));
  assert.strictEqual(residents, 20);
  assert.strictEqual(vendors, 5);
  assert.strictEqual(residents + vendors, entries.length);
});

const HOLDOPEN_OFFSET = 0x6f;
// One hold-open record: hour byte 0x80|PM|bcdHour, bcd minute, and day bits (bit7=Sun .. bit1=Sat).
function holdOpenRow(beginHour, beginPm, endHour, endPm, dayIdxs) {
  const hr = (h, pm) => 0x80 | (pm ? 0x20 : 0) | (((Math.floor(h / 10) << 4) | (h % 10)));
  let flags = 0;
  for (const d of dayIdxs) flags |= 1 << (7 - d);
  return [hr(beginHour, beginPm), 0, hr(endHour, endPm), 0, flags];
}

test('parseNamesBin securityTimes: decodes days, relays, and floors; empty records stay empty', () => {
  const buf = Buffer.alloc(64000, 0xff);
  // Blank out the directory area start so parseNamesBin doesn't choke; we only assert security here.
  // Real L5 TZ1 record bytes (10AM-4PM, Mon/Wed/Fri, relays 1+18, floors 1+8) at offset 0x303.
  const rec = [0x90, 0x00, 0xa4, 0x00, 0x54, 0x80, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x81];
  rec.forEach((b, k) => { buf[0x303 + k] = b; });
  const st = dk.parseNamesBin(buf).securityTimes;
  const l5tz1 = st.find((r) => r.level === 5 && r.timeZone === 1);
  assert.deepStrictEqual(l5tz1.days, [false, true, false, true, false, true, false]); // Mon, Wed, Fri
  assert.deepStrictEqual(l5tz1.relays, [1, 18]);
  assert.deepStrictEqual(l5tz1.floors, [1, 8]);
  assert.strictEqual(l5tz1.begin, '10:00 AM');
  assert.strictEqual(l5tz1.end, '04:00 PM');
  // An untouched (0xFF) record must read as empty, not all-bits-set.
  const l7tz1 = st.find((r) => r.level === 7 && r.timeZone === 1);
  assert.deepStrictEqual(l7tz1.relays, []);
  assert.deepStrictEqual(l7tz1.floors, []);
  assert.deepStrictEqual(l7tz1.days, Array(7).fill(false));
});

test('parseNamesFacilityCodes: enable flag + 10 big-endian codes, 0xFFFF unused', () => {
  const buf = Buffer.alloc(64000, 0xff);
  const put16 = (i, v) => { buf[0x1e + i * 2] = v >> 8; buf[0x1e + i * 2 + 1] = v & 0xff; };
  put16(0, 123); // code 1
  put16(1, 45);  // code 2
  put16(9, 255); // code 10
  buf[0x32] = 0x00; // enabled
  const fc = dk.parseNamesFacilityCodes(buf);
  assert.strictEqual(fc.enabled, true);
  assert.strictEqual(fc.codes.length, 10);
  assert.strictEqual(fc.codes[0].code, '123');
  assert.strictEqual(fc.codes[1].code, '45');
  assert.strictEqual(fc.codes[9].code, '255');
  assert.strictEqual(fc.codes[2].code, ''); // unused
  // Disabled flag reads as off.
  buf[0x32] = 0xff;
  assert.strictEqual(dk.parseNamesFacilityCodes(buf).enabled, false);
});

test('parseNamesElevator: relay->elevator bitmaps and per-relay seconds', () => {
  const buf = Buffer.alloc(64000, 0xff);
  buf[0xc6] = 0x15; // relay 1 -> elevators 1,3,5
  buf[0xc7] = 0x80; // relay 2 -> elevator 8
  buf[0xcd] = 0x03; // relay 8 -> elevators 1,2
  for (let i = 2; i <= 6; i++) buf[0xc6 + i] = 0x00; // relays 3-7 empty
  buf[0x97] = 120; buf[0x98] = 1; buf[0x9d] = 1; // times: relay1=120s, relay2=1s, relay8=1s
  const el = dk.parseNamesElevator(buf);
  assert.strictEqual(el.length, 8);
  assert.deepStrictEqual(el[0], { relay: 1, elevators: [1, 3, 5], seconds: 120 });
  assert.deepStrictEqual(el[1].elevators, [8]);
  assert.deepStrictEqual(el[7].elevators, [1, 2]);
  assert.deepStrictEqual(el[2].elevators, []);
});

test('parseNamesHoldOpen: decodes times, days, relays, and empty rows', () => {
  const buf = Buffer.alloc(64000, 0xff);
  const put = (i, bytes) => bytes.forEach((b, k) => { buf[HOLDOPEN_OFFSET + i * 5 + k] = b; });
  put(0, holdOpenRow(11, false, 1, true, [1]));       // row 1: 11AM-1PM, Monday
  put(6, holdOpenRow(8, true, 9, true, [0, 1, 2, 3, 4, 5, 6])); // row 7: 8PM-9PM, all days
  put(7, holdOpenRow(6, false, 7, false, []));         // Hol: 6AM-7AM, no days
  // rows 2-6 left as 0xFF (empty)
  buf.fill(0, 0x5c, 0x6f);
  buf[0x5c + 1] = 0x81;  // relay 1: row 1 + Hol
  buf[0x5c + 18] = 0x40; // relay 18: row 7
  const ho = dk.parseNamesHoldOpen(buf);
  assert.strictEqual(ho.length, 8);
  assert.deepStrictEqual(ho[0], { row: '1', begin: '11:00 AM', end: '01:00 PM', days: [false, true, false, false, false, false, false], relays: [1] });
  assert.deepStrictEqual(ho[1], { row: '2', begin: '', end: '', days: Array(7).fill(false), relays: [] });
  assert.deepStrictEqual(ho[6], { row: '7', begin: '08:00 PM', end: '09:00 PM', days: Array(7).fill(true), relays: [18] });
  assert.deepStrictEqual(ho[7], { row: 'Hol', begin: '06:00 AM', end: '07:00 AM', days: Array(7).fill(false), relays: [1] });
});

test('gate settings: hold-open relay fields encode one byte per relay, bit per row', () => {
  const buf = Buffer.alloc(64000, 0);
  const { buffer: out } = dk.applyGateSettings(buf, { holdOpenRelay0: '10000001', holdOpenRelay2: '01000000' });
  assert.strictEqual(out[0x5c], 0x81);
  assert.strictEqual(out[0x5e], 0x02);
  const s = dk.gateSettingsJson(out);
  assert.strictEqual(s.holdOpenRelay0, '10000001');
  assert.strictEqual(s.holdOpenRelay1, '00000000');
});

// Anti-Pass Back (names.bin block 20). Expected bytes are the ones DoorKing32 wrote in the one-change diffs.
const apbBytes = (buf) => buf.subarray(0xa04, 0xa41).toString('hex');

test('Anti-Pass Back: an all-0xFF block 20 reads as unset', () => {
  const s = dk.gateSettingsJson(Buffer.alloc(64000, 0xff));
  assert.deepStrictEqual(
    [s.apbMode, s.apbRelaysIn, s.apbRelaysOut, s.apbCounterEvery, s.apbCounterReset, s.apbResyncAll,
      s.apbResyncList, s.apbScheduleEnabled, s.apbScheduleDays, s.apbScheduleTime],
    ['Off', '', '', 'Off', '', 'No', '', 'No', '0000000', ''],
  );
});

test('Anti-Pass Back: settings encode to the bytes DoorKing32 writes', () => {
  const base = Buffer.alloc(64000, 0xff);
  const { buffer, map } = dk.applyGateSettings(base, {
    apbMode: 'Trap', apbRelaysIn: '18,0,5', apbRelaysOut: '2', apbCounterEvery: '30 Mins', apbCounterReset: '123',
    apbResyncList: '11111,,,,55555', apbScheduleEnabled: 'Yes', apbScheduleDays: '1100011', apbScheduleTime: '23:45',
  });
  const b = (o) => buffer[o];
  assert.strictEqual(b(0xa04), 0x03);
  assert.strictEqual(buffer.subarray(0xa05, 0xa0f).toString('hex'), '000512ffffffffffffff');
  assert.strictEqual(buffer.subarray(0xa0f, 0xa19).toString('hex'), '02ffffffffffffffffff');
  assert.strictEqual(b(0xa19), 0x02);
  assert.strictEqual(buffer.subarray(0xa29, 0xa2b).toString('hex'), '007b');
  assert.strictEqual(b(0xa2b), 0xff);
  assert.strictEqual(buffer.subarray(0xa2c, 0xa37).toString('hex'), '002b67000000000000d903');
  assert.strictEqual(b(0xa37), 0x00);
  // Sat..Sun: Sun, Mon, Fri, Sat ticked.
  assert.strictEqual(buffer.subarray(0xa38, 0xa3f).toString('hex'), '0102ffffff0607');
  assert.strictEqual(buffer.subarray(0xa3f, 0xa41).toString('hex'), 'b145');
  assert.ok(buffer.subarray(0xa1a, 0xa29).every((x) => x === 0xff), 'unmapped bytes untouched');
  assert.deepStrictEqual([...map].flatMap((v, i) => (v ? [i] : [])), [20]);
  // Round trip.
  const s = dk.gateSettingsJson(buffer);
  assert.strictEqual(s.apbRelaysIn, '0,5,18');
  assert.strictEqual(s.apbResyncList, '11111,,,,55555');
  assert.strictEqual(s.apbScheduleDays, '1100011');
  assert.strictEqual(s.apbScheduleTime, '23:45');
});

test('Anti-Pass Back: observed values for mode, re-sync all, days and time', () => {
  const base = Buffer.alloc(64000, 0xff);
  const one = (changes) => dk.applyGateSettings(base, changes).buffer;
  assert.deepStrictEqual(['Passive', 'Active', 'Trap'].map((m) => one({ apbMode: m })[0xa04]), [1, 2, 3]);
  assert.deepStrictEqual(['15 Mins', 'Hour'].map((m) => one({ apbCounterEvery: m })[0xa19]), [1, 3]);
  assert.strictEqual(one({ apbResyncAll: 'Yes' })[0xa2b], 0x00);
  assert.strictEqual(one({ apbScheduleTime: '02:00' }).subarray(0xa3f, 0xa41).toString('hex'), '8200');
  assert.strictEqual(one({ apbScheduleTime: '14:30' }).subarray(0xa3f, 0xa41).toString('hex'), 'a230');
  // Wed = 04 at 0xA3B.
  assert.strictEqual(one({ apbScheduleDays: '0001000' })[0xa3b], 0x04);
});

test('Anti-Pass Back: clearing returns block 20 settings to 0xFF; bad values are rejected', () => {
  const set = dk.applyGateSettings(Buffer.alloc(64000, 0xff), {
    apbMode: 'Active', apbRelaysIn: '1', apbCounterEvery: 'Hour', apbCounterReset: '5', apbResyncList: ',,,,',
    apbScheduleEnabled: 'Yes', apbScheduleDays: '1111111', apbScheduleTime: '01:00',
  }).buffer;
  assert.notStrictEqual(apbBytes(set), 'ff'.repeat(0x3d));
  const cleared = dk.applyGateSettings(set, {
    apbMode: 'Off', apbRelaysIn: '', apbRelaysOut: '', apbCounterEvery: 'Off', apbCounterReset: '', apbResyncAll: 'No',
    apbResyncList: '', apbScheduleEnabled: 'No', apbScheduleDays: '0000000', apbScheduleTime: '',
  }).buffer;
  assert.strictEqual(apbBytes(cleared), 'ff'.repeat(0x3d));
  const bad = (changes, re) => assert.throws(() => dk.applyGateSettings(Buffer.alloc(64000, 0xff), changes), re);
  bad({ apbRelaysIn: '0,1,2,3,4,5,6,7,8,9,10' }, /up to 10 relays/);
  bad({ apbRelaysOut: '19' }, /relays 0-18/);
  bad({ apbMode: 'On' }, /one of Off, Passive, Active, Trap/);
  bad({ apbResyncList: '1,2' }, /5 comma-separated/);
  bad({ apbResyncList: '0,,,,' }, /numbers 1-65535/);
});

test('Outside line digit at 0x1D: 9 -> 09, 0 -> 00, blank -> FF (matches DoorKing32)', () => {
  const base = Buffer.alloc(64000, 0xff);
  const one = (v) => dk.applyGateSettings(base, { outsideLineDigit: v });
  assert.strictEqual(one('9').buffer[0x1d], 0x09);
  assert.strictEqual(one('0').buffer[0x1d], 0x00);
  assert.strictEqual(dk.applyGateSettings(one('9').buffer, { outsideLineDigit: '' }).buffer[0x1d], 0xff);
  assert.deepStrictEqual(one('9').bytes, [{ offset: 0x1d, from: 0xff, to: 0x09 }]);
  assert.strictEqual(dk.gateSettingsJson(one('0').buffer).outsideLineDigit, '0');
  assert.throws(() => one('12'), /a digit 0-9/);
  assert.throws(() => one('*'), /a digit 0-9/);
});

test('Read-only System fields from the decompiled DoorKing32: dial type, multiple systems, memory, chips, download stamps', () => {
  const names = Buffer.alloc(64000, 0xff);
  const get = () => dk.gateSettingsJson(names);
  const keys = ['dialType', 'multipleSystems', 'systemMemory', 'memoryChips', 'downloadStamp1', 'downloadStamp2'];
  assert.deepStrictEqual(keys.map((k) => get()[k]), ['', '', '', '', '', '']); // all 0xFF: nothing recorded
  names[0x0f] = 0x0a; names[0x06] = 0x01; names[0xfb] = 0x05;
  Buffer.from('00f9e0' + '0182b0', 'hex').copy(names, 0xbf); // memory 3000: 0xF80 + 3000 * 20, 0x10D80 + 3000 * 10
  Buffer.from('70bfec6a' + '75bfec6a', 'hex').copy(names, 0x15);
  assert.deepStrictEqual(keys.map((k) => get()[k]),
    ['Tone', 'Yes', '3000', 'Anti-pass back', '2026-11-05 17:40:00 UTC', '2026-11-05 17:40:05 UTC']);
  names[0x0f] = 0x01; names[0x06] = 0x0a; names[0xfb] = 0x00;
  Buffer.from('005da0' + '013490', 'hex').copy(names, 0xbf); // memory 1000
  assert.deepStrictEqual(['dialType', 'multipleSystems', 'systemMemory', 'memoryChips'].map((k) => get()[k]), ['Rotary', 'No', '1000', 'Standard']);
  // Values that don't fit are shown raw rather than guessed.
  names[0x0f] = 0x07; names[0xfb] = 0x02; names[0xc4] = 0x91;
  assert.deepStrictEqual(['dialType', 'memoryChips', 'systemMemory'].map((k) => get()[k]), ['? (0x7)', '? (0x2)', '? (005da0013491)']);
  Buffer.from('00000000', 'hex').copy(names, 0x15);
  assert.strictEqual(get().downloadStamp1, '? (00000000)');
  for (const k of keys) assert.throws(() => dk.applyGateSettings(names, { [k]: '' }), /read-only/);
});

test('Talk time at 0x10 is seconds (minutes * 60 + seconds); facility codes are 0-255', () => {
  const base = Buffer.alloc(64000, 0xff);
  const one = (changes) => dk.applyGateSettings(base, changes).buffer;
  assert.strictEqual(one({ talkTime: '1:30' })[0x10], 90);
  assert.strictEqual(one({ talkTime: '45' })[0x10], 45);
  assert.strictEqual(dk.gateSettingsJson(one({ talkTime: '0:45' })).talkTime, '0:45');
  assert.strictEqual(one({ talkTime: '' })[0x10], 0xff);
  assert.throws(() => one({ talkTime: '4:15' }), /0:00 to 4:14/);
  assert.throws(() => one({ talkTime: '1:75' }), /0:00 to 4:14/);
  assert.deepStrictEqual([...one({ facilityCode1: '124' }).subarray(0x1e, 0x20)], [0x00, 124]);
  assert.throws(() => one({ facilityCode1: '256' }), /facility code 0-255/);
});

test('Entry code ranges: relay 0 at 0xAC, relay 1 at 0xB0, relay 2 at 0xB4 (matches DoorKing32)', () => {
  const r = dk.applyGateSettings(Buffer.alloc(64000, 0xff), {
    relay0EntryCodeRangeFrom: '1234', relay0EntryCodeRangeTo: '5678', relay2EntryCodeRangeFrom: '2345', relay2EntryCodeRangeTo: '6789',
  }).buffer;
  assert.strictEqual(r.subarray(0xac, 0xb8).toString('hex'), '12345678ffffffff23456789');
  assert.strictEqual(dk.gateSettingsJson(r).relay2EntryCodeRangeTo, '6789');
});

test('Relay / Elevator table: relay 0 at 0xF7, relays 1-18 at 0x230 + relay (matches DoorKing32)', () => {
  const r = dk.applyGateSettings(Buffer.alloc(64000, 0), { relay0Elevators: '10000000', relay2Elevators: '00100000', relay5Elevators: '10000000' });
  assert.deepStrictEqual(r.bytes, [{ offset: 0xf7, from: 0, to: 0x01 }, { offset: 0x232, from: 0, to: 0x04 }, { offset: 0x235, from: 0, to: 0x01 }]);
  const j = dk.gateSettingsJson(r.buffer);
  assert.strictEqual(j.relay18Elevators, '00000000');
  assert.strictEqual(j.relay2Elevators, '00100000');
});

test('Holidays for Security Levels at 0xA03: on = 00, off = FF (matches DoorKing32)', () => {
  const on = dk.applyGateSettings(Buffer.alloc(64000, 0xff), { holidaysForSecurity: 'Yes' });
  assert.deepStrictEqual(on.bytes, [{ offset: 0xa03, from: 0xff, to: 0x00 }]);
  assert.strictEqual(dk.gateSettingsJson(on.buffer).holidaysForSecurity, 'Yes');
});

test('Postal switch (0x41) and rotary dial 9 (0x42) are relay bitmasks, bit r = relay r (matches DoorKing32)', () => {
  const base = Buffer.alloc(64000, 0xff);
  base[0x41] = 0x02; // postal on relay 1 (DoorKing32 snapshot tracker4)
  base[0x42] = 0x02; // rotary dial 9 on relay 1
  assert.strictEqual(dk.gateSettingsJson(base).relayPostalSwitch, '01000000');
  const r = dk.applyGateSettings(base, { relayPostalSwitch: '11000000', relayRotaryDial9: '11000000' });
  assert.deepStrictEqual(r.bytes, [{ offset: 0x41, from: 0x02, to: 0x03 }, { offset: 0x42, from: 0x02, to: 0x03 }]);
});
