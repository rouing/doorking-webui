import { test } from 'node:test';
import assert from 'node:assert';
import {
  applyResidentEdit, deleteResident, removeDirectoryCode, addEntry, emptySlots, encodeBcd,
  areaCodeLimit, areaCodeUsage, convertAreaCodeMode, convertDirDigits, findDuplicates,
} from '../src/residents-edit.ts';
import { parsePhoneBin, parseNamesBin } from '../src/board-files.ts';

// Rebuilds the real baseline record we captured from the gate for "Doe, Jane" / 701.
const ENTRY_OFF = 0x1084; // directory entry 13
const PHONE_OFF = 0x3ac; // phone record 94
function baseline() {
  const names = Buffer.alloc(64000, 0xff);
  // Preceding directory slots carry a valid empty entry (' 000') so the parser can walk to Jane.
  for (let o = 0xf80; o < ENTRY_OFF; o += 20) { names.fill(0x20, o, o + 17); names[o + 15] = 0x00; names.write('000', o + 17, 3, 'latin1'); }
  names.write('Doe, Jane'.padEnd(15, ' '), ENTRY_OFF, 15, 'latin1');
  names[ENTRY_OFF + 15] = 0x20; // flag: shown resident
  names[ENTRY_OFF + 16] = 0x20; // ' '
  names.write('701', ENTRY_OFF + 17, 3, 'latin1');
  const phone = Buffer.alloc(30080, 0xff);
  Buffer.from([0xf7, 0x01, 0x02, 0x54, 0xb0, 0x3e, 0x48, 0x21, 0x01, 0xff]).copy(phone, PHONE_OFF);
  const cards = Buffer.alloc(32000, 0xff);
  return { names, phone, cards };
}

test('findDuplicates: directory codes, entry codes and cards held by more than one entry', () => {
  const names = Buffer.alloc(64000, 0xff);
  const entry = (o, name, code) => {
    names.write(name.padEnd(15, ' '), o, 15, 'latin1');
    names[o + 15] = 0x20;
    names.write(code.padStart(4, ' '), o + 16, 4, 'latin1');
  };
  entry(0xf80, 'Smith, J', '101');
  entry(0xf94, 'Jones, A', '102');
  const phone = Buffer.alloc(30080, 0xff);
  Buffer.from([0xf1, 0x01, 0xff, 0xff, 0xff, 0xff, 0x12, 0x34, 0x01, 0xff]).copy(phone, 0);
  Buffer.from([0xf1, 0x02, 0xff, 0xff, 0xff, 0xff, 0x56, 0x78, 0x01, 0xff]).copy(phone, 10);
  const cards = Buffer.alloc(32000, 0xff);
  Buffer.from([0x01, 0xf8, 0xf1, 0x01]).copy(cards, 0); // card 504 -> 101
  const bufs = { names, phone, cards };
  assert.deepStrictEqual(findDuplicates(bufs), []);
  phone.writeUInt16BE(0x1234, 16); // 102 gets 101's entry code
  Buffer.from([0x01, 0xf8, 0xf1, 0x02]).copy(cards, 4); // card 504 also on 102
  entry(0xfa8, 'Brown, B', '102'); // a second directory entry with code 102
  const d = findDuplicates(bufs);
  assert.deepStrictEqual(d.map((x) => [x.kind, x.value]), [['directoryCode', '102'], ['entryCode', '1234'], ['card', '00504']]);
  assert.deepStrictEqual(d[0].holders, ['Jones, A', 'Brown, B']);
  assert.match(d[1].text, /^Entry code 1234 is used by directory code 101 \(Smith, J\) and directory code 102 \(Jones, A\)$/);
  assert.match(d[2].text, /^Card 00504 is assigned to directory code 101 \(Smith, J\) and directory code 102 \(Jones, A\)$/);
});

test('encodeBcd right-justifies with leading-F padding, matching the gate', () => {
  assert.deepStrictEqual([...encodeBcd('701', 2)], [0xf7, 0x01]);
  assert.deepStrictEqual([...encodeBcd('4821', 2)], [0x48, 0x21]);
  assert.deepStrictEqual([...encodeBcd('', 2)], [0xff, 0xff]);
});

test('Hide matches the live gate byte change (0x20 -> 0x00 at entry byte 15)', () => {
  const r = applyResidentEdit(baseline(), { directoryCode: '701', hidden: true });
  assert.strictEqual(r.names[ENTRY_OFF + 15], 0x00);
  const back = applyResidentEdit(r, { directoryCode: '701', hidden: false });
  assert.strictEqual(back.names[ENTRY_OFF + 15], 0x20);
});

test('Elevator ref 2 matches the live gate byte change (0x01 -> 0x21 at phone byte 8)', () => {
  const r = applyResidentEdit(baseline(), { directoryCode: '701', elevatorRef: 2 });
  assert.strictEqual(r.phone[PHONE_OFF + 8], 0x21);
  assert.strictEqual(parsePhoneBin(r.phone)[0].elevatorRef, 2);
  assert.strictEqual(parsePhoneBin(r.phone)[0].securityLevel, 1); // low bits untouched
});

test('Floor 5 matches the live gate byte change (0xFF -> 0x05 at phone byte 9)', () => {
  const r = applyResidentEdit(baseline(), { directoryCode: '701', floor: 5 });
  assert.strictEqual(r.phone[PHONE_OFF + 9], 0x05);
  assert.strictEqual(parsePhoneBin(r.phone)[0].floor, 5);
  const cleared = applyResidentEdit(r, { directoryCode: '701', floor: '' });
  assert.strictEqual(cleared.phone[PHONE_OFF + 9], 0xff);
});

test('security level packs into bits 0-4 without disturbing the elevator bits', () => {
  const r = applyResidentEdit(baseline(), { directoryCode: '701', elevatorRef: 3, securityLevel: 30 });
  const p = parsePhoneBin(r.phone)[0];
  assert.strictEqual(p.securityLevel, 30);
  assert.strictEqual(p.elevatorRef, 3);
  assert.strictEqual(r.phone[PHONE_OFF + 8], (2 << 5) | 30);
});

test('name, entry code and phone round-trip through the parser', () => {
  const r = applyResidentEdit(baseline(), {
    directoryCode: '701', name: 'Smith, Jane', entryCode: '1234', phone: '5551234', areaCode: '214',
  });
  const dir = parseNamesBin(r.names).directory.find((e) => e.directoryCode === '701');
  assert.strictEqual(dir.name, 'Smith, Jane');
  assert.strictEqual(dir.flag, 0x20); // flag preserved
  const p = parsePhoneBin(r.phone)[0];
  assert.strictEqual(p.entryCode, '1234');
  assert.strictEqual(p.phone, '555-1234');
  assert.strictEqual(parseNamesBin(r.names).areaCodes[p.areaCodeIndex], '214');
});

test('cards add and remove against the 4-byte records', () => {
  const added = applyResidentEdit(baseline(), { directoryCode: '701', cards: ['504', '10002'] });
  const mine = (buf) => [...Array(buf.length / 4).keys()]
    .map((i) => buf.subarray(i * 4, i * 4 + 4))
    .filter((r) => !r.every((b) => b === 0xff) && r.readUInt16BE(0) !== undefined && r[2] === 0xf7 && r[3] === 0x01)
    .map((r) => r.readUInt16BE(0));
  assert.deepStrictEqual(mine(added.cards).sort((a, b) => a - b), [504, 10002]);
  const removed = applyResidentEdit(added, { directoryCode: '701', cards: ['504'] });
  assert.deepStrictEqual(mine(removed.cards), [504]);
});

test('phone longer than 7 digits is rejected (area code is separate)', () => {
  assert.throws(() => applyResidentEdit(baseline(), { directoryCode: '701', phone: '2145551234' }), /7-digit/);
});

test('unknown directory code is a 404', () => {
  assert.throws(() => applyResidentEdit(baseline(), { directoryCode: '999', name: 'x' }), (e) => e.status === 404);
});

// Gives entry 0 a vacant code plus a blanked phone record, so addEntry has a real empty slot to fill.
function withVacant(code) {
  const b = baseline();
  b.names.write(code, 0xf80 + 17, 3, 'latin1'); // entry 0 already has blank name + flag 0x00
  const bcd = Buffer.from([0xf0 | Number(code[0]), (Number(code[1]) << 4) | Number(code[2])]);
  Buffer.from([bcd[0], bcd[1], 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0xff]).copy(b.phone, 0);
  return b;
}

test('emptySlots lists vacant codes and addEntry fills one as a shown resident', () => {
  const b = withVacant('101');
  assert.ok(emptySlots(b.names).includes('101'));
  const r = addEntry(b, { directoryCode: '101', name: 'New, Person', phone: '5559999', entryCode: '4321', securityLevel: 2, floor: 3, elevatorRef: 1 });
  const dir = parseNamesBin(r.names).directory.find((e) => e.directoryCode === '101');
  assert.strictEqual(dir.name, 'New, Person');
  assert.strictEqual(dir.flag, 0x20); // shown resident
  const p = parsePhoneBin(r.phone).find((x) => x.directoryCode === '101');
  assert.strictEqual(p.phone, '555-9999');
  assert.strictEqual(p.entryCode, '4321');
  assert.strictEqual(p.securityLevel, 2);
  assert.strictEqual(p.floor, 3);
  assert.ok(!emptySlots(r.names).includes('101')); // no longer vacant
});

test('addEntry as a vendor sets the vendor bit and leaves it out of the resident directory', () => {
  const r = addEntry(withVacant('102'), { directoryCode: '102', name: 'Acme Co', vendor: true, entryCode: '1122', cards: ['55'] });
  const dir = parseNamesBin(r.names).directory.find((e) => e.directoryCode === '102');
  assert.strictEqual(dir.flag & 0x01, 0x01); // vendor
  assert.strictEqual(dir.flag & 0x20, 0x00); // not shown among residents
});

test('addEntry refuses an occupied code (409) and a blank name', () => {
  assert.throws(() => addEntry(baseline(), { directoryCode: '701', name: 'x' }), (e) => e.status === 409); // 701 = Cody
  assert.throws(() => addEntry(withVacant('101'), { directoryCode: '101', name: '  ' }), /name is required/);
});

test('an entry code or card held by another directory code is refused (409)', () => {
  const b = applyResidentEdit(withVacant('101'), { directoryCode: '701', cards: ['504'] }); // 701 has entry code 4821
  assert.throws(() => addEntry(b, { directoryCode: '101', name: 'New, Person', entryCode: '4821' }),
    (e) => e.status === 409 && /Entry code 4821 is already used by directory code 701 \(Doe, Jane\)/.test(e.message));
  assert.throws(() => addEntry(b, { directoryCode: '101', name: 'New, Person', cards: ['00504'] }),
    (e) => e.status === 409 && /Card 504 is already assigned to directory code 701/.test(e.message));
  // Unchanged values on the same code are accepted; a card freed from 701 can then go to 101.
  const same = applyResidentEdit(b, { directoryCode: '701', entryCode: '4821', cards: ['504'], name: 'Doe, J' });
  const freed = applyResidentEdit(same, { directoryCode: '701', cards: [] });
  const r = addEntry(freed, { directoryCode: '101', name: 'New, Person', entryCode: '1111', cards: ['504'] });
  assert.strictEqual(parsePhoneBin(r.phone).find((x) => x.directoryCode === '101').entryCode, '1111');
});

test('delete returns the slot to the gate empty-slot format (name blank, flag 0x00, phone blanked, no cards)', () => {
  const start = applyResidentEdit(baseline(), { directoryCode: '701', phone: '5551234', entryCode: '1234', cards: ['504', '600'] });
  const r = deleteResident(start, '701');
  // names: 15 spaces + flag 0x00 + ' ' + '701'
  assert.strictEqual(r.names.toString('latin1', ENTRY_OFF, ENTRY_OFF + 15), ' '.repeat(15));
  assert.strictEqual(r.names[ENTRY_OFF + 15], 0x00);
  assert.strictEqual(r.names.toString('latin1', ENTRY_OFF + 16, ENTRY_OFF + 20), ' 701');
  // phone: code kept, fields blanked exactly like a real empty slot (… ff ff ff ff ff ff 01 ff)
  assert.deepStrictEqual([...r.phone.subarray(PHONE_OFF, PHONE_OFF + 10)], [0xf7, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0xff]);
  // cards: none remain for 701
  const mine = [...Array(r.cards.length / 4).keys()].map((i) => r.cards.subarray(i * 4, i * 4 + 4))
    .filter((rec) => rec[2] === 0xf7 && rec[3] === 0x01);
  assert.strictEqual(mine.length, 0);
  // the record no longer parses as a resident
  assert.strictEqual(parseNamesBin(r.names).directory.find((e) => e.directoryCode === '701').name, '');
});

// Small directory in DoorKing32 order: empty slot, residents by name, vendor last. Phone records in code order.
function sorted() {
  const names = Buffer.alloc(64000, 0xff);
  const rows = [['', 0x00, '010'], ['Adams, A', 0x20, '300'], ['miles, b', 0x20, '200'], ['Young, C', 0x00, '400'], ['Acme Co', 0x01, '900']];
  rows.forEach(([n, f, c], i) => {
    const o = 0xf80 + i * 20;
    names.write(n.padEnd(15, ' '), o, 15, 'latin1');
    names[o + 15] = f;
    names.write(` ${c}`, o + 16, 4, 'latin1');
  });
  const phone = Buffer.alloc(30080, 0xff);
  ['010', '200', '300', '400', '900'].forEach((c, i) => {
    Buffer.concat([encodeBcd(c, 2), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0xff])]).copy(phone, i * 10);
  });
  return { names, phone, cards: Buffer.alloc(32000, 0xff) };
}
const dirOrder = (names) => parseNamesBin(names).directory.map((e) => e.directoryCode);
const phoneOrder = (phone) => parsePhoneBin(phone).map((p) => p.directoryCode);
const pointer = (names) => (names[0xf8] << 16) | (names[0xf9] << 8) | names[0xfa];

test('addEntry inserts a new code in name order (ignoring case) and code order, like DoorKing32', () => {
  const r = addEntry(sorted(), { directoryCode: '555', name: 'MMTEST', securityLevel: 1, elevatorRef: 1 });
  assert.deepStrictEqual(dirOrder(r.names), ['010', '300', '200', '555', '400', '900']); // after "miles", before "Young"
  assert.deepStrictEqual(phoneOrder(r.phone), ['010', '200', '300', '400', '555', '900']);
  assert.deepStrictEqual([...r.phone.subarray(40, 50)], [0xf5, 0x55, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0xff]);
  assert.strictEqual(r.names[0xf80 + 3 * 20 + 15], 0x20);
  // 3 shown entries (Adams, miles, MMTEST): middle = 2nd shown = index 2
  assert.strictEqual(pointer(r.names), 0xf80 + 2 * 20);
});

test('addEntry puts a new resident after the last resident and a new vendor in vendor order', () => {
  const z = addEntry(sorted(), { directoryCode: '555', name: 'ZZTEST' });
  assert.deepStrictEqual(dirOrder(z.names), ['010', '300', '200', '400', '555', '900']);
  const v = addEntry(sorted(), { directoryCode: '950', name: 'Zeta Supply', vendor: true });
  assert.deepStrictEqual(dirOrder(v.names), ['010', '300', '200', '400', '900', '950']);
  assert.deepStrictEqual(phoneOrder(v.phone).slice(-2), ['900', '950']);
});

test('removeDirectoryCode takes the code out and closes the gap, undoing addEntry exactly', () => {
  const start = sorted();
  const added = addEntry(start, { directoryCode: '555', name: 'MMTEST', cards: ['77'] });
  const r = removeDirectoryCode(added, '555');
  assert.deepStrictEqual(dirOrder(r.names), ['010', '300', '200', '400', '900']);
  assert.ok(r.phone.equals(start.phone));
  assert.ok(r.cards.equals(start.cards));
  assert.ok(r.names.subarray(0xf80).equals(start.names.subarray(0xf80)));
  assert.throws(() => removeDirectoryCode(r, '555'), (e) => e.status === 404);
});

test('middle pointer updates only when the directory changes', () => {
  const start = sorted();
  const phoneOnly = applyResidentEdit(start, { directoryCode: '300', phone: '5551234' });
  assert.ok(phoneOnly.names.subarray(0xf8, 0xfb).equals(start.names.subarray(0xf8, 0xfb)));
  const hidden = applyResidentEdit(start, { directoryCode: '300', hidden: true }); // only "miles" shown
  assert.strictEqual(pointer(hidden.names), 0xf80 + 2 * 20);
});

// Area-code table at 0xA41 (2-byte BCD entries); Cody's phone record points at entry 0.
function withAreaCodes(codes) {
  const b = baseline();
  codes.forEach((c, i) => Buffer.from(c, 'hex').copy(b.names, 0xa41 + i * 2));
  b.phone[PHONE_OFF + 2] = 0;
  return b;
}

test('area codes are 3 digits or 1 + 3 digits, and "10 Area Codes" keeps new ones in the first 10 entries', () => {
  assert.throws(() => applyResidentEdit(baseline(), { directoryCode: '701', areaCode: '2315' }), /3 digits, or 4 starting with 1/);
  assert.throws(() => applyResidentEdit(baseline(), { directoryCode: '701', areaCode: '31' }), /3 digits/);
  const long = applyResidentEdit(withAreaCodes(['f214']), { directoryCode: '701', areaCode: '1315' });
  assert.deepStrictEqual([...long.names.subarray(0xa43, 0xa45)], [0x13, 0x15]);
  assert.strictEqual(long.phone[PHONE_OFF + 2], 1);
  assert.strictEqual(areaCodeLimit('10 Area Codes'), 10);
  assert.strictEqual(areaCodeLimit('255 Area Codes'), 255);
  const ten = withAreaCodes(['f214', 'f469', 'f918', 'f832', 'f503', 'f972', 'f843', 'f419', 'f903', 'f361']);
  assert.throws(() => applyResidentEdit(ten, { directoryCode: '701', areaCode: '817' }, { areaCodeSlots: 10 }), /limit 10/);
  const r = applyResidentEdit(ten, { directoryCode: '701', areaCode: '817' });
  assert.strictEqual(r.phone[PHONE_OFF + 2], 10);
  const reuse = applyResidentEdit(ten, { directoryCode: '701', areaCode: '361' }, { areaCodeSlots: 10 });
  assert.strictEqual(reuse.phone[PHONE_OFF + 2], 9);
});

test('areaCodeUsage counts phone records per area-code entry', () => {
  const b = withAreaCodes(['f214', '1315']);
  assert.deepStrictEqual(areaCodeUsage(b.names, b.phone), [
    { index: 0, code: '214', uses: 1 }, { index: 1, code: '1315', uses: 0 },
  ]);
});

test('convertAreaCodeMode switches to the 10-area-code layout and back, as DoorKing32 does', () => {
  const b = withAreaCodes(['f214', 'f469', 'f972']);
  b.phone[PHONE_OFF + 2] = 2; // Cody uses 972
  const ten = convertAreaCodeMode(b, 10);
  assert.strictEqual(ten.names.length, 64000 - 0x380);
  assert.strictEqual(ten.names.subarray(0x44, 0x58).toString('hex'), 'f972' + 'ff'.repeat(18)); // unused codes dropped
  assert.ok(ten.names.subarray(0xa41, 0xc00).every((v) => v === 0xff));
  assert.ok(ten.names.subarray(0xc00).equals(b.names.subarray(0xf80)));
  assert.ok(ten.names.subarray(0, 0x44).equals(b.names.subarray(0, 0x44)));
  // 10 mode: index nibble + 7 BCD digits (DoorKing32 snapshot: f701 02 54b03e -> f701 0 5550142 after renumbering).
  assert.strictEqual(ten.phone.subarray(PHONE_OFF + 2, PHONE_OFF + 6).toString('hex'), '05550142');
  const n10 = parseNamesBin(ten.names);
  assert.strictEqual(n10.areaCodeMode, 10);
  assert.deepStrictEqual(n10.areaCodes, ['972']);
  assert.strictEqual(n10.directory.find((e) => e.directoryCode === '701').name, 'Doe, Jane');
  const p10 = parsePhoneBin(ten.phone, 10).find((p) => p.directoryCode === '701');
  assert.deepStrictEqual([p10.areaCodeIndex, p10.phone], [0, '555-0142']);

  const edited = applyResidentEdit(ten, { directoryCode: '701', name: 'Doe, J', areaCode: '214', phone: '5551234' });
  assert.strictEqual(edited.phone.subarray(PHONE_OFF + 2, PHONE_OFF + 6).toString('hex'), '15551234');
  assert.strictEqual(edited.names.readUIntBE(0xf8, 3), ENTRY_OFF); // middle pointer counts from 0xF80 in both modes

  const back = convertAreaCodeMode(edited, 255);
  assert.strictEqual(back.names.length, 64000);
  assert.deepStrictEqual(parseNamesBin(back.names).areaCodes, ['972', '214']);
  assert.ok(back.names.subarray(0x44, 0x58).every((v) => v === 0xff));
  const p255 = parsePhoneBin(back.phone).find((p) => p.directoryCode === '701');
  assert.deepStrictEqual([p255.areaCodeIndex, p255.phone], [1, '555-1234']);
  assert.strictEqual(parseNamesBin(back.names).directory.find((e) => e.directoryCode === '701').name, 'Doe, J');
});

test('convertAreaCodeMode refuses 10 mode while more than 10 area codes are in use', () => {
  const codes = ['f214', 'f469', 'f918', 'f832', 'f503', 'f972', 'f843', 'f419', 'f903', 'f361', 'f817'];
  const b = withAreaCodes(codes);
  // Give each area code a user: phone records after Cody's, codes 800-810.
  codes.forEach((_, i) => Buffer.from([0xf8, i, i, 0x74, 0xf0, 0xe6, 0xff, 0xff, 0x01, 0xff]).copy(b.phone, PHONE_OFF + 10 * (i + 1)));
  assert.throws(() => convertAreaCodeMode(b, 10), (e) => e.status === 409 && /uses 11 area codes/.test(e.message));
});

test('convertDirDigits 3 -> 4 adds leading zeros everywhere, as DoorKing32 does', () => {
  const b = baseline();
  b.names[0x40] = 3;
  Buffer.from([0x30, 0x39, 0xf7, 0x01]).copy(b.cards, 0); // card 12345 for 701
  const r = convertDirDigits(b, 4);
  assert.strictEqual(r.names[0x40], 4);
  assert.strictEqual(r.names.toString('latin1', ENTRY_OFF + 16, ENTRY_OFF + 20), '0701');
  assert.strictEqual(r.names.toString('latin1', 0xf80 + 16, 0xf80 + 20), '0000');
  assert.deepStrictEqual([...r.phone.subarray(PHONE_OFF, PHONE_OFF + 2)], [0x07, 0x01]);
  assert.deepStrictEqual([...r.cards.subarray(0, 4)], [0x30, 0x39, 0x07, 0x01]);
  assert.strictEqual(parseNamesBin(r.names).dirDigits, 4);
  assert.ok(parseNamesBin(r.names).directory.some((d) => d.directoryCode === '0701'));
  const edited = applyResidentEdit(r, { directoryCode: '0701', floor: 5 });
  assert.strictEqual(edited.phone[PHONE_OFF + 9], 0x05);
  assert.throws(() => applyResidentEdit(r, { directoryCode: '12345', floor: 5 }), /4-digit directory code/);
});

test('convertDirDigits 4 -> 3 wipes all resident data and keeps the rest of the header', () => {
  const b = baseline();
  b.names[0x40] = 3;
  b.names[0x10] = 0x1e;
  const four = convertDirDigits(b, 4);
  const r = convertDirDigits(four, 3);
  assert.strictEqual(r.names[0x40], 3);
  assert.strictEqual(r.names[0x10], 0x1e);
  assert.ok(r.names.subarray(0xf80).every((x) => x === 0xff));
  assert.ok(r.phone.every((x) => x === 0xff));
  assert.ok(r.cards.every((x) => x === 0xff));
  assert.strictEqual(parseNamesBin(r.names).directory.length, 0);
  assert.throws(() => convertDirDigits(b, 5), /must be 1, 2, 3 or 4/);
  assert.throws(() => convertDirDigits(b, 0), /must be 1, 2, 3 or 4/);
});
