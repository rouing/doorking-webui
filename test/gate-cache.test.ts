// Run with: node --test test/gate-cache.test.ts
import test from 'node:test';
import assert from 'node:assert';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as dk from '../index.ts';
import { helpPage, inline, markdownToHtml } from '../src/markdown.ts';
import { loadData } from '../web/data.ts';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const SIZE = 1024;

test('help page: the user guide renders, every "#section" link has its heading, text is escaped', () => {
  const html = helpPage(fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'MANUAL.md'), 'utf8'));
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  const links = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(links.length > 10);
  assert.deepStrictEqual(links.filter((l) => !ids.has(l)), []);
  assert.ok(html.includes('<table>') && html.includes('<blockquote>') && html.includes('<ol>'));
  assert.strictEqual(inline('<script>x</script> **b** `<c>`'), '&lt;script&gt;x&lt;/script&gt; <strong>b</strong> <code>&lt;c&gt;</code>');
  assert.strictEqual(inline('[x](javascript:alert(1))'), '[x](javascript:alert(1))'); // only #… and http(s) links
  assert.strictEqual(markdownToHtml('- one\n  more\n- two'), '<ul><li>one more</li><li>two</li></ul>');
});

function pulledDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-cache-'));
  for (const [i, name] of ['names.bin', 'phone.bin', 'cards.bin'].entries()) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(SIZE, i + 1));
  }
  return dir;
}

function withDir(fn) {
  return async () => {
    const dir = pulledDir();
    try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

test('history patch reverts a change, and refuses when a later change touched the same bytes', () => {
  const before = Buffer.alloc(64, 0x20);
  const after = Buffer.from(before);
  after.write('Smith', 10, 'latin1');
  const patch = dk.diffBuffers(before, after);
  assert.strictEqual(patch.runs.length, 1);
  const other = Buffer.from(after);
  other[40] = 0x41; // a later edit elsewhere is kept
  const back = dk.undoPatch(other, patch);
  assert.strictEqual(back.toString('latin1', 10, 15), '     ');
  assert.strictEqual(back[40], 0x41);
  const clash = Buffer.from(after);
  clash[11] = 0x41; // a later edit to the same bytes
  assert.strictEqual(dk.undoPatch(clash, patch), null);
  // Size changes (area-code layout) keep whole files.
  const bigger = Buffer.alloc(80, 0x20);
  const whole = dk.diffBuffers(before, bigger);
  assert.ok(whole.whole);
  assert.ok(dk.undoPatch(bigger, whole).equals(before));
  assert.strictEqual(dk.undoPatch(Buffer.alloc(80, 0), whole), null);
});

// Test database: TEST_DATABASE_URL, else config.json's database login with database.testName (doorking_test).
// Each store gets its own schema, dropped afterwards; dir holds its key file.
function testConnection() {
  if (process.env.TEST_DATABASE_URL) return { connectionString: process.env.TEST_DATABASE_URL };
  const { database } = dk.loadConfig({ args: [] });
  return dk.connectionSettings(database, database.testName);
}
const TEST_DB = testConnection();
const testStore = (dir) => dk.openStore({ connection: TEST_DB, keyFile: path.join(dir, 'key'),
  schema: `t_${crypto.randomBytes(6).toString('hex')}` });
async function dropStore(store) {
  await store.pool.query(`DROP SCHEMA ${store.schema} CASCADE`);
  await dk.closeStore(store);
}

// Runs fn(store, dir) with an empty database schema and a fresh temp folder.
function withStore(fn) {
  return withDir(async (dir) => {
    const store = await testStore(path.join(dir, 'store'));
    try { await fn(store, dir); } finally { await dropStore(store); }
  });
}
const T1 = '2026-01-01T08:00:00.000Z';
const PW = 'correct horse battery';
const NEW_PW = 'another long secret';
const GATE_A = { phoneNumber: '5550100', masterCode: '1234', dksUser: 'dksuser', dksPassword: 'dks-secret' };
const T2 = '2026-01-02T08:00:00.000Z';

// A small but realistic set of board files: settings blank as on a real gate (display text spaces, security relay
// and floor masks 00, the rest FF), three directory entries with phone records, and two cards.
function syntheticGate() {
  const names = Buffer.alloc(64000, 0xff);
  for (const f of dk.GATE_SETTING_FIELDS) {
    if (f.type.maxLength) names.fill(0x20, f.offset, f.offset + f.type.size);
    if (/^sec\d+tz\d(Relays|Floors)$/.test(f.key)) names.fill(0, f.offset, f.offset + f.type.size);
  }
  for (const [o, n, code, flag] of [[0xf80, 'Smith, J', ' 101', 0x20], [0xf94, 'ACME Deliveries', ' 102', 0x01], [0xfa8, '', ' 103', 0x00]]) {
    names.write(n.padEnd(15, ' '), o, 15, 'latin1');
    names[o + 15] = flag;
    names.write(code, o + 16, 4, 'latin1');
  }
  const phone = Buffer.alloc(30080, 0xff);
  Buffer.from([0xf1, 0x01, 0xff, 0x74, 0xf0, 0xe6, 0x12, 0x34, 0x21, 0x05]).copy(phone, 0);
  Buffer.from([0xf1, 0x02, 0xff, 0xff, 0xff, 0xff, 0x56, 0x78, 0x03, 0xff]).copy(phone, 10);
  Buffer.from([0xf1, 0x03, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0xff]).copy(phone, 20);
  const cards = Buffer.alloc(32000, 0xff);
  Buffer.from([0x01, 0xf8, 0xf1, 0x01, 0x3e, 0x70, 0xff, 0xff]).copy(cards, 8); // slot 2: 00504 -> 101; slot 3: 15984, no code
  return { names, phone, cards };
}

// The working copy of PHONE: pulled files are the synthetic gate; edits go through the app's edit functions.
const PHONE = '5550100';
const pullInto = (store, files = syntheticGate()) => dk.savePulledFiles(store, PHONE,
  { 'names.bin': files.names, 'phone.bin': files.phone, 'cards.bin': files.cards });
function withPull(fn) {
  return withStore(async (store, dir) => { await pullInto(store); await fn(store, dir); });
}
const working = async (store) => {
  const f = await dk.readCacheFiles(store, PHONE);
  return { names: f['names.bin'].data, phone: f['phone.bin'].data, cards: f['cards.bin'].data };
};
const saveWorking = (store, b) => dk.writeCacheFiles(store, PHONE, { 'names.bin': b.names, 'phone.bin': b.phone, 'cards.bin': b.cards });
const setTalkTime = async (store, value) => dk.writeCacheFile(store, PHONE, 'names.bin',
  dk.applyGateSettings((await working(store)).names, { talkTime: value }).buffer);
const MAP_SIZE = 64000 / 128;

test('ensureCache makes a working copy from the pull: files stored encrypted, the working copy as values', withPull(async (store) => {
  const status = await dk.ensureCache(store, PHONE);
  assert.deepStrictEqual([status.exists, status.edited, status.newerPull], [true, false, false]);
  const pulled = syntheticGate();
  const w = await working(store);
  for (const n of ['names', 'phone', 'cards']) assert.ok(w[n].equals(pulled[n]), `${n}.bin is built back exactly`);
  const raw = (await store.db.query("SELECT data FROM gate_files WHERE copy = 'base' AND name = 'names.bin'")).rows[0].data;
  assert.ok(!raw.includes(Buffer.from('Smith, J')), 'stored encrypted');
  assert.strictEqual((await store.db.query("SELECT COUNT(*) AS n FROM gate_files WHERE copy = 'working'")).rows[0].n, 0);
  assert.deepStrictEqual(await dk.gateStateCounts(store, PHONE), { gate_residents: 3, gate_cards: 2, gate_settings: dk.GATE_SETTING_FIELDS.length - 1 });
}));

test('ensureCache fails when nothing was pulled', withStore(async (store) => {
  await assert.rejects(() => dk.ensureCache(store, PHONE), (e) => e.status === 404);
}));

test('an edit is stored as values; the files and change map are built from base + values', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  assert.deepStrictEqual(await setTalkTime(store, '2:30'), { changedBlocks: [0] });
  const map = await dk.cacheFileData(store, PHONE, 'names.map');
  assert.strictEqual(map.length, MAP_SIZE);
  assert.deepStrictEqual([...map.keys()].filter((i) => map[i]), [0]);
  assert.strictEqual((await store.db.query("SELECT value FROM gate_settings WHERE key = 'talkTime'")).rows[0].value, '2:30');
  assert.ok((await dk.readPulledFile(store, PHONE, 'names.bin')).data.equals(syntheticGate().names), 'pulled copy is unchanged');
  assert.strictEqual((await dk.cacheStatus(store, PHONE)).edited, true);
}));

test('resident edits, adds, deletes and removed codes are stored as values and rebuild exactly', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  let b = dk.applyResidentEdit(await working(store), { directoryCode: '101', name: 'Smith, Joan', entryCode: '4711', cards: ['00504', '12001'] });
  await saveWorking(store, b);
  b = dk.addEntry(await working(store), { directoryCode: '105', name: 'Adams, A', phone: '5551234', areaCode: '512' });
  await saveWorking(store, b);
  b = dk.removeDirectoryCode(dk.deleteResident(await working(store), '102'), '103');
  await saveWorking(store, b);
  const w = await working(store);
  assert.ok(w.names.equals(b.names) && w.phone.equals(b.phone) && w.cards.equals(b.cards));
  const res = (await store.db.query('SELECT directory_code, name, type, entry_code, area_code FROM gate_residents ORDER BY directory_code')).rows;
  assert.deepStrictEqual(res, [
    { directory_code: '101', name: 'Smith, Joan', type: 'Resident', entry_code: '4711', area_code: '' },
    { directory_code: '102', name: '', type: 'Resident', entry_code: '', area_code: '' },
    { directory_code: '105', name: 'Adams, A', type: 'Resident', entry_code: '', area_code: '512' },
  ]);
  assert.deepStrictEqual((await store.db.query('SELECT card_number FROM gate_cards ORDER BY slot')).rows.map((r) => r.card_number),
    ['12001', '00504', '15984']);
}));

test('a new code added after a rename keeps its place, and a digit-count decrease wipes the directory', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  await saveWorking(store, dk.applyResidentEdit(await working(store), { directoryCode: '101', name: 'Zed, Smith' }));
  const added = dk.addEntry(await working(store), { directoryCode: '104', name: 'Moore, M' });
  await saveWorking(store, added);
  assert.ok((await working(store)).names.equals(added.names));
  const wiped = dk.convertDirDigits(await working(store), 2);
  await saveWorking(store, wiped);
  const w = await working(store);
  assert.ok(w.names.equals(wiped.names) && w.phone.equals(wiped.phone));
  assert.strictEqual((await store.db.query('SELECT COUNT(*) AS n FROM gate_residents')).rows[0].n, 0);
}));

test('an edit that the values cannot describe is refused, and nothing is saved', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  const names = Buffer.from((await working(store)).names);
  names[0x006] ^= 0xff; // a byte nothing decodes
  await assert.rejects(() => dk.writeCacheFile(store, PHONE, 'names.bin', names), (e) => e.status === 409 && /can't be stored/.test(e.message));
  assert.strictEqual((await dk.cacheStatus(store, PHONE)).edited, false);
  await assert.rejects(() => dk.writeCacheFile(store, PHONE, 'names.bin', Buffer.alloc(100)), /must stay 64000 bytes/);
  await assert.rejects(() => dk.writeCacheFile(store, PHONE, 'rcv_out.bin', Buffer.alloc(100)), (e) => e.status === 404);
}));

test('editing is locked when the pull fails the round-trip check', withStore(async (store) => {
  const gate = syntheticGate();
  gate.names[0x07] = 0x0c; // not a tone digit: can't be written back
  await pullInto(store, gate);
  await dk.ensureCache(store, PHONE);
  await assert.rejects(() => setTalkTime(store, '2:30'), (e) => e.status === 409 && /locked/.test(e.message));
}));

test('names.bin may switch area-code layout (0x380 bytes shorter)', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  const ten = dk.convertAreaCodeMode(await working(store), 10);
  assert.strictEqual(ten.names.length, 64000 - 0x380);
  await saveWorking(store, ten);
  assert.strictEqual((await working(store)).names.length, 64000 - 0x380);
  assert.strictEqual((await dk.cacheFileData(store, PHONE, 'names.map')).length, Math.ceil((64000 - 0x380) / 128));
  assert.ok((await dk.prepareSend(store, PHONE)).changedBlocks['names.bin'].length > 0);
}));

test('syncCacheAfterPull refreshes an unedited copy and keeps an edited one', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  const newer = syntheticGate();
  newer.names.write('Smith, Jo ', 0xf80, 10, 'latin1');
  await pullInto(store, newer);
  assert.strictEqual((await dk.cacheStatus(store, PHONE)).newerPull, true);
  let r = await dk.syncCacheAfterPull(store, PHONE);
  assert.deepStrictEqual([r.refreshed, r.status.newerPull], [true, false]);
  assert.ok((await working(store)).names.equals(newer.names));
  await setTalkTime(store, '2:30');
  await pullInto(store, syntheticGate());
  r = await dk.syncCacheAfterPull(store, PHONE);
  assert.deepStrictEqual([r.refreshed, r.status.newerPull], [false, true]);
  assert.strictEqual((await store.db.query("SELECT value FROM gate_settings WHERE key = 'talkTime'")).rows[0].value, '2:30');
}));

test('resetCache replaces saved edits with the last pull', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  await setTalkTime(store, '2:30');
  const status = await dk.resetCache(store, PHONE);
  assert.deepStrictEqual([status.edited, status.newerPull], [false, false]);
  assert.ok((await working(store)).names.equals(syntheticGate().names));
  assert.ok((await dk.cacheFileData(store, PHONE, 'names.map')).equals(Buffer.alloc(MAP_SIZE)));
}));

test('resetCache drops the working copy when a file is no longer pulled', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  await store.db.query("DELETE FROM gate_files WHERE copy = 'pulled' AND name = 'cards.bin'");
  const status = await dk.resetCache(store, PHONE);
  assert.strictEqual(status.files.find((f) => f.name === 'cards.bin').cached, false);
  assert.strictEqual(await dk.cacheFileData(store, PHONE, 'cards.bin'), null);
}));

test('cacheFileData only serves working-copy .bin and .map files', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  assert.ok(await dk.cacheFileData(store, PHONE, 'names.bin'));
  assert.ok(await dk.cacheFileData(store, PHONE, 'phone.map'));
  for (const name of ['../names.bin', 'base/names.bin', 'rcv_out.bin', 'ACCOUNT.DAT', null]) {
    assert.strictEqual(await dk.cacheFileData(store, PHONE, name), null);
  }
}));

test('prepareSend returns every file with its .map and the changed blocks', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  await dk.writeCacheFile(store, PHONE, 'names.bin', dk.applyGateSettings((await working(store)).names, { displayLine1: 'Welcome' }).buffer);
  const { files, maps, changedBlocks } = await dk.prepareSend(store, PHONE);
  assert.deepStrictEqual(Object.keys(files).sort(), [...dk.CACHE_FILES].sort());
  assert.deepStrictEqual(changedBlocks, { 'names.bin': [3], 'phone.bin': [], 'cards.bin': [] });
  assert.strictEqual(maps['names.bin'][3], 1);
  assert.ok(files['names.bin'].equals((await working(store)).names));
}));

test('prepareSend refuses when nothing changed, files are missing, or a newer pull differs', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  await assert.rejects(() => dk.prepareSend(store, PHONE), (e) => e.status === 409 && /no changes/.test(e.message));
  await setTalkTime(store, '2:30');
  const newer = syntheticGate();
  newer.names[0x10] = 90;
  await pullInto(store, newer);
  await assert.rejects(() => dk.prepareSend(store, PHONE), (e) => e.status === 409 && /Reset to gate/.test(e.message));
  await store.db.query("DELETE FROM gate_files WHERE copy = 'pulled' AND name = 'cards.bin'");
  await dk.resetCache(store, PHONE);
  await assert.rejects(() => dk.prepareSend(store, PHONE), (e) => e.status === 409 && /missing files/.test(e.message));
}));

test('verifySend reports matching files and the blocks that differ', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  await setTalkTime(store, '2:30');
  const w = await working(store);
  const pulled = { 'names.bin': w.names, 'phone.bin': w.phone, 'cards.bin': w.cards };
  assert.deepStrictEqual(await dk.verifySend(store, PHONE, pulled), { matches: true, differentBlocks: {} });
  const names = Buffer.from(w.names);
  names[0x300] ^= 0xff;
  const result = await dk.verifySend(store, PHONE, { ...pulled, 'names.bin': names, 'cards.bin': Buffer.alloc(10) });
  assert.strictEqual(result.matches, false);
  assert.deepStrictEqual(result.differentBlocks, { 'names.bin': [6], 'cards.bin': 'size differs' });
}));

test('addMissingSettings adds rows for settings decoded since the working copy was saved, once', withStore(async (store) => {
  const gate = syntheticGate();
  gate.names[0x0f] = 0x0a;
  gate.names[0xfb] = 0x05;
  Buffer.from('00f9e0' + '0182b0', 'hex').copy(gate.names, 0xbf);
  await pullInto(store, gate);
  await dk.ensureCache(store, PHONE);
  await setTalkTime(store, '2:30');
  const NEW = ['dialType', 'multipleSystems', 'systemMemory', 'memoryChips', 'downloadStamp1', 'downloadStamp2'];
  const rows = async () => Object.fromEntries((await store.db.query('SELECT key, value FROM gate_settings WHERE phone = $1', [PHONE])).rows
    .map((r) => [r.key, r.value]));
  const before = await rows();
  assert.deepStrictEqual(NEW.map((k) => before[k]), ['Tone', '', '3000', 'Anti-pass back', '', '']);
  await store.db.query('DELETE FROM gate_settings WHERE key = ANY($1)', [NEW]); // as saved before these were decoded
  assert.deepStrictEqual(await dk.addMissingSettings(store), [PHONE]);
  assert.deepStrictEqual(await dk.addMissingSettings(store), []);
  assert.deepStrictEqual(await rows(), before);
  assert.strictEqual((await rows()).talkTime, '2:30'); // the unsent edit stays
  const loaded = await dk.loadWorkingState(store, PHONE);
  assert.strictEqual(dk.diffStates(loaded.state, dk.decodeWorking(await working(store))), null);
}));

test('importGateFiles and migrateWorkingFiles move the files kept on disk into the database once', withStore(async (store, dir) => {
  const root = path.join(dir, 'DOWNLOADED');
  const g = path.join(root, PHONE);
  fs.mkdirSync(path.join(g, 'cache', 'base'), { recursive: true });
  fs.mkdirSync(path.join(g, 'snapshots'), { recursive: true });
  const gate = syntheticGate();
  const edited = dk.applyResidentEdit(gate, { directoryCode: '101', name: 'Edited, Unsent' });
  for (const [k, n] of [['names', 'names.bin'], ['phone', 'phone.bin'], ['cards', 'cards.bin']]) {
    fs.writeFileSync(path.join(g, n), gate[k]);
    fs.writeFileSync(path.join(g, 'cache', 'base', n), gate[k]);
    fs.writeFileSync(path.join(g, 'cache', n), edited[k]);
    fs.writeFileSync(path.join(g, 'cache', n.replace('.bin', '.map')), Buffer.alloc(500));
  }
  fs.writeFileSync(path.join(g, 'rcv_out.bin'), Buffer.alloc(100));
  fs.writeFileSync(path.join(g, 'snapshots', 'x.jpg'), 'jpg');
  assert.deepStrictEqual(await dk.importGateFiles(store, root), { [PHONE]: 10 });
  assert.strictEqual(await dk.importGateFiles(store, root), null);
  assert.deepStrictEqual(fs.readdirSync(g), ['snapshots']); // only the camera pictures stay on disk
  assert.deepStrictEqual(await dk.migrateWorkingFiles(store), [PHONE]);
  assert.deepStrictEqual(await dk.migrateWorkingFiles(store), []);
  assert.ok((await working(store)).names.equals(edited.names), 'the unsent edit is kept, as values');
  assert.strictEqual((await store.db.query("SELECT name FROM gate_residents WHERE directory_code = '101'")).rows[0].name, 'Edited, Unsent');
  assert.strictEqual((await dk.cacheStatus(store, PHONE)).edited, true);
  assert.strictEqual((await dk.readPulledFile(store, PHONE, 'rcv_out.bin')).data.length, 100);
}));

test('round-trip check: the files rebuild byte for byte from their decoded values, and a lost byte is caught', () => {
  const gate = syntheticGate();
  assert.deepStrictEqual(dk.checkRoundTrip(gate).problems, []);
  assert.deepStrictEqual(dk.cardSlots(gate.cards), [{ slot: 2, cardNumber: '00504', directoryCode: '101' }, { slot: 3, cardNumber: '15984', directoryCode: '' }]);
  assert.ok(dk.buildCards(gate.cards.length, dk.cardSlots(gate.cards)).equals(gate.cards));
  const tone = Buffer.from(gate.names);
  tone[0x07] = 0x0c; // relay 1 Momentary tone: not a digit, so it can't be written back
  assert.deepStrictEqual(dk.checkRoundTrip({ ...gate, names: tone }).problems.map((p) => [p.file, p.settings]),
    [['names.bin', ['relay1ToneMomentary']], ['names.bin', ['relay1ToneMomentary']]]);
  const phone = Buffer.from(gate.phone);
  phone[8] = 0x3f; // security level 31: outside 0-30, so it can't be written back
  assert.strictEqual(dk.checkRoundTrip({ ...gate, phone }).ok, false);
});

test('day fields keep "not set" (FF) apart from "no days" (00)', () => {
  const f = dk.GATE_SETTING_FIELDS.find((x) => x.key === 'holdOpen1Days');
  assert.strictEqual(f.type.decode(Buffer.from([0xff])), '');
  assert.deepStrictEqual([...f.type.encode('')], [0xff]);
  assert.strictEqual(f.type.decode(Buffer.from([0x00])), '0000000');
  assert.deepStrictEqual([...f.type.encode('0000000')], [0x00]);
  assert.deepStrictEqual([...f.type.encode('1000001')], [0x82]); // Sun and Sat
});

test('transactions take names from the working copy values: directory code, entry code, card', () => {
  // Records as the gate writes them: directory code 108, entry code 4821, card 12345; then card 04369 (0x1111, not on file).
  const rcv = { data: Buffer.from('1112a35300f10800ffff' + '1112e54401482100ffff' + '1112e53802303900ffff'
    + '1112e53802111100ffff', 'hex'), mtime: new Date(2026, 10, 12, 18) };
  const res = (directoryCode, name, entryCode = '') => ({ directoryCode, name, entryCode, type: 'Resident', hidden: false,
    areaCode: '', phone: '', securityLevel: '', floor: '', elevatorRef: '' });
  const values = { dirDigits: 3, areaCodeMode: 255, areaCodes: [], middlePointer: '', settings: {},
    residents: [res('108', 'Lee, K'), res('201', 'Diaz, R', '4821')],
    cards: [{ slot: 0, cardNumber: '12345', directoryCode: '305' }] };
  const rows = loadData(rcv, values, null, null).transactions.rows;
  assert.deepStrictEqual(rows.map((r) => [r.number, r.name, r.directoryCode]).reverse(),
    [['108', 'Lee, K', '108'], ['4821', 'Diaz, R', '201'], ['12345', '', '305'], ['04369', 'Unknown', '']]);
  assert.strictEqual(loadData(null, values).transactions, null);
});

test('History values patches: only what changed, reverted exactly, refused when a later change touched it', () => {
  const gate = syntheticGate();
  const w0 = dk.decodeWorking(gate);
  const renamed = dk.applyResidentEdit(gate, { directoryCode: '101', name: 'Smith, Joan' });
  const p1 = dk.diffStates(w0, dk.decodeWorking(renamed));
  assert.deepStrictEqual(Object.keys(p1.residents), ['101']);
  assert.deepStrictEqual(Object.keys(p1.layout), ['middlePointer']); // the directory changed, so the pointer was recomputed
  assert.ok(!p1.cards && !p1.settings);
  assert.deepStrictEqual([p1.residents['101'][0].name, p1.residents['101'][1].name], ['Smith, J', 'Smith, Joan']);
  assert.strictEqual(dk.diffStates(w0, dk.decodeWorking(gate)), null);
  // A later, unrelated change is kept; the rename is undone.
  const later = { ...renamed, names: dk.applyGateSettings(renamed.names, { talkTime: '2:30' }).buffer };
  const undone = dk.undoValues(dk.decodeWorking(later), p1);
  const back = dk.buildFiles(gate, undone);
  assert.strictEqual(dk.residentRows(back).rows.find((r) => r.directoryCode === '101').name, 'Smith, J');
  assert.strictEqual(dk.decodeGateSettings(back.names).find((x) => x.key === 'talkTime').value, '2:30');
  // A later change to the same resident blocks it.
  const again = dk.applyResidentEdit(renamed, { directoryCode: '101', name: 'Smith, Jane' });
  assert.strictEqual(dk.undoValues(dk.decodeWorking(again), p1), null);
  // An added code: the patch has the new row (and any entries it moved); undoing removes it.
  const added = dk.addEntry(gate, { directoryCode: '100', name: 'Adams, A' });
  const p2 = dk.diffStates(w0, dk.decodeWorking(added));
  assert.ok(p2.residents['100'][0] === null && p2.residents['100'][1].name === 'Adams, A');
  assert.deepStrictEqual(dk.fileDifferences(dk.buildFiles(gate, dk.undoValues(dk.decodeWorking(added), p2)), gate), []);
  // Digit count: layout and every code change; undoing restores 3 digits.
  const four = dk.convertDirDigits(gate, 4);
  const p3 = dk.diffStates(w0, dk.decodeWorking(four));
  assert.deepStrictEqual(p3.layout.dirDigits, [3, 4]);
  assert.deepStrictEqual(dk.fileDifferences(dk.buildFiles(gate, dk.undoValues(dk.decodeWorking(four), p3)), gate), []);
});

test('reverting a values patch goes through the same save check as an edit', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  const before = await working(store);
  const edited = dk.applyResidentEdit(before, { directoryCode: '102', name: 'FedEx', entryCode: '9999' });
  await saveWorking(store, edited);
  const patch = dk.diffStates(dk.decodeWorking(before), dk.decodeWorking(await working(store)));
  const undone = dk.undoValues(dk.decodeWorking(await working(store)), patch);
  await saveWorking(store, dk.buildFiles(syntheticGate(), undone));
  assert.strictEqual((await dk.cacheStatus(store, PHONE)).edited, false);
  assert.deepStrictEqual((await store.db.query("SELECT name, entry_code FROM gate_residents WHERE directory_code = '102'")).rows,
    [{ name: 'ACME Deliveries', entry_code: '5678' }]);
}));

test('checkPull records the round-trip check of a pull', withStore(async (store) => {
  assert.strictEqual((await dk.checkPull(store, PHONE, syntheticGate(), new Date(T1))).ok, true);
  const state = await dk.getGateState(store, PHONE);
  assert.deepStrictEqual([state.pulledAt, state.roundTripOk, state.problems], [T1, true, []]);
  const bad = syntheticGate();
  bad.names[0x07] = 0x0c;
  assert.strictEqual((await dk.checkPull(store, PHONE, bad, new Date(T2))).ok, false);
  assert.deepStrictEqual([(await dk.getGateState(store, PHONE)).pulledAt, (await dk.getGateState(store, PHONE)).roundTripOk], [T2, false]);
}));

test('deleteGateData removes every row about one gate, all access to it, and nothing else', withStore(async (store) => {
  await dk.createUser(store, { username: 'user1', password: PW, createdBy: 't' });
  await dk.createUser(store, { username: 'user2', password: PW, createdBy: 't' });
  await dk.registerGate(store, GATE_A, 'user1');
  await dk.registerGate(store, { ...GATE_A, phoneNumber: '5550111' }, 'user1');
  await dk.grantAccess(store, '5550100', 'user2', 'readonly', 'user1');
  const tok = await dk.createSession(store, 'user2');
  const sess = await dk.findSession(store, tok, 60000);
  await dk.setSessionGate(store, sess.tokenHash, '5550100');
  await dk.setPrefs(store, '5550100', { relayLabels: { 0: 'Gate' } });
  await dk.setPrefs(store, '5550111', { relayLabels: { 0: 'Other' } });
  await dk.setNote(store, '5550100', '101', 'note', 'user1');
  await dk.addEvent(store, '5550100', { user: 'user1', action: 'pull', summary: 'Pulled residents' });
  const removed = await dk.deleteGateData(store, '555-0100');
  assert.deepStrictEqual([removed.managed_gates, removed.gate_access, removed.prefs, removed.notes, removed.history], [1, 2, 1, 1, 1]);
  assert.deepStrictEqual(await dk.userGates(store, 'user2'), []);
  assert.deepStrictEqual((await dk.userGates(store, 'user1')).map((g) => g.phoneNumber), ['5550111']);
  assert.strictEqual((await dk.findSession(store, tok, 60000)).gate, null);
  assert.deepStrictEqual(await dk.getPrefs(store, '5550100'), {});
  assert.strictEqual((await dk.getPrefs(store, '5550111')).relayLabels['0'], 'Other');
  await assert.rejects(() => dk.deleteGateData(store, ''), /phone number required/);
}));

test('history lists newest first, hides patches and marks reverted events', withStore(async (store) => {
  const a = await dk.addEvent(store, '555-0100', { user: 'user1', action: 'change', summary: 'first', files: { 'names.bin': { runs: [] } } });
  await dk.addEvent(store, '5550100', { user: 'user2', action: 'pull', summary: 'Pulled residents', result: 'done' });
  await dk.addEvent(store, '5550100', { user: 'user2', action: 'revert', revertOf: a.id, summary: 'Reverted: first', files: { 'names.bin': { runs: [] } } });
  await dk.addEvent(store, '5550199', { user: 'u3', action: 'pull', summary: 'other gate' });
  const list = await dk.listHistory(store, '5550100');
  assert.deepStrictEqual(list.map((e) => e.summary), ['Reverted: first', 'Pulled residents', 'first']);
  assert.ok(list.every((e) => !('files' in e)));
  assert.strictEqual(list[2].revertible, false);
  assert.strictEqual(list[2].revertedBy.user, 'user2');
  assert.strictEqual(list[0].revertible, true);
  assert.strictEqual(list[1].revertible, false);
  assert.ok((await dk.readHistory(store, '5550100'))[0].files);
}));

test('resident notes are kept per gate and directory code, ignoring leading zeros', withStore(async (store) => {
  assert.strictEqual(await dk.setNote(store, '555-0100', '701', '  Gate code given to the cleaner  ', 'user1'), 'Gate code given to the cleaner');
  assert.strictEqual(await dk.getNote(store, '5550100', '0701'), 'Gate code given to the cleaner');
  assert.deepStrictEqual(await dk.getNotes(store, '5550100'), { 701: 'Gate code given to the cleaner' });
  assert.deepStrictEqual(await dk.getNotes(store, '5550199'), {});
  assert.strictEqual(dk.noteKey('000'), '0');
  await assert.rejects(() => dk.setNote(store, '5550100', '701', 'x'.repeat(dk.NOTE_MAX + 1), 'user1'), /at most 500/);
  assert.strictEqual(await dk.setNote(store, '5550100', '0701', ' ', 'user1'), '');
  assert.deepStrictEqual(await dk.getNotes(store, '5550100'), {});
}));

// rcv_out.bin records (no trailer, so in file order) on Oct 20 at 9:mm AM, one per minute.
const rcv = (...minutes) => Buffer.concat(minutes.map((m) => Buffer.from([0x10, 0x20, 0x09, Number(`0x${m}`), 0x02, 0x30, 0x39, 0, 0xff, 0xff])));

test('transaction history keeps events that leave the gate buffer and adds only new ones', withStore(async (store) => {
  const at = new Date(2026, 9, 21);
  assert.deepStrictEqual(await dk.mergeTransactions(store, '555-0100', rcv(10, 11, 12), at), { added: 3, kept: 0, gap: false });
  assert.deepStrictEqual(await dk.mergeTransactions(store, '5550100', rcv(11, 12, 13, 14), at), { added: 2, kept: 2, gap: false });
  assert.deepStrictEqual(await dk.mergeTransactions(store, '5550100', rcv(13, 14), at), { added: 0, kept: 2, gap: false });
  assert.deepStrictEqual(await dk.mergeTransactions(store, '5550100', rcv(30, 31), at), { added: 2, kept: 0, gap: true });
  const saved = await dk.readTransactions(store, '5550100');
  assert.deepStrictEqual(saved.map((t) => t.minute), [10, 11, 12, 13, 14, 30, 31]);
  assert.ok(saved.every((t) => t.year === 2026 && t.code === '12345'));
  assert.strictEqual(await dk.txHistoryCount(store, '5550100'), 7);
  assert.strictEqual(await dk.txHistoryCount(store, '5550199'), 0);
}));

test('database encrypts master codes and DKS logins, and keeps prefs per gate', withStore(async (store) => {
  assert.strictEqual(dk.decrypt(store, dk.encrypt(store, 'secret')), 'secret');
  assert.notStrictEqual(dk.encrypt(store, 'secret'), dk.encrypt(store, 'secret'));
  await dk.createUser(store, { username: 'user1', password: PW, createdBy: 't' });
  await dk.registerGate(store, { ...GATE_A, phoneNumber: '555-0100' }, 'USER1');
  const g = await dk.getGate(store, '5550100');
  assert.deepStrictEqual([g.masterCode, g.dksUser, g.dksPassword, g.addedBy], ['1234', 'dksuser', 'dks-secret', 'user1']);
  const raw = (await store.db.query('SELECT master_code, dks_password FROM managed_gates')).rows[0];
  assert.ok(!raw.master_code.includes('1234') && !raw.dks_password.includes('dks-secret'));
  await dk.setPrefs(store, '555-0100', { relayLabels: { 0: 'Gate' } });
  await dk.setPrefs(store, '5550100', { gateConfig: { siteName: 'A' } });
  assert.deepStrictEqual(await dk.getPrefs(store, '5550100'), { relayLabels: { 0: 'Gate' }, gateConfig: { siteName: 'A' } });
  assert.deepStrictEqual(await dk.setPrefs(store, '5550100', { gateConfig: undefined }), { relayLabels: { 0: 'Gate' } });
  assert.deepStrictEqual(await dk.getPrefs(store, '5550199'), {});
}));

test('accounts: rules, scrypt hashes, unique usernames and emails, own settings and password', withStore(async (store) => {
  assert.throws(() => dk.checkUsername('ab'), /3-32/);
  assert.throws(() => dk.checkUsername('bad name'), /3-32/);
  assert.strictEqual(dk.checkUsername(' Jane.Doe '), 'jane.doe');
  assert.throws(() => dk.checkPassword('short'), /at least 12/);
  assert.throws(() => dk.checkEmail('nope'), /email/);
  assert.strictEqual(await dk.userCount(store), 0);
  const u = await dk.createUser(store, { username: 'Jane', password: PW, email: 'Jane@Example.com', createdBy: 'admin' });
  assert.deepStrictEqual([u.username, u.email, u.pendingEmail, u.mustChangePassword, u.createdBy], ['jane', '', 'jane@example.com', true, 'admin']);
  const hash = (await store.db.query('SELECT password_hash FROM users')).rows[0].password_hash;
  assert.ok(hash.startsWith('scrypt$') && !hash.includes(PW));
  await assert.rejects(() => dk.createUser(store, { username: 'JANE', password: PW, createdBy: 'x' }), (e) => e.status === 409 && /already taken/.test(e.message));
  await dk.confirmEmail(store, 'jane', 'jane@example.com');
  assert.strictEqual((await dk.getUser(store, 'jane')).email, 'jane@example.com');
  await assert.rejects(() => dk.createUser(store, { username: 'john', password: PW, email: 'jane@EXAMPLE.com', createdBy: 'x' }), /already used/);
  assert.strictEqual(await dk.authenticate(store, 'jane', 'wrong password!!'), null);
  assert.strictEqual(await dk.authenticate(store, 'nobody', PW), null);
  const signed = await dk.authenticate(store, 'JANE', PW);
  assert.deepStrictEqual([signed.username, signed.signIns, Boolean(signed.lastSignIn)], ['jane', 1, true]);
  // Own settings: email (unique once confirmed, '' removes) and dark mode.
  await dk.createUser(store, { username: 'john', password: PW, email: 'john@example.com', createdBy: 'x' });
  await dk.confirmEmail(store, 'john', 'john@example.com');
  await assert.rejects(() => dk.updateUserSettings(store, 'jane', { email: 'john@example.com' }), /already used/);
  assert.deepStrictEqual(await dk.updateUserSettings(store, 'jane', { email: '', dark: true }).then((x) => [x.email, x.dark]), ['', true]);
  // Phone: international form; 10 digits = US/Canada; '' removes it; not unique.
  assert.strictEqual(dk.checkUserPhone('(214) 555-0100'), '+12145550100');
  assert.strictEqual(dk.checkUserPhone('1-214-555-0100'), '+12145550100');
  assert.strictEqual(dk.checkUserPhone('+44 20 7946 0958'), '+442079460958');
  assert.strictEqual(dk.checkUserPhone('  '), '');
  assert.throws(() => dk.checkUserPhone('555-0100'), /10-digit/);
  assert.throws(() => dk.checkUserPhone('+0 123 456 789'), /country code/);
  assert.throws(() => dk.checkUserPhone('214 555 01OO'), /only have digits/);
  assert.strictEqual((await dk.updateUserSettings(store, 'jane', { phone: '214.555.0100' })).phone, '+12145550100');
  assert.strictEqual((await dk.updateUserSettings(store, 'john', { phone: '+1 214 555 0100' })).phone, '+12145550100');
  assert.strictEqual((await dk.updateUserSettings(store, 'jane', { dark: false })).phone, '+12145550100'); // untouched
  assert.strictEqual((await dk.updateUserSettings(store, 'jane', { phone: '' })).phone, '');
  // Own password change: needs the current one; ends the other sessions, keeps this one; clears must-change.
  const keep = await dk.findSession(store, await dk.createSession(store, 'jane'), 60000);
  const othertoken = await dk.createSession(store, 'jane');
  await assert.rejects(() => dk.changeOwnPassword(store, 'jane', 'wrong password!!', NEW_PW, keep.tokenHash), /current password is wrong/);
  await assert.rejects(() => dk.changeOwnPassword(store, 'jane', PW, PW, keep.tokenHash), /different/);
  await dk.changeOwnPassword(store, 'jane', PW, NEW_PW, keep.tokenHash);
  assert.strictEqual(await dk.findSession(store, othertoken, 60000), null);
  assert.ok(await dk.findSession(store, '0'.repeat(64), 60000) === null);
  assert.strictEqual((await dk.getUser(store, 'jane')).mustChangePassword, false);
  assert.ok(await dk.authenticate(store, 'jane', NEW_PW));
  // The CLI's reset: a temporary password the user must change; every session ends.
  await dk.setPassword(store, 'jane', PW, { mustChange: true });
  assert.strictEqual((await dk.getUser(store, 'jane')).mustChangePassword, true);
  assert.strictEqual((await store.db.query("SELECT COUNT(*)::int AS n FROM sessions WHERE username = 'jane'")).rows[0].n, 0);
}));

test('email: confirmation, unconfirmed addresses never block, reset lookup, invitations, notifications switch', withStore(async (store) => {
  await dk.createUser(store, { username: 'ann', password: PW, createdBy: 't', mustChangePassword: false });
  // A new address waits for its link; the confirmed one stays meanwhile.
  let u = await dk.updateUserSettings(store, 'ann', { email: 'Ann@Example.com' });
  assert.deepStrictEqual([u.email, u.pendingEmail], ['', 'ann@example.com']);
  const t1 = await dk.createToken(store, 'verify', 'ann', 'ann@example.com');
  assert.strictEqual(await dk.useToken(store, 'reset', t1), null); // wrong kind (and now used up)
  const t2 = await dk.createToken(store, 'verify', 'ann', 'ann@example.com');
  const t3 = await dk.createToken(store, 'verify', 'ann', 'ann@example.com'); // replaces t2
  assert.strictEqual(await dk.useToken(store, 'verify', t2), null);
  assert.deepStrictEqual(await dk.useToken(store, 'verify', t3), { username: 'ann', data: 'ann@example.com' });
  assert.strictEqual(await dk.useToken(store, 'verify', t3), null); // once only
  assert.ok(!(await store.db.query('SELECT token_hash FROM email_tokens')).rows.some((r) => r.token_hash === t3));
  u = await dk.confirmEmail(store, 'ann', 'ann@example.com');
  assert.deepStrictEqual([u.email, u.pendingEmail], ['ann@example.com', '']);
  u = await dk.updateUserSettings(store, 'ann', { email: 'new@example.com' });
  assert.deepStrictEqual([u.email, u.pendingEmail], ['ann@example.com', 'new@example.com']);
  // Someone typing ann's address (or a stranger's) doesn't take it: only confirming does, and only once.
  await dk.createUser(store, { username: 'bob', password: PW, createdBy: 't', email: 'new@example.com' });
  await dk.confirmEmail(store, 'bob', 'new@example.com');
  await assert.rejects(() => dk.confirmEmail(store, 'ann', 'new@example.com'), /already used/);
  await assert.rejects(() => dk.confirmEmail(store, 'ann', 'other@example.com'), /no longer waiting/);
  // Expired links don't work.
  const t4 = await dk.createToken(store, 'reset', 'ann');
  await store.db.query("UPDATE email_tokens SET expires_at = now() - interval '1 second'");
  assert.strictEqual(await dk.useToken(store, 'reset', t4), null);
  assert.strictEqual(await dk.deleteExpiredTokens(store), 0); // useToken already removed it
  // Reset: by username or confirmed email; never for an account without one.
  assert.strictEqual((await dk.userForReset(store, 'ANN@example.com')).username, 'ann');
  assert.strictEqual((await dk.userForReset(store, 'ann')).username, 'ann');
  await dk.createUser(store, { username: 'cyd', password: PW, createdBy: 't', email: 'cyd@example.com' });
  assert.strictEqual(await dk.userForReset(store, 'cyd'), null); // unconfirmed
  assert.strictEqual(await dk.userForReset(store, 'nobody'), null);
  // Invitations: no password until accepted (can't sign in), then the email counts as confirmed.
  await assert.rejects(() => dk.createUser(store, { username: 'dee', createdBy: 'ann', invite: true }), /needs an email/);
  const dee = await dk.createUser(store, { username: 'dee', createdBy: 'ann', email: 'dee@example.com', invite: true });
  assert.deepStrictEqual([dee.invited, dee.mustChangePassword, dee.pendingEmail], [true, false, 'dee@example.com']);
  assert.strictEqual(await dk.authenticate(store, 'dee', '!'), null);
  assert.strictEqual(await dk.userForReset(store, 'dee'), null);
  const accepted = await dk.acceptInvite(store, 'dee', NEW_PW);
  assert.deepStrictEqual([accepted.invited, accepted.email, accepted.pendingEmail], [false, 'dee@example.com', '']);
  await assert.rejects(() => dk.acceptInvite(store, 'dee', NEW_PW), /already used/);
  assert.ok(await dk.authenticate(store, 'dee', NEW_PW));
  // Gate alerts go to admins with a confirmed email and alerts on.
  await dk.registerGate(store, GATE_A, 'ann');
  await dk.grantAccess(store, '5550100', 'dee', 'admin', 'ann');
  await dk.grantAccess(store, '5550100', 'bob', 'readonly', 'ann');
  assert.deepStrictEqual((await dk.alertRecipients(store, '5550100')).map((r) => r.username).sort(), ['ann', 'dee']);
  await dk.updateUserSettings(store, 'dee', { notifyAlerts: false, notifyAccess: false });
  assert.deepStrictEqual((await dk.alertRecipients(store, '5550100')).map((r) => r.username), ['ann']);
  assert.strictEqual((await dk.getUser(store, 'dee')).notifyAccess, false);
  assert.ok((await dk.gateUsers(store, '5550100')).every((g) => g.invited === false));
  await dk.updateUserSettings(store, 'bob', { phone: '2145550100' });
  assert.strictEqual((await dk.gateUsers(store, '5550100')).find((g) => g.username === 'bob').phone, '+12145550100');
}));

test('email outbox: bodies encrypted until sent, retries with a growing wait, then given up', withStore(async (store) => {
  const sent = [];
  let fail = false;
  const mailer = { sendMail: async (m) => { if (fail) throw new Error('SMTP 421 try later'); sent.push(m); } };
  const id = await dk.queueEmail(store, { to: 'a@example.com', subject: 'Hi', text: 'secret link https://x/#reset=abc', kind: 'reset' });
  const raw = (await store.db.query('SELECT body FROM emails WHERE id = $1', [id])).rows[0].body;
  assert.ok(raw.startsWith('v1:') && !raw.includes('reset=abc'));
  assert.deepStrictEqual(await dk.sendQueued(store, mailer, 'Gate <gate@example.com>'), { sent: 1, failed: 0 });
  assert.deepStrictEqual([sent[0].to, sent[0].from, sent[0].text], ['a@example.com', 'Gate <gate@example.com>', 'secret link https://x/#reset=abc']);
  let row = (await store.db.query('SELECT status, body, sent_at FROM emails WHERE id = $1', [id])).rows[0];
  assert.deepStrictEqual([row.status, row.body, Boolean(row.sent_at)], ['sent', null, true]);
  fail = true;
  const id2 = await dk.queueEmail(store, { to: 'b@example.com', subject: 'Hi', text: 'x', kind: 'access' });
  const logs = [];
  for (let i = 0; i < 6; i++) {
    await dk.sendQueued(store, mailer, 'g@example.com', (m) => logs.push(m));
    await store.db.query("UPDATE emails SET next_try = now() WHERE id = $1 AND status = 'queued'", [id2]); // skip the wait
  }
  row = (await store.db.query('SELECT status, attempts, error, body FROM emails WHERE id = $1', [id2])).rows[0];
  assert.deepStrictEqual([row.status, row.attempts, row.error, row.body], ['failed', 6, 'SMTP 421 try later', null]);
  assert.match(logs[0], /trying again in 1 min/);
  assert.match(logs[5], /given up/);
  assert.deepStrictEqual((await dk.listEmails(store)).map((e) => [e.to, e.status]), [['b@example.com', 'failed'], ['a@example.com', 'sent']]);
  assert.match(dk.messages.reset('https://gate.example.com', 'ann', 'TOK').text, /https:\/\/gate\.example\.com\/#reset=TOK/);
}));

test('old emails become unconfirmed once', withStore(async (store) => {
  await dk.createUser(store, { username: 'ann', password: PW, createdBy: 't' });
  await store.db.query("UPDATE users SET email = 'ann@example.com', pending_email = NULL");
  assert.strictEqual(await dk.unconfirmOldEmails(store), 1);
  assert.deepStrictEqual(await dk.getUser(store, 'ann').then((u) => [u.email, u.pendingEmail]), ['', 'ann@example.com']);
  await dk.confirmEmail(store, 'ann', 'ann@example.com');
  assert.strictEqual(await dk.unconfirmOldEmails(store), null);
  assert.strictEqual((await dk.getUser(store, 'ann')).email, 'ann@example.com');
}));

test('sessions: stored hashed, found by token, ended when idle, open gate kept', withStore(async (store) => {
  await dk.createUser(store, { username: 'jane', password: PW, createdBy: 't' });
  const tok = await dk.createSession(store, 'jane');
  assert.match(tok, /^[a-f0-9]{64}$/);
  const row = (await store.db.query('SELECT token_hash FROM sessions')).rows[0];
  assert.ok(row.token_hash !== tok);
  const sess = await dk.findSession(store, tok, 60000);
  assert.deepStrictEqual([sess.username, sess.gate], ['jane', null]);
  await dk.setSessionGate(store, sess.tokenHash, '5550100');
  assert.strictEqual((await dk.findSession(store, tok, 60000)).gate, '5550100');
  await store.db.query("UPDATE sessions SET last_seen = now() - interval '2 hours'");
  assert.deepStrictEqual(await dk.sweepSessions(store, 3600000), ['jane']);
  assert.strictEqual(await dk.findSession(store, tok, 3600000), null);
  const t2 = await dk.createSession(store, 'jane');
  await store.db.query("UPDATE sessions SET last_seen = now() - interval '2 hours'");
  assert.strictEqual(await dk.findSession(store, t2, 3600000), null); // idle: refused and deleted
  assert.strictEqual((await store.db.query('SELECT COUNT(*)::int AS n FROM sessions')).rows[0].n, 0);
}));

test('gates: added once, roles, sharing, and a gate always keeps an admin', withStore(async (store) => {
  for (const u of ['ann', 'bob', 'cyd']) await dk.createUser(store, { username: u, password: PW, createdBy: 't' });
  await assert.rejects(() => dk.registerGate(store, { ...GATE_A, masterCode: '12' }, 'ann'), /Master code/);
  await assert.rejects(() => dk.registerGate(store, { ...GATE_A, dksUser: '' }, 'ann'), /DKS user and password/);
  await dk.registerGate(store, GATE_A, 'ann');
  assert.strictEqual(await dk.gateExists(store, '555-0100'), true);
  await assert.rejects(() => dk.registerGate(store, GATE_A, 'bob'), (e) => e.status === 409 && e.message === dk.ALREADY_ADDED);
  assert.strictEqual(await dk.accessOf(store, '5550100', 'ann'), 'admin');
  assert.strictEqual(await dk.accessOf(store, '5550100', 'bob'), null);
  // Sharing: existing users only, once.
  await assert.rejects(() => dk.grantAccess(store, '5550100', 'nobody', 'readonly', 'ann'), (e) => e.status === 404);
  await assert.rejects(() => dk.grantAccess(store, '5550100', 'bob', 'owner', 'ann'), /admin or readonly/);
  await dk.grantAccess(store, '5550100', 'BOB', 'readonly', 'ann');
  await assert.rejects(() => dk.grantAccess(store, '5550100', 'bob', 'admin', 'ann'), (e) => e.status === 409 && /already has access/.test(e.message));
  assert.deepStrictEqual((await dk.userGates(store, 'bob')).map((g) => [g.phoneNumber, g.role]), [['5550100', 'readonly']]);
  assert.deepStrictEqual((await dk.gateUsers(store, '5550100')).map((u) => [u.username, u.role, u.grantedBy]), [['ann', 'admin', 'ann'], ['bob', 'readonly', 'ann']]);
  assert.strictEqual(await dk.isAnyGateAdmin(store, 'bob'), false);
  // The last admin can't be demoted or removed (or leave); with a second admin they can.
  await assert.rejects(() => dk.setRole(store, '5550100', 'ann', 'readonly'), /keep at least one admin/);
  await assert.rejects(() => dk.revokeAccess(store, '5550100', 'ann'), /keep at least one admin/);
  await dk.setRole(store, '5550100', 'bob', 'admin');
  await dk.revokeAccess(store, '5550100', 'ann');
  assert.deepStrictEqual((await dk.gateUsers(store, '5550100')).map((u) => u.username), ['bob']);
  await assert.rejects(() => dk.revokeAccess(store, '5550100', 'cyd'), (e) => e.status === 404);
  // The gate's login: blank password keeps the saved one; master code checked.
  const g = await dk.updateGateLogin(store, '5550100', { dksUser: 'other', dksPassword: '' });
  assert.deepStrictEqual([g.dksUser, g.dksPassword, g.masterCode], ['other', 'dks-secret', '1234']);
  await assert.rejects(() => dk.updateGateLogin(store, '5550100', { masterCode: '99' }), /Master code/);
  assert.strictEqual((await dk.updateGateLogin(store, '5550100', { masterCode: '4321' })).masterCode, '4321');
}));

test('API keys: per gate, shown once, stored hashed, role and expiry, revoked at once, gone with the gate', withStore(async (store) => {
  await dk.createUser(store, { username: 'ann', password: PW, createdBy: 't' });
  await dk.registerGate(store, GATE_A, 'ann');
  await dk.registerGate(store, { ...GATE_A, phoneNumber: '5550111' }, 'ann');
  await assert.rejects(() => dk.createApiKey(store, '5550100', { name: '', role: 'readonly' }, 'ann'), /name/);
  await assert.rejects(() => dk.createApiKey(store, '5550100', { name: 'x', role: 'owner' }, 'ann'), /admin or readonly/);
  await assert.rejects(() => dk.createApiKey(store, '5550100', { name: 'x', role: 'readonly', expiresDays: 7 }, 'ann'), /Expiry/);
  const { key, apiKey } = await dk.createApiKey(store, '555-0100', { name: 'Home Assistant', role: 'readonly' }, 'ANN');
  assert.match(key, /^dkg_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  assert.deepStrictEqual([apiKey.name, apiKey.role, apiKey.createdBy, apiKey.expiresAt, apiKey.lastUsedAt], ['Home Assistant', 'readonly', 'ann', null, null]);
  const row = (await store.db.query('SELECT * FROM api_keys')).rows[0];
  assert.ok(!JSON.stringify(row).includes(key.slice(17))); // the secret after dkg_<id>_
  assert.deepStrictEqual(await dk.findApiKey(store, key), { id: apiKey.id, phone: '5550100', name: 'Home Assistant', role: 'readonly' });
  assert.ok((await dk.listApiKeys(store, '5550100'))[0].lastUsedAt);
  assert.strictEqual(await dk.findApiKey(store, `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`), null); // wrong secret
  assert.strictEqual(await dk.findApiKey(store, 'dkg_nothex'), null);
  // Not tied to its creator: it keeps working when they lose access.
  await dk.createUser(store, { username: 'bob', password: PW, createdBy: 't' });
  await dk.grantAccess(store, '5550100', 'bob', 'admin', 'ann');
  const bobs = await dk.createApiKey(store, '5550100', { name: 'Bob script', role: 'admin', expiresDays: 30 }, 'bob');
  await dk.revokeAccess(store, '5550100', 'bob');
  assert.strictEqual((await dk.findApiKey(store, bobs.key)).role, 'admin');
  assert.ok(new Date(bobs.apiKey.expiresAt).getTime() > Date.now() + 29 * 86400000);
  await store.db.query("UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1", [bobs.apiKey.id]);
  assert.strictEqual(await dk.findApiKey(store, bobs.key), null); // expired
  // Revoking is per gate and immediate; deleting the gate's data removes its keys.
  await assert.rejects(() => dk.revokeApiKey(store, '5550111', apiKey.id), (e) => e.status === 404);
  assert.strictEqual(await dk.revokeApiKey(store, '5550100', apiKey.id), 'Home Assistant');
  assert.strictEqual(await dk.findApiKey(store, key), null);
  const other = await dk.createApiKey(store, '5550111', { name: 'Other', role: 'readonly' }, 'ann');
  assert.strictEqual((await dk.deleteGateData(store, '5550111')).api_keys, 1);
  assert.strictEqual(await dk.findApiKey(store, other.key), null);
}));

// A software authenticator (ES256) that answers WebAuthn registration and sign-in like a real passkey would.
function softAuthenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  const b64 = (b) => Buffer.from(b).toString('base64url');
  const sha = (b) => crypto.createHash('sha256').update(b).digest();
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]]));
  const counter = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const client = (type, challenge, origin) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: b64(credId),
    register(options, origin = 'https://gate.example.com') {
      const authData = Buffer.concat([sha(options.rp.id), Buffer.from([0x45]), counter(0), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, Buffer.from(cose)]);
      const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]));
      return { id: b64(credId), rawId: b64(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64(client('webauthn.create', options.challenge, origin)), attestationObject: b64(attestationObject), transports: ['internal'] } };
    },
    signIn(options, n, origin = 'https://gate.example.com') {
      const authData = Buffer.concat([sha(options.rpId), Buffer.from([0x05]), counter(n)]);
      const cd = client('webauthn.get', options.challenge, origin);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha(cd)]), privateKey);
      return { id: b64(credId), rawId: b64(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64(cd), authenticatorData: b64(authData), signature: b64(signature) } };
    },
  };
}

test('passkeys: added with a real WebAuthn answer, sign in, one-use challenges, site and counter checks', withStore(async (store) => {
  const RP = { rpID: 'gate.example.com', origin: 'https://gate.example.com' };
  await dk.createUser(store, { username: 'ann', password: PW, createdBy: 't', mustChangePassword: false });
  assert.strictEqual(await dk.checkOwnPassword(store, 'ann', PW), true);
  assert.strictEqual(await dk.checkOwnPassword(store, 'ann', 'wrong password!!'), false);
  const key = softAuthenticator();
  const opts = await dk.registrationOptions(store, 'ann', RP);
  assert.deepStrictEqual([opts.rp.id, opts.authenticatorSelection.residentKey, opts.authenticatorSelection.userVerification], ['gate.example.com', 'required', 'required']);
  await assert.rejects(() => dk.addPasskey(store, 'ann', key.register(opts, 'https://evil.example.com'), 'Phone', RP), /could not be added/); // wrong origin (challenge now used up)
  await assert.rejects(() => dk.addPasskey(store, 'ann', key.register(opts), 'Phone', RP), /could not be added/); // challenge used once
  const opts2 = await dk.registrationOptions(store, 'ann', RP);
  const pk = await dk.addPasskey(store, 'ann', key.register(opts2), 'Phone', RP);
  assert.deepStrictEqual([pk.id, pk.name, pk.site, pk.lastUsedAt], [key.id, 'Phone', 'gate.example.com', null]);
  const handle = (await store.db.query('SELECT webauthn_id FROM users')).rows[0].webauthn_id;
  assert.ok(handle && !handle.includes('ann'));
  assert.deepStrictEqual((await dk.registrationOptions(store, 'ann', RP)).excludeCredentials.map((c) => c.id), [key.id]);
  // Sign-in: no username; the right challenge, origin, site and a rising counter.
  const a1 = await dk.authenticationOptions(RP);
  assert.strictEqual(await dk.signInWithPasskey(store, key.signIn(a1, 5), RP), 'ann');
  assert.ok((await dk.listPasskeys(store, 'ann'))[0].lastUsedAt);
  await assert.rejects(() => dk.signInWithPasskey(store, key.signIn(a1, 6), RP), (e) => e.status === 401); // challenge reused
  const a2 = await dk.authenticationOptions(RP);
  await assert.rejects(() => dk.signInWithPasskey(store, key.signIn(a2, 3), RP), (e) => e.status === 401); // counter went back
  const a3 = await dk.authenticationOptions(RP);
  await assert.rejects(() => dk.signInWithPasskey(store, key.signIn(a3, 9, 'https://evil.example.com'), RP), /Passkey sign-in failed/);
  const a4 = await dk.authenticationOptions({ rpID: 'localhost', origin: 'http://localhost:8080' });
  await assert.rejects(() => dk.signInWithPasskey(store, key.signIn(a4, 9, 'http://localhost:8080'), { rpID: 'localhost', origin: 'http://localhost:8080' }),
    /not registered here/); // made for the public name only
  await assert.rejects(async () => dk.signInWithPasskey(store, softAuthenticator().signIn(await dk.authenticationOptions(RP), 1), RP), /not registered here/);
  // A registration challenge can't be used to sign in.
  const reg = await dk.registrationOptions(store, 'ann', RP);
  await assert.rejects(() => dk.signInWithPasskey(store, key.signIn({ rpId: RP.rpID, challenge: reg.challenge }, 20), RP), (e) => e.status === 401);
  // Rename, remove (only your own).
  await dk.createUser(store, { username: 'bob', password: PW, createdBy: 't' });
  await assert.rejects(() => dk.removePasskey(store, 'bob', key.id), (e) => e.status === 404);
  await dk.renamePasskey(store, 'ann', key.id, 'iPhone');
  assert.strictEqual((await dk.listPasskeys(store, 'ann'))[0].name, 'iPhone');
  assert.strictEqual(await dk.removePasskey(store, 'ann', key.id), 'iPhone');
  await assert.rejects(async () => dk.signInWithPasskey(store, key.signIn(await dk.authenticationOptions(RP), 30), RP), /not registered here/);
}));

test('docs/openapi.json matches the routes an API key can use (paths, methods, roles) and its references resolve', () => {
  const root = path.join(import.meta.dirname, '..');
  const src = fs.readFileSync(path.join(root, 'web', 'server.ts'), 'utf8');
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'openapi.json'), 'utf8'));
  const fromRoutes = new Map();
  for (const m of src.matchAll(/(webOnly\()?route\('(GET|POST|PUT|DELETE)', (`[^`]*`|'[^']*'|G), '([a-z-]+)'/g)) {
    const [, webOnly, method, raw, scope] = m;
    if (webOnly || !scope.startsWith('gate')) continue;
    const sub = raw === 'G' ? '' : raw.replace(/^[`']|[`']$/g, '').replace('${G}', '');
    fromRoutes.set(`${method.toLowerCase()} /api/gates/{phone}${sub.replace(/:(\w+)/g, '{$1}')}`, scope === 'gate' ? 'readonly' : 'admin');
  }
  const fromSpec = new Map();
  for (const [p, ops] of Object.entries(spec.paths)) for (const [method, o] of Object.entries(ops)) fromSpec.set(`${method} ${p}`, o['x-role']);
  const missing = [...fromRoutes.keys()].filter((k) => !fromSpec.has(k));
  const extra = [...fromSpec.keys()].filter((k) => !fromRoutes.has(k));
  assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] }, 'every API-key route is in the spec, and nothing else');
  for (const [k, role] of fromRoutes) assert.strictEqual(fromSpec.get(k), role, `x-role of ${k}`);
  // Every $ref points somewhere, and every {param} in a path is declared by its operations.
  const resolve = (r) => r.slice(2).split('/').reduce((o, k) => (o ? o[k] : undefined), spec);
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === '$ref') assert.ok(resolve(x), `unresolved ${x}`); else walk(x); }
  };
  walk(spec);
  for (const [p, ops] of Object.entries(spec.paths)) {
    const want = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [method, o] of Object.entries(ops)) {
      const have = (o.parameters || []).map((x) => resolve(x.$ref)).filter((x) => x.in === 'path').map((x) => x.name).sort();
      assert.deepStrictEqual(have, want, `path parameters of ${method} ${p}`);
    }
  }
  assert.strictEqual(spec.openapi, '3.1.0');
  assert.strictEqual(spec.components.securitySchemes.apiKey.scheme, 'bearer');
});

test('moving from DKS sign-in: gates with a saved DKS login, adopted by the first account', withStore(async (store) => {
  const enc = (v) => dk.encrypt(store, v);
  await store.db.query(`INSERT INTO gates (username, phone, master_code, added_at, verified_at) VALUES
    ('dks1', '5550100', $1, $3, $3), ('dks2', '5550100', $2, $3, $3), ('dks2', '5550111', $2, $3, $3), ('dks3', '5550122', $2, $3, NULL)`,
  [enc('1234'), enc('9999'), T1]);
  await store.db.query('INSERT INTO credentials (username, login, password, saved_at) VALUES ($1, $2, $3, $4)', ['dks1', 'DKS1', enc('pw1'), T1]);
  assert.deepStrictEqual(await dk.migrateToLocalAccounts(store), { gates: ['5550100', '5550111'], noLogin: ['5550111'] });
  assert.strictEqual(await dk.migrateToLocalAccounts(store), null);
  const a = await dk.getGate(store, '5550100');
  assert.deepStrictEqual([a.masterCode, a.dksUser, a.dksPassword], ['1234', 'DKS1', 'pw1']); // the entry with a saved login wins
  const b = await dk.getGate(store, '5550111');
  assert.deepStrictEqual([b.masterCode, b.dksUser, b.dksPassword], ['9999', '', '']);
  assert.strictEqual(await dk.getGate(store, '5550122'), null); // never connected
  await dk.createUser(store, { username: 'owner', password: PW, createdBy: 'setup', mustChangePassword: false });
  assert.deepStrictEqual(await dk.adoptAdminlessGates(store, 'owner'), ['5550100', '5550111']);
  assert.deepStrictEqual(await dk.adoptAdminlessGates(store, 'owner'), []);
  assert.strictEqual(await dk.accessOf(store, '5550111', 'owner'), 'admin');
}));

test('config: defaults, file, environment and flags, checked values and private files', withDir(async (dir) => {
  assert.throws(() => dk.loadConfig({ env: {}, args: ['--config', path.join(dir, 'missing.json')] }), /not found/);
  const file = path.join(dir, 'conf', 'config.json');
  fs.mkdirSync(path.dirname(file));
  const write = (o) => fs.writeFileSync(file, JSON.stringify(o), { mode: 0o600 });
  write({ server: { publicHost: 'Gate.Example.com' }, database: { password: 'pw', name: 'gates' }, paths: { media: '../m' } });
  const c = dk.loadConfig({ file, env: {}, args: [] });
  assert.strictEqual(c.file, file);
  assert.deepStrictEqual([c.server.port, c.server.publicHost], [8080, 'gate.example.com']);
  assert.deepStrictEqual(c.paths, { media: path.join(dir, 'm'), logs: path.join(dir, 'conf', 'logs'), keyFile: path.join(dir, 'conf', 'doorking.key') });
  assert.strictEqual(c.database.user, 'doorking'); // default kept beside the file's values
  assert.deepStrictEqual(dk.connectionSettings(c.database), { host: '127.0.0.1', port: 5432, user: 'doorking', password: 'pw', database: 'gates' });
  assert.strictEqual(dk.connectionSettings(c.database, c.database.testName).database, 'doorking_test');
  assert.strictEqual(dk.maskedConfig(c).database.password, '***');
  assert.strictEqual(c.security.sessionIdleMinutes, 30);
  assert.strictEqual(c.cameras.ffmpeg, '');
  write({ database: { password: 'pw' }, cameras: { ffmpeg: '../bin/ffmpeg' } });
  assert.strictEqual(dk.loadConfig({ file, env: {}, args: [] }).cameras.ffmpeg, path.join(dir, 'bin', 'ffmpeg'));
  write({ database: { password: 'pw' }, cameras: { ffmpeg: 'ffmpeg' } });
  assert.strictEqual(dk.loadConfig({ file, env: {}, args: [] }).cameras.ffmpeg, 'ffmpeg'); // left for the PATH
  // Environment over the file, flags over both.
  const o = dk.loadConfig({ file, env: { PORT: '9000', DATABASE_URL: 'postgres://u:secret@db/x' }, args: ['--port', '9100', '--media', 'pics', '--site-name', 'Lobby'] });
  assert.deepStrictEqual([o.server.port, o.paths.media, o.gateDefaults.siteName], [9100, path.join(dir, 'conf', 'pics'), 'Lobby']);
  assert.deepStrictEqual(dk.connectionSettings(o.database, 'other'), { connectionString: 'postgres://u:secret@db/other' });
  assert.strictEqual(dk.maskedConfig(o).database.url, 'postgres://u:***@db/x');
  // Mistakes are refused with the setting's name.
  write({ server: { prot: 1 } });
  assert.throws(() => dk.loadConfig({ file, env: {}, args: [] }), /unknown setting "server.prot"/);
  write({ server: { port: 70000 } });
  assert.throws(() => dk.loadConfig({ file, env: {}, args: [] }), /"server.port" must be a whole number from 1 to 65535/);
  write({ database: { password: 1234 } });
  assert.throws(() => dk.loadConfig({ file, env: {}, args: [] }), /"database.password" must be text/);
  write({ cameras: {}, extra: {} });
  assert.throws(() => dk.loadConfig({ file, env: {}, args: [] }), /unknown section "extra"/);
  fs.writeFileSync(file, '{ "server": ');
  assert.throws(() => dk.loadConfig({ file, env: {}, args: [] }), /not valid JSON/);
  write({ database: {} });
  assert.throws(() => dk.connectionSettings(dk.loadConfig({ file, env: {}, args: [] }).database), /No database password/);
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o644);
    assert.throws(() => dk.loadConfig({ file, env: {}, args: [] }), /can be read by other users/);
  }
}));

test('database setup: sql/schema.sql, login from config, db-setup on existing role and database', withStore(async (store) => {
  // Every table in the schema file is created, and nothing else.
  const inFile = [...fs.readFileSync(dk.SCHEMA_FILE, 'utf8').matchAll(/^CREATE TABLE IF NOT EXISTS (\w+)/gm)].map((m) => m[1]).sort();
  const made = (await dk.all(store, 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = $1', [store.schema])).map((r) => r.t).sort();
  assert.ok(inFile.length > 20);
  assert.deepStrictEqual(made, inFile);
  await store.pool.query(fs.readFileSync(dk.SCHEMA_FILE, 'utf8')); // applying it again changes nothing
  // The app's login, from the separate fields or from database.url.
  const fields = { url: '', host: 'h', port: 5432, name: 'gates', user: 'app', ['pass' + 'word']: 'pw1', poolSize: 5, testName: 't' };
  assert.deepStrictEqual(dk.databaseLogin(fields), { user: 'app', ['pass' + 'word']: 'pw1', name: 'gates' });
  assert.deepStrictEqual(dk.databaseLogin({ ...fields, url: 'postgres://some%40one:p%3Aw@db:5432/other' }), { user: 'some@one', ['pass' + 'word']: 'p:w', name: 'other' });
  // Names are checked before connecting.
  await assert.rejects(dk.setupDatabase({}, { user: 'x"; DROP ROLE y; --', ['pass' + 'word']: 'p', databases: [] }), /Invalid name/);
  await assert.rejects(dk.setupDatabase({}, { user: 'app', ['pass' + 'word']: 'p', databases: ['Gates'] }), /Invalid name "Gates"/);
  // An existing role and database are left alone (the test login can't create either).
  const { u, d } = (await dk.all(store, 'SELECT current_user AS u, current_database() AS d'))[0];
  assert.deepStrictEqual(await dk.setupDatabase(TEST_DB, { user: u, ['pass' + 'word']: '', databases: [d] }),
    [`Login role ${u}: already exists (password left unchanged)`, `Database ${d}: already exists, owned by ${u}`]);
}));

test('schedules: validation, due times and missed runs', withStore(async (store) => {
  assert.match(dk.normalizeSchedule({ days: [], time: '02:00', actions: ['send'] }).error, /day/);
  assert.match(dk.normalizeSchedule({ days: [1], time: '24:00', actions: ['send'] }).error, /Time/);
  assert.match(dk.normalizeSchedule({ days: [1], time: '2:00', actions: ['x'] }).error, /transfer/);
  assert.deepStrictEqual(dk.normalizeSchedule({ days: [3, 1, 1, 9], time: '2:05', actions: ['snapshots', 'transactions', 'send'] }).schedule,
    { days: [1, 3], time: '02:05', actions: ['send', 'transactions', 'snapshots'], enabled: true });
  // Wednesday 2026-10-14 10:00 local time.
  const now = new Date(2026, 9, 14, 10, 0);
  const s = { days: [1, 3], time: '09:30', enabled: true };
  assert.deepStrictEqual(dk.lastDue(s, now), new Date(2026, 9, 14, 9, 30));
  assert.deepStrictEqual(dk.nextDue(s, now), new Date(2026, 9, 19, 9, 30));
  assert.deepStrictEqual(dk.lastDue({ ...s, time: '11:00' }, now), new Date(2026, 9, 12, 11, 0));
  assert.strictEqual(dk.scheduleIsDue({ ...s, lastDue: new Date(2026, 9, 14, 9, 0).toISOString() }, now), true);
  assert.strictEqual(dk.scheduleIsDue({ ...s, lastDue: new Date(2026, 9, 14, 9, 30).toISOString() }, now), false);
  // Missed for over a week: still due once.
  assert.strictEqual(dk.scheduleIsDue({ ...s, lastDue: new Date(2026, 8, 1).toISOString() }, now), true);
  assert.strictEqual(dk.scheduleIsDue({ ...s, enabled: false }, now), false);

  const saved = await dk.saveSchedule(store, '555-0100', 'u1', { days: [1], time: '09:30', actions: ['transactions'] });
  assert.strictEqual(saved.phoneNumber, '5550100');
  assert.strictEqual(dk.scheduleIsDue(saved), false); // a new entry waits for its next time
  await assert.rejects(() => dk.saveSchedule(store, '5550100', 'u1', { days: [1], time: 'x', actions: ['send'] }), /Time/);
  const edited = await dk.saveSchedule(store, '5550100', 'u2', { days: [2], time: '08:00', actions: ['residents'], enabled: false }, saved.id);
  assert.strictEqual(edited.user, 'u2');
  assert.strictEqual(edited.nextRun, null);
  await dk.updateScheduleRun(store, saved.id, { lastResult: 'failed', lastError: 'boom' });
  assert.strictEqual((await dk.getSchedule(store, '5550100', saved.id)).lastError, 'boom');
  assert.strictEqual((await dk.listSchedules(store, '5550199')).length, 0);
  assert.strictEqual((await dk.listSchedules(store)).length, 1);
  await assert.rejects(() => dk.deleteSchedule(store, '5550199', saved.id), /not found/);
  await dk.deleteSchedule(store, '5550100', saved.id);
  assert.strictEqual((await dk.listSchedules(store)).length, 0);
}));

const CAM = { serial: 'TESTSERIAL0001', username: 'viewer', password: 'pw', channels: [{ channel: 1, name: 'Front gate' }, { channel: 2 }] };

test('cameras: settings validation, encrypted password, blank password keeps the saved one', withStore(async (store) => {
  assert.match(dk.normalizeCameraSettings({ ...CAM, serial: 'x' }).error, /serial/);
  assert.match(dk.normalizeCameraSettings({ ...CAM, channels: [] }).error, /channels/);
  assert.match(dk.normalizeCameraSettings({ ...CAM, channels: [{ channel: 1 }, { channel: '1' }] }).error, /twice/);
  assert.match(dk.normalizeCameraSettings({ ...CAM, frames: 9 }).error, /Frames/);
  assert.match(dk.normalizeCameraSettings({ ...CAM, framesAfter: -1 }).error, /after the minute/);
  assert.strictEqual(dk.normalizeCameraSettings({ ...CAM, framesAfter: '0' }).settings.framesAfter, 0);
  assert.match(dk.normalizeCameraSettings({ ...CAM, mode: 'film' }).error, /Save must be/);
  assert.strictEqual(dk.normalizeCameraSettings({ ...CAM, mode: 'video' }).settings.mode, 'video');
  assert.match(dk.normalizeCameraSettings({ ...CAM, clipTries: 0 }).error, /Video tries/);
  assert.match(dk.normalizeCameraSettings({ ...CAM, clipTries: 6 }).error, /Video tries/);
  assert.strictEqual(dk.normalizeCameraSettings({ ...CAM, clipTries: '4' }).settings.clipTries, 4);
  assert.deepStrictEqual(dk.normalizeCameraSettings({ ...CAM, channels: [...CAM.channels, { channel: '' }] }).settings, {
    enabled: true, serial: CAM.serial, username: 'viewer', channels: [{ channel: 1, name: 'Front gate' }, { channel: 2, name: '' }],
    clockOffset: 0, mode: 'snapshots', frames: 3, framesAfter: 0, clipTries: 2, events: 'access', backfillHours: 24, keepDays: 0,
  });
  assert.strictEqual(dk.normalizeCameraSettings({ ...CAM, keepDays: '30' }).settings.keepDays, 30);
  assert.match(dk.normalizeCameraSettings({ ...CAM, keepDays: 7 }).error, /Keep pictures/);
  await assert.rejects(() => dk.saveCameraSettings(store, '5550100', 'u1', { ...CAM, password: '' }), /password is required/);
  const saved = await dk.saveCameraSettings(store, '555-0100', 'u1', CAM);
  assert.strictEqual(saved.password, undefined);
  assert.strictEqual(saved.savedBy, 'u1');
  const raw = (await store.db.query('SELECT password FROM cameras WHERE phone = $1', ['5550100'])).rows[0].password;
  assert.ok(raw.startsWith('v1:') && !raw.includes('pw'));
  await dk.saveCameraSettings(store, '5550100', 'u2', { ...CAM, password: '', clockOffset: -5 });
  const again = await dk.getCameraSettings(store, '5550100', { withPassword: true });
  assert.strictEqual(again.password, 'pw');
  assert.strictEqual(again.clockOffset, -5);
  assert.strictEqual(await dk.deleteCameraSettings(store, '5550100'), true);
  assert.strictEqual(await dk.getCameraSettings(store, '5550100'), null);
}));

test('cameras: snapshot times, pending minutes, masking and file names', withStore(async (store) => {
  const ts = new Date(2026, 9, 19, 9, 56, 0).getTime();
  assert.strictEqual(dk.minuteKey(ts), '20261019-0956');
  assert.strictEqual(dk.playbackTime(new Date(2026, 9, 19, 9, 56, 51)), '2026_10_19_09_56_51');
  assert.deepStrictEqual(dk.frameOffsets(3), [0, 20, 40]);
  const cfg = dk.normalizeCameraSettings(CAM).settings;
  const now = ts + 3600000;
  const rows = [
    { ts, access: 'Admit' }, { ts, access: 'Deny' }, { ts: ts - 60000, access: '' },
    { ts: ts - 120000, access: 'Deny' }, { ts: now - 30000, access: 'Admit' }, { ts: ts - 2 * 86400000, access: 'Admit' },
  ];
  assert.deepStrictEqual(dk.pendingMinutes(cfg, rows, {}, now).map((p) => p.minute), ['20261019-0956', '20261019-0954']);
  assert.strictEqual(dk.pendingMinutes({ ...cfg, events: 'all' }, rows, {}, now).length, 3);
  // With frames after the minute, a minute waits one more minute.
  assert.strictEqual(dk.pendingMinutes(cfg, [{ ts: now - 120000, access: 'Admit' }], {}, now).length, 1);
  assert.strictEqual(dk.pendingMinutes({ ...cfg, framesAfter: 1 }, [{ ts: now - 120000, access: 'Admit' }], {}, now).length, 0);
  assert.strictEqual(dk.pendingMinutes({ ...cfg, mode: 'video' }, [{ ts: now - 120000, access: 'Admit' }], {}, now).length, 0);
  await dk.recordSnapshot(store, '5550100', '20261019-0954', { status: 'failed', files: [], error: 'x' });
  await dk.recordSnapshot(store, '5550100', '20261019-0956', { status: 'done', files: ['ch1-00.jpg'] });
  let done = await dk.listSnapshots(store, '5550100');
  assert.deepStrictEqual(dk.pendingMinutes(cfg, rows, done, now).map((p) => p.minute), ['20261019-0954']);
  await dk.recordSnapshot(store, '5550100', '20261019-0954', { status: 'failed', files: [], error: 'x' });
  await dk.recordSnapshot(store, '5550100', '20261019-0954', { status: 'failed', files: [], error: 'x' });
  done = await dk.listSnapshots(store, '5550100');
  assert.strictEqual(done['20261019-0954'].attempts, 3);
  assert.strictEqual(dk.pendingMinutes(cfg, rows, done, now).length, 0); // given up after 3 tries
  // Video mode: a minute with only pictures is fetched again until each channel has its video.
  const vcfg = { ...cfg, mode: 'video' };
  assert.deepStrictEqual(dk.pendingMinutes(vcfg, rows, done, now).map((p) => p.minute), ['20261019-0956', '20261019-0954']);
  await dk.recordSnapshot(store, '5550100', '20261019-0956', { status: 'done', files: ['ch1-00.jpg', 'ch1.mp4'], video: true });
  done = await dk.listSnapshots(store, '5550100');
  assert.strictEqual(done['20261019-0956'].videoAttempts, 1);
  assert.deepStrictEqual(dk.pendingMinutes(vcfg, rows, done, now).map((p) => p.minute), ['20261019-0954']);
  for (let i = 0; i < 3; i++) await dk.recordSnapshot(store, '5550100', '20261019-0954', { status: 'failed', files: [], error: 'x', video: true });
  done = await dk.listSnapshots(store, '5550100');
  assert.strictEqual(dk.pendingMinutes(vcfg, rows, done, now).length, 0); // given up after 3 video tries
  await dk.recordSnapshot(store, '5550100', '20261019-0954', { status: 'done', files: [], error: 'No recording at this time', video: true });
  done = await dk.listSnapshots(store, '5550100');
  assert.strictEqual(dk.pendingMinutes(vcfg, rows, done, now).length, 0); // no recording: not fetched again

  assert.strictEqual(dk.maskSecrets('rtsp://viewer:p%40ss@127.0.0.1:1/x p@ss', ['p@ss']), 'rtsp://***@127.0.0.1:1/x ***');
  assert.match(dk.bridgeExe('bin', 'arm64', 'win32'), /dahua-p2p-arm64\.exe$/);
  assert.match(dk.bridgeExe('bin', 'x64', 'win32'), /dahua-p2p-x64\.exe$/);
  assert.match(dk.bridgeExe('bin', 'arm64', 'linux'), /dahua-p2p-linux-arm64$/);
  assert.match(dk.bridgeExe('bin', 'x64', 'linux'), /dahua-p2p-linux-x64$/);
  assert.match(dk.ffmpegExe('bin', 'arm64', 'win32'), /ffmpeg\.exe$/);
  assert.match(dk.ffmpegExe('bin', 'arm64', 'linux'), /ffmpeg-linux-arm64$/);
  assert.match(dk.ffmpegExe('bin', 'x64', 'linux'), /ffmpeg-linux-x64$/);
  assert.strictEqual(dk.ffmpegCommand(path.join(os.tmpdir(), 'no-such-dir')), 'ffmpeg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-snap-'));
  fs.mkdirSync(path.join(dir, 'snapshots', '20261019-0956'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'snapshots', '20261019-0956', 'ch1-00.jpg'), 'x');
  assert.ok(dk.snapshotFile(dir, '20261019-0956', 'ch1-00.jpg'));
  fs.writeFileSync(path.join(dir, 'snapshots', '20261019-0956', 'ch1-a30.jpg'), 'x');
  assert.ok(dk.snapshotFile(dir, '20261019-0956', 'ch1-a30.jpg'));
  assert.strictEqual(dk.snapshotFile(dir, '..', 'ch1-00.jpg'), null);
  assert.strictEqual(dk.snapshotFile(dir, '20261019-0956', '..\\key'), null);
  fs.writeFileSync(path.join(dir, 'snapshots', '20261019-0956', 'ch2.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'snapshots', '20261019-0956', 'ch2.jpg'), 'x');
  assert.ok(dk.snapshotFile(dir, '20261019-0956', 'ch2.mp4'));
  assert.strictEqual(dk.snapshotFile(dir, '20261019-0956', 'ch2.mov'), null);
  assert.deepStrictEqual(dk.frameOfFile('ch2.mp4'), { channel: 2, off: 0, video: true });
  assert.deepStrictEqual(await dk.deleteSnapshots(store, '5550100', dir), { minutes: 2, files: 3 }); // a video's picture is not counted
  assert.strictEqual(fs.existsSync(path.join(dir, 'snapshots')), false);
  assert.deepStrictEqual(await dk.listSnapshots(store, '5550100'), {});
  assert.deepStrictEqual(await dk.deleteSnapshots(store, '5550100', dir), { minutes: 0, files: 0 });
}));

test('cameras: tidySnapshots deletes old minutes and leftover pieces, and marks entries whose files are gone', withStore(async (store) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-tidy-'));
  const now = new Date(2026, 10, 13, 12, 0).getTime();
  const put = (minute, files) => {
    fs.mkdirSync(path.join(dir, 'snapshots', minute), { recursive: true });
    for (const [f, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'snapshots', minute, f), Buffer.alloc(bytes));
  };
  put('20261001-0900', { 'ch1.mp4': 100, 'ch1.jpg': 10 }); // 43 days old
  put('20261110-0900', { 'ch1.mp4': 100, 'ch1.jpg': 10, 'ch1.rec0.mp4': 50, 'ch1.best.mp4': 20, 'ch1.best.jpg': 5 });
  put('20261111-0900', { 'ch1.rec2.mp4': 7 }); // only a leftover: the folder goes too
  put('live', { 'ch1.jpg': 10, 'ch1.new.mp4': 3 });
  await dk.recordSnapshot(store, '5550100', '20261001-0900', { status: 'done', files: ['ch1.mp4'], video: true });
  await dk.recordSnapshot(store, '5550100', '20261110-0900', { status: 'done', files: ['ch1.mp4'], video: true });
  await dk.recordSnapshot(store, '5550100', '20261015-0900', { status: 'done', files: ['ch1-00.jpg'] }); // its folder is gone
  await dk.recordSnapshot(store, '5550100', '20261112-0900', { status: 'partial', files: ['ch1-00.jpg', 'ch1-20.jpg'],
    error: 'x', shifts: { 'ch1-00.jpg': 2, 'ch1-20.jpg': -2 } });
  put('20261112-0900', { 'ch1-00.jpg': 10 }); // ch1-20.jpg is gone
  await dk.recordSnapshot(store, '5550100', '20261013-0900', { status: 'failed', files: [], error: 'x' });

  // Forever: only leftovers and missing files.
  assert.deepStrictEqual(await dk.tidySnapshots(store, '5550100', dir, 0, now),
    { minutes: 0, files: 0, bytes: 0, leftovers: 5, leftoverBytes: 85, missing: 1 });
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'snapshots')).sort(), ['20261001-0900', '20261110-0900', '20261112-0900', 'live']);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'snapshots', '20261110-0900')).sort(), ['ch1.jpg', 'ch1.mp4']);
  let log = await dk.listSnapshots(store, '5550100');
  assert.deepStrictEqual([log['20261015-0900'].status, log['20261015-0900'].files, log['20261015-0900'].error],
    ['removed', [], 'The files are no longer on disk']);
  assert.deepStrictEqual([log['20261112-0900'].status, log['20261112-0900'].files, log['20261112-0900'].shifts],
    ['partial', ['ch1-00.jpg'], { 'ch1-00.jpg': 2 }]);
  assert.strictEqual(log['20261013-0900'].status, 'failed'); // had no files: left as it was

  // 30 days: the October minutes go; the log keeps them as removed, so they are not fetched again.
  assert.deepStrictEqual(await dk.tidySnapshots(store, '5550100', dir, 30, now),
    { minutes: 1, files: 1, bytes: 110, leftovers: 0, leftoverBytes: 0, missing: 0 });
  assert.ok(!fs.existsSync(path.join(dir, 'snapshots', '20261001-0900')) && fs.existsSync(path.join(dir, 'snapshots', 'live', 'ch1.jpg')));
  log = await dk.listSnapshots(store, '5550100');
  assert.deepStrictEqual([log['20261001-0900'].status, log['20261001-0900'].error], ['removed', 'Deleted after 30 days']);
  assert.strictEqual(log['20261110-0900'].status, 'done');
  const cfg = { ...dk.normalizeCameraSettings({ ...CAM, mode: 'video', backfillHours: 720 }).settings, keepDays: 30 };
  const rows = [new Date(2026, 9, 1, 9, 0, 30), new Date(2026, 9, 15, 9, 0, 30), new Date(2026, 9, 10, 9, 0, 30), new Date(2026, 10, 12, 10, 0, 30)]
    .map((d) => ({ ts: d.getTime(), access: 'Admit' }));
  // Removed minutes are skipped, and so is anything older than keepDays (here 2026-10-10, never fetched).
  assert.deepStrictEqual(dk.pendingMinutes(cfg, rows, log, now).map((p) => p.minute), ['20261112-1000']);
  assert.deepStrictEqual(await dk.tidySnapshots(store, '5550100', dir, 30, now),
    { minutes: 0, files: 0, bytes: 0, leftovers: 0, leftoverBytes: 0, missing: 0 });
}));

test('cameras: runSnapshots grabs each channel and frame with the clock offset', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-snap-'));
  const store = await testStore(path.join(dir, 'store'));
  t.after(() => dropStore(store));
  let asked = [];
  let ch2Error = 'No recording at this time';
  const runner = {
    grabFrame: async (cfg, query, out) => {
      asked.push(query);
      if (query.includes('channel=2')) throw new Error(ch2Error);
      fs.writeFileSync(out, 'jpg');
    },
  };
  const ts = new Date(2026, 9, 19, 9, 56, 0).getTime();
  const rows = [{ ts, access: 'Admit' }, { ts: ts + 60000, access: 'Admit' }];
  assert.strictEqual(await dk.runSnapshots(store, runner, '5550100', dir, rows), null); // no settings
  await dk.saveCameraSettings(store, '5550100', 'u1', { ...CAM, frames: 2, clockOffset: 5 });
  const progress = [];
  const out = await dk.runSnapshots(store, runner, '5550100', dir, rows.slice(0, 1),
    { now: ts + 600000, onProgress: (p) => progress.push(p) });
  assert.deepStrictEqual(out, { minutes: 1, done: 1, partial: 0, failed: 0, stopped: false });
  assert.deepStrictEqual(progress[0], { minutes: 1, minutesDone: 0, frames: 4, framesDone: 0, current: null, byMinute: { '20261019-0956': { frames: 4, done: 0 } } });
  assert.deepStrictEqual(progress[3], { minutes: 1, minutesDone: 0, frames: 4, framesDone: 2, current: '20261019-0956', byMinute: { '20261019-0956': { frames: 4, done: 2 } } });
  assert.deepStrictEqual(progress.at(-1), { minutes: 1, minutesDone: 1, frames: 4, framesDone: 4, current: null, byMinute: {} });
  assert.deepStrictEqual(asked.sort(), [
    '/cam/playback?channel=1&starttime=2026_10_19_09_56_05', '/cam/playback?channel=1&starttime=2026_10_19_09_56_35',
    '/cam/playback?channel=2&starttime=2026_10_19_09_56_03', '/cam/playback?channel=2&starttime=2026_10_19_09_56_05',
    '/cam/playback?channel=2&starttime=2026_10_19_09_56_07', '/cam/playback?channel=2&starttime=2026_10_19_09_56_33',
    '/cam/playback?channel=2&starttime=2026_10_19_09_56_35', '/cam/playback?channel=2&starttime=2026_10_19_09_56_37',
  ]); // no recording: the seconds around it are tried too
  let s = (await dk.listSnapshots(store, '5550100'))['20261019-0956'];
  assert.deepStrictEqual([s.status, s.files.sort(), s.error], ['done', ['ch1-00.jpg', 'ch1-30.jpg'], 'No recording at this time']);

  // Other errors leave the minute partial; the next run grabs only the missing frames.
  ch2Error = 'Picture damaged in transfer';
  asked = [];
  const logged = [];
  assert.deepStrictEqual(await dk.runSnapshots(store, runner, '5550100', dir, rows, { now: ts + 600000, log: (m) => logged.push(m) }),
    { minutes: 1, done: 0, partial: 1, failed: 0, stopped: false });
  assert.deepStrictEqual(logged, [
    'Gate 5550100: 20261019-0957/ch2-00.jpg failed (/cam/playback?channel=2&starttime=2026_10_19_09_57_05): Picture damaged in transfer',
    'Gate 5550100: 20261019-0957/ch2-30.jpg failed (/cam/playback?channel=2&starttime=2026_10_19_09_57_35): Picture damaged in transfer',
    'Gate 5550100: 20261019-0957 partial: 2 frames saved (Picture damaged in transfer)',
  ]);
  assert.strictEqual((await dk.listSnapshots(store, '5550100'))['20261019-0957'].status, 'partial');
  ch2Error = 'No recording at this time';
  asked = [];
  progress.length = 0;
  assert.deepStrictEqual(await dk.runSnapshots(store, runner, '5550100', dir, rows,
    { now: ts + 600000, onProgress: (p) => progress.push(p) }), { minutes: 1, done: 1, partial: 0, failed: 0, stopped: false });
  assert.strictEqual(progress[0].frames, 2); // only the missing frames
  assert.deepStrictEqual(asked.sort(), [
    '/cam/playback?channel=2&starttime=2026_10_19_09_57_03', '/cam/playback?channel=2&starttime=2026_10_19_09_57_05',
    '/cam/playback?channel=2&starttime=2026_10_19_09_57_07', '/cam/playback?channel=2&starttime=2026_10_19_09_57_33',
    '/cam/playback?channel=2&starttime=2026_10_19_09_57_35', '/cam/playback?channel=2&starttime=2026_10_19_09_57_37',
  ]);
  s = (await dk.listSnapshots(store, '5550100'))['20261019-0957'];
  assert.deepStrictEqual([s.status, s.files.sort(), s.attempts, s.shifts], ['done', ['ch1-00.jpg', 'ch1-30.jpg'], 2, {}]);

  // No recording at the planned second: -2 s, then +2 s, is saved instead and kept in shifts.
  const holes = ['2026_10_19_09_55_05', '2026_10_19_09_55_35', '2026_10_19_09_55_33'];
  asked = [];
  const holeRunner = { grabFrame: async (cfg, query, out) => {
    asked.push(query);
    if (query.includes('channel=2') || holes.some((h) => query.endsWith(h))) throw new Error('No recording at this time');
    fs.writeFileSync(out, 'jpg');
  } };
  assert.deepStrictEqual(await dk.runSnapshots(store, holeRunner, '5550100', dir, [{ ts: ts - 60000, access: 'Admit' }], { now: ts + 600000 }),
    { minutes: 1, done: 1, partial: 0, failed: 0, stopped: false });
  s = (await dk.listSnapshots(store, '5550100'))['20261019-0955'];
  assert.deepStrictEqual([s.files.sort(), s.shifts], [['ch1-00.jpg', 'ch1-30.jpg'], { 'ch1-00.jpg': -2, 'ch1-30.jpg': 2 }]);
  assert.ok(asked.includes('/cam/playback?channel=1&starttime=2026_10_19_09_55_37'));
  holes.length = 0;
  s = await dk.refreshSnapshot(store, holeRunner, '5550100', dir, '20261019-0955', 'ch1-00.jpg');
  assert.deepStrictEqual(s.shifts, { 'ch1-30.jpg': 2 }); // taken at the planned time this time

  // Stopping: the minute in progress is not recorded and no more frames are asked for.
  const ac = new AbortController();
  asked = [];
  const stopRunner = { grabFrame: async (cfg, query, out) => { asked.push(query); fs.writeFileSync(out, 'jpg'); ac.abort(); } };
  const more = [...rows, { ts: ts + 120000, access: 'Admit' }, { ts: ts + 180000, access: 'Admit' }];
  assert.deepStrictEqual(await dk.runSnapshots(store, stopRunner, '5550100', dir, more, { now: ts + 600000, signal: ac.signal }),
    { minutes: 2, done: 0, partial: 0, failed: 0, stopped: true });
  assert.strictEqual(asked.length, 1);
  assert.strictEqual((await dk.listSnapshots(store, '5550100'))['20261019-0959'], undefined);
  assert.strictEqual((await dk.listSnapshots(store, '5550100'))['20261019-0958'], undefined);

  // Frames after the minute: the following minute's times, named ch<N>-a<SS>.jpg.
  await dk.saveCameraSettings(store, '5550100', 'u1', { ...CAM, channels: [{ channel: 1 }], frames: 1, framesAfter: 2, clockOffset: 5 });
  asked = [];
  const later = ts + 300000;
  assert.deepStrictEqual(await dk.runSnapshots(store, runner, '5550100', dir, [{ ts: later, access: 'Admit' }], { now: ts + 600000 }),
    { minutes: 1, done: 1, partial: 0, failed: 0, stopped: false });
  assert.deepStrictEqual(asked.sort(), [
    '/cam/playback?channel=1&starttime=2026_10_19_10_01_05', '/cam/playback?channel=1&starttime=2026_10_19_10_02_05',
    '/cam/playback?channel=1&starttime=2026_10_19_10_02_35',
  ]);
  assert.deepStrictEqual((await dk.listSnapshots(store, '5550100'))['20261019-1001'].files.sort(), ['ch1-00.jpg', 'ch1-a00.jpg', 'ch1-a30.jpg']);

  // Recorder unreachable: the minute's other frames are not tried and the run ends with the reason.
  asked = [];
  const downRunner = { grabFrame: async (cfg, query) => {
    asked.push(query);
    throw Object.assign(new Error('Could not reach the recorder after 3 tries'), { code: 'NO_CONNECTION' });
  } };
  const down = [{ ts: ts + 360000, access: 'Admit' }, { ts: ts + 420000, access: 'Admit' }];
  assert.deepStrictEqual(await dk.runSnapshots(store, downRunner, '5550100', dir, down, { now: ts + 600000 }),
    { minutes: 2, done: 0, partial: 0, failed: 1, stopped: false, error: 'Could not reach the recorder after 3 tries' });
  assert.strictEqual(asked.length, 1);
  assert.strictEqual((await dk.listSnapshots(store, '5550100'))['20261019-1003'].status, 'failed'); // newest first
  assert.strictEqual((await dk.listSnapshots(store, '5550100'))['20261019-1002'], undefined);

  // Refreshing one picture: kept out of the log when it fails; once every frame is saved the minute is done.
  const refreshLog = [];
  const opts = { log: (m) => refreshLog.push(m) };
  await assert.rejects(dk.refreshSnapshot(store, downRunner, '5550100', dir, '20261019-1003', 'ch1-00.jpg', opts),
    (e) => e.status === 502 && /Could not reach/.test(e.message));
  assert.match(refreshLog[0], /^Gate 5550100: 20261019-1003\/ch1-00\.jpg refresh failed \(\/cam\/playback\?channel=1&starttime=2026_10_19_10_03_05\)/);
  assert.strictEqual((await dk.listSnapshots(store, '5550100'))['20261019-1003'].status, 'failed');
  await assert.rejects(dk.refreshSnapshot(store, runner, '5550100', dir, '20261019-1003', '..\\key', opts), (e) => e.status === 400);
  asked = [];
  s = await dk.refreshSnapshot(store, runner, '5550100', dir, '20261019-1003', 'ch1-00.jpg', opts);
  assert.deepStrictEqual([s.status, s.files, s.attempts], ['partial', ['ch1-00.jpg'], 1]);
  await dk.refreshSnapshot(store, runner, '5550100', dir, '20261019-1003', 'ch1-a00.jpg', opts);
  s = await dk.refreshSnapshot(store, runner, '5550100', dir, '20261019-1003', 'ch1-a30.jpg', opts);
  assert.deepStrictEqual([s.status, s.files.sort(), s.error, s.attempts], ['done', ['ch1-00.jpg', 'ch1-a00.jpg', 'ch1-a30.jpg'], null, 1]);
  assert.deepStrictEqual(asked, ['/cam/playback?channel=1&starttime=2026_10_19_10_03_05',
    '/cam/playback?channel=1&starttime=2026_10_19_10_04_05', '/cam/playback?channel=1&starttime=2026_10_19_10_04_35']);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'snapshots', '20261019-1003')).sort(), ['ch1-00.jpg', 'ch1-a00.jpg', 'ch1-a30.jpg']);

  // One transaction's minute only: any minute, even without a matching row; too recent ends with an error.
  asked = [];
  assert.deepStrictEqual(await dk.runSnapshots(store, runner, '5550100', dir, [], { now: ts + 600000, minute: '20261019-0930' }),
    { minutes: 1, done: 1, partial: 0, failed: 0, stopped: false });
  assert.deepStrictEqual(asked, ['/cam/playback?channel=1&starttime=2026_10_19_09_30_05',
    '/cam/playback?channel=1&starttime=2026_10_19_09_31_05', '/cam/playback?channel=1&starttime=2026_10_19_09_31_35']);
  assert.match((await dk.runSnapshots(store, runner, '5550100', dir, [], { now: ts + 600000, minute: '20261019-1005' })).error, /not be recorded yet/);
  await assert.rejects(dk.runSnapshots(store, runner, '5550100', dir, [], { minute: 'x' }), (e) => e.status === 400);

  // Video mode: one 2-minute video per channel, recorded raw then finished into .mp4 + first-frame picture.
  await dk.saveCameraSettings(store, '5550100', 'u1', { ...CAM, mode: 'video', clockOffset: 5 });
  const calls = [];
  let partSecs = [];
  let finishSecs = 120;
  const videoRunner = {
    grabFrame: async (cfg, query, out, o) => { calls.push([query, path.basename(out), o.video]); fs.writeFileSync(out, 'raw'); },
    clipSeconds: async () => (partSecs.length ? partSecs.shift() : 120),
    finishClip: async (parts, out, poster) => {
      calls.push(['finish', parts.map((p) => path.basename(p)), path.basename(out), path.basename(poster)]);
      fs.writeFileSync(out, 'mp4'); fs.writeFileSync(poster, 'jpg'); return finishSecs;
    },
  };
  assert.deepStrictEqual(await dk.runSnapshots(store, videoRunner, '5550100', dir, [], { now: ts + 600000, minute: '20261019-0940' }),
    { minutes: 1, done: 1, partial: 0, failed: 0, stopped: false });
  assert.deepStrictEqual(calls, [
    ['/cam/playback?channel=1&starttime=2026_10_19_09_40_05&endtime=2026_10_19_09_42_05', 'ch1.rec0.mp4', 120],
    ['finish', ['ch1.rec0.mp4'], 'ch1.mp4', 'ch1.jpg'],
    ['/cam/playback?channel=2&starttime=2026_10_19_09_40_05&endtime=2026_10_19_09_42_05', 'ch2.rec0.mp4', 120],
    ['finish', ['ch2.rec0.mp4'], 'ch2.mp4', 'ch2.jpg'],
  ]);
  assert.deepStrictEqual((await dk.listSnapshots(store, '5550100'))['20261019-0940'].files.sort(), ['ch1.mp4', 'ch2.mp4']);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'snapshots', '20261019-0940')).sort(), ['ch1.jpg', 'ch1.mp4', 'ch2.jpg', 'ch2.mp4']);
  calls.length = 0;
  s = await dk.refreshSnapshot(store, videoRunner, '5550100', dir, '20261019-0940', 'ch2.mp4');
  assert.deepStrictEqual(calls.map((c) => c.slice(0, 2)), [
    ['/cam/playback?channel=2&starttime=2026_10_19_09_40_05&endtime=2026_10_19_09_42_05', 'ch2.new.rec0.mp4'], ['finish', ['ch2.new.rec0.mp4']],
  ]);
  assert.strictEqual(s.status, 'done');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'snapshots', '20261019-0940')).sort(), ['ch1.jpg', 'ch1.mp4', 'ch2.jpg', 'ch2.mp4']);

  // A stream that ends early: the rest is asked for from where it stopped, and the parts are joined.
  calls.length = 0;
  partSecs = [42.6, 50.2, 27.9];
  const resumeLog = [];
  await dk.refreshSnapshot(store, videoRunner, '5550100', dir, '20261019-0940', 'ch1.mp4', { log: (m) => resumeLog.push(m) });
  assert.deepStrictEqual(calls, [
    ['/cam/playback?channel=1&starttime=2026_10_19_09_40_05&endtime=2026_10_19_09_42_05', 'ch1.new.rec0.mp4', 120],
    ['/cam/playback?channel=1&starttime=2026_10_19_09_40_47&endtime=2026_10_19_09_42_05', 'ch1.new.rec1.mp4', 78],
    ['/cam/playback?channel=1&starttime=2026_10_19_09_41_37&endtime=2026_10_19_09_42_05', 'ch1.new.rec2.mp4', 28],
    ['finish', ['ch1.new.rec0.mp4', 'ch1.new.rec1.mp4', 'ch1.new.rec2.mp4'], 'ch1.new.mp4', 'ch1.new.jpg'],
  ]);
  assert.deepStrictEqual(resumeLog, ['Gate 5550100: 20261019-0940/ch1.mp4: the recorder stopped after 42 s, asking for the rest',
    'Gate 5550100: 20261019-0940/ch1.mp4: the recorder stopped after 92 s, asking for the rest']);
  // A video still short after its resumes is asked for again; still short, the complete old video is kept.
  calls.length = 0;
  finishSecs = 7;
  const shortLog = [];
  await assert.rejects(dk.refreshSnapshot(store, videoRunner, '5550100', dir, '20261019-0940', 'ch1.mp4', { log: (m) => shortLog.push(m) }),
    /sent only 7 s of 120 s/);
  assert.strictEqual(calls.filter((c) => c[0] === 'finish').length, 2);
  assert.ok(shortLog.includes('Gate 5550100: 20261019-0940/ch1.mp4: the recorder sent 7 s of 120 s, kept it, trying again'));
  assert.ok(shortLog.includes('Gate 5550100: 20261019-0940/ch1.mp4: the recorder sent 7 s of 120 s, deleted it (not longer than the one kept)'));
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'snapshots', '20261019-0940')).sort(), ['ch1.jpg', 'ch1.mp4', 'ch2.jpg', 'ch2.mp4']);
  assert.deepStrictEqual((await dk.listSnapshots(store, '5550100'))['20261019-0940'].short, {});
  // With no saved video, the longest partial one is kept and marked short; runs fetch it again, keeping it
  // unless a longer one comes, and a complete one clears the mark.
  fs.rmSync(path.join(dir, 'snapshots', '20261019-0940', 'ch2.mp4'));
  const shortRuns = [[7, 30], [12, 9], [120]];
  for (const [i, secsList] of shortRuns.entries()) {
    calls.length = 0;
    const list = [...secsList];
    const r = { ...videoRunner, finishClip: async (parts, out, poster) => { await videoRunner.finishClip(parts, out, poster); return list.shift(); } };
    const out = await dk.runSnapshots(store, r, '5550100', dir, [], { now: ts + 600000, minute: '20261019-0940' });
    const e = (await dk.listSnapshots(store, '5550100'))['20261019-0940'];
    assert.deepStrictEqual(calls.filter((c) => c[0] !== 'finish').map((c) => c[1]), i ? ['ch2.new.rec0.mp4', 'ch2.new.rec0.mp4'].slice(0, secsList.length) : ['ch2.rec0.mp4', 'ch2.rec0.mp4']);
    assert.deepStrictEqual(e.files.sort(), ['ch1.mp4', 'ch2.mp4']);
    assert.deepStrictEqual(e.short, i < 2 ? { 'ch2.mp4': 30 } : {});
    assert.strictEqual(out.partial, i < 2 ? 1 : 0);
    if (i < 2) assert.match(e.error, /sent only (30|12) s of 120 s/);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'snapshots', '20261019-0940')).sort(), ['ch1.jpg', 'ch1.mp4', 'ch2.jpg', 'ch2.mp4']);
  }
  finishSecs = 120;
  // A gap in the recording (404 where the stream stopped) is skipped 5 s at a time (once each) until the recording
  // starts again; the gap counts toward the 2 minutes. The rest is asked for while each part brings video. No
  // recording at all is "No recording at this time".
  calls.length = 0;
  partSecs = [42, 30, 20, 20];
  const gapLog = [];
  const gapRunner = { ...videoRunner, grabFrame: async (cfg, query, out, o) => {
    if (/09_40_(47|52)&/.test(query)) { calls.push([query, !!o.once]); throw new Error('No recording at this time'); }
    return videoRunner.grabFrame(cfg, query, out, o);
  } };
  s = await dk.refreshSnapshot(store, gapRunner, '5550100', dir, '20261019-0940', 'ch1.mp4', { log: (m) => gapLog.push(m) });
  assert.deepStrictEqual(calls, [
    ['/cam/playback?channel=1&starttime=2026_10_19_09_40_05&endtime=2026_10_19_09_42_05', 'ch1.new.rec0.mp4', 120],
    ['/cam/playback?channel=1&starttime=2026_10_19_09_40_47&endtime=2026_10_19_09_42_05', false],
    ['/cam/playback?channel=1&starttime=2026_10_19_09_40_52&endtime=2026_10_19_09_42_05', true],
    ['/cam/playback?channel=1&starttime=2026_10_19_09_40_57&endtime=2026_10_19_09_42_05', 'ch1.new.rec3.mp4', 68],
    ['/cam/playback?channel=1&starttime=2026_10_19_09_41_27&endtime=2026_10_19_09_42_05', 'ch1.new.rec4.mp4', 38],
    ['/cam/playback?channel=1&starttime=2026_10_19_09_41_47&endtime=2026_10_19_09_42_05', 'ch1.new.rec5.mp4', 18],
    ['finish', ['ch1.new.rec0.mp4', 'ch1.new.rec3.mp4', 'ch1.new.rec4.mp4', 'ch1.new.rec5.mp4'], 'ch1.new.mp4', 'ch1.new.jpg'],
  ]);
  assert.deepStrictEqual(gapLog, ['Gate 5550100: 20261019-0940/ch1.mp4: the recorder stopped after 42 s, asking for the rest',
    'Gate 5550100: 20261019-0940/ch1.mp4: no recording from +42 s to +52 s, skipped it',
    'Gate 5550100: 20261019-0940/ch1.mp4: the recorder stopped after 82 s, asking for the rest',
    'Gate 5550100: 20261019-0940/ch1.mp4: the recorder stopped after 102 s, asking for the rest']);
  assert.deepStrictEqual([s.status, s.short], ['done', {}]);
  calls.length = 0;
  const noRecRunner = { ...videoRunner, grabFrame: async (cfg, query) => { calls.push(query); throw new Error('No recording at this time'); } };
  await assert.rejects(dk.refreshSnapshot(store, noRecRunner, '5550100', dir, '20261019-0940', 'ch1.mp4'), /No recording at this time/);
  assert.strictEqual(calls.length, 23);
  // A failed resume joins what was saved; no video at all is an error.
  calls.length = 0;
  partSecs = [42];
  const failRunner = { ...videoRunner, grabFrame: async (cfg, query, out, o) => {
    if (calls.length) throw new Error('Camera bridge exited (code 1)');
    return videoRunner.grabFrame(cfg, query, out, o);
  } };
  await dk.refreshSnapshot(store, failRunner, '5550100', dir, '20261019-0940', 'ch1.mp4');
  assert.deepStrictEqual(calls.at(-1)[1], ['ch1.new.rec0.mp4']);
  calls.length = 0;
  partSecs = [0.4];
  await dk.refreshSnapshot(store, videoRunner, '5550100', dir, '20261019-0940', 'ch1.mp4'); // asked again from the start
  assert.deepStrictEqual(calls.at(-1)[1], ['ch1.new.rec1.mp4']);
  assert.strictEqual(calls[1][0], '/cam/playback?channel=1&starttime=2026_10_19_09_40_05&endtime=2026_10_19_09_42_05');
  partSecs = [0.4, 0.4, 0.4];
  await assert.rejects(dk.refreshSnapshot(store, videoRunner, '5550100', dir, '20261019-0940', 'ch1.mp4'), /sent no video/);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'snapshots', '20261019-0940')).sort(), ['ch1.jpg', 'ch1.mp4', 'ch2.jpg', 'ch2.mp4']);
});

test('cameras: finishClip turns a recorded fragmented MP4 into .mp4 (hvc1) and a first-frame picture (ffmpeg)', async (t) => {
  const ffmpeg = dk.ffmpegCommand();
  if (cp.spawnSync(ffmpeg, ['-version']).status !== 0) return t.skip('no ffmpeg (bundled or on the PATH)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-clip-'));
  const record = (secs, file) => cp.execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', `testsrc=duration=${secs}:size=320x240:rate=10`, '-c:v', 'libx265', '-x265-params', 'log-level=error',
    '-f', 'mp4', '-movflags', '+frag_keyframe+empty_moov', path.join(dir, file)]);
  record(3, 'ch1.rec0.mp4');
  record(2, 'ch1.rec1.mp4');
  const runner = dk.createCameraRunner();
  assert.ok(Math.abs(await runner.clipSeconds(path.join(dir, 'ch1.rec0.mp4')) - 3) < 0.5);
  const secs = await runner.finishClip([path.join(dir, 'ch1.rec0.mp4'), path.join(dir, 'ch1.rec1.mp4')], path.join(dir, 'ch1.mp4'), path.join(dir, 'ch1.jpg'));
  assert.ok(secs > 4.5 && secs < 5.5, `joined duration ${secs}`);
  assert.ok(fs.statSync(path.join(dir, 'ch1.mp4')).size > 0 && fs.statSync(path.join(dir, 'ch1.jpg')).size > 0);
  assert.match(cp.spawnSync(ffmpeg, ['-hide_banner', '-i', path.join(dir, 'ch1.mp4')]).stderr.toString(), /hevc .*hvc1/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'ch1.mp4.parts.txt')), false);
  record(0.5, 'ch2.rec0.mp4');
  await assert.rejects(runner.finishClip([path.join(dir, 'ch2.rec0.mp4')], path.join(dir, 'ch2.mp4'), path.join(dir, 'ch2.jpg')), /sent no video/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'ch2.mp4')), false);
  await assert.rejects(runner.finishClip([path.join(dir, 'missing.mp4')], path.join(dir, 'x.mp4'), path.join(dir, 'x.jpg')), /Could not save the video/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'x.mp4')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('debug log: written only while turned on, one line per entry, moved aside when too big', withStore(async (store, dir) => {
  const file = path.join(dir, 'logs', 'debug.log');
  let on = await dk.debugLogEnabled(store);
  const log = dk.createDebugLog(file, { enabled: () => on, maxBytes: 200 });
  log.write('camera', 'not written');
  assert.deepStrictEqual(log.info(), { enabled: false, file, size: 0 });
  await dk.setDebugLogEnabled(store, true);
  on = await dk.debugLogEnabled(store);
  assert.strictEqual(on, true);
  log.write('camera', 'first\nsecond');
  assert.match(log.read(), /^\d{4}-\d\d-\d\dT[\d:.]+Z \[camera\] first \| second\n$/);
  log.write('server', 'x'.repeat(250));
  log.write('server', 'after');
  assert.ok(fs.existsSync(`${file}.1`));
  assert.match(log.read(), /^\S+ \[server\] after\n$/);
  await dk.setDebugLogEnabled(store, false);
  on = await dk.debugLogEnabled(store);
  log.write('server', 'off');
  assert.strictEqual(log.info().enabled, false);
  assert.doesNotMatch(log.read(), /off/);
}));
