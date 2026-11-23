// Run with: node --test test/gate-cache.test.ts
import test from 'node:test';
import assert from 'node:assert';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import * as dk from '../index.ts';
import { Application } from '../web/app.ts';
import { staticFile } from '../web/requests.ts';
import { withContext } from '@logtape/logtape';
import { helpPage, inline, markdownToHtml } from '../src/markdown.ts';
import { loadData } from '../web/data.ts';
import { searchGate } from '../web/ui/nav/quickJumpSearch.ts';
import { isoCBOR } from '@simplewebauthn/server/helpers';

// What the tests read back from the database.
async function getGateState(store: dk.Store, phone: string) {
  const row = await dk.one<{ pulled_at: string; round_trip_ok: boolean; problems: dk.RoundTripProblem[]; rebuild_ok: boolean | null;
    rebuild_problems: dk.RoundTripProblem[] | null }>(store,
    'SELECT pulled_at, round_trip_ok, problems, rebuild_ok, rebuild_problems FROM gate_state WHERE phone = $1', [dk.phoneDigits(phone)]);
  return { pulledAt: row!.pulled_at, roundTripOk: row!.round_trip_ok, problems: row!.problems, rebuildOk: row!.rebuild_ok, rebuildProblems: row!.rebuild_problems! };
}
async function gateStateCounts(store: dk.Store, phone: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ['gate_residents', 'gate_cards', 'gate_settings']) {
    out[table] = (await dk.one<{ n: number }>(store, `SELECT COUNT(*) AS n FROM ${table} WHERE phone = $1`, [dk.phoneDigits(phone)]))!.n;
  }
  return out;
}
const txHistoryCount = async (store: dk.Store, phone: string): Promise<number> =>
  (await dk.one<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM tx_history WHERE phone = $1', [dk.phoneDigits(phone)]))!.n;

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
  assert.strictEqual(inline('![x](javascript:alert(1))'), '![x](javascript:alert(1))'); // no javascript: images
  assert.strictEqual(markdownToHtml('- one\n  more\n- two').replace(/\s+/g, ' '), '<ul> <li>one more</li> <li>two</li> </ul>');
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
  for (const [from, to] of [[0x100, 0x114], [0x144, 0x145], [0x179, 0x18d]]) names.fill(0x20, from, to); // blank display text
  names[0x40] = 3; // directory code digits
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
const pullInto = (store, files = syntheticGate()) => dk.applyPull(store, PHONE,
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
  assert.deepStrictEqual([status.exists, status.edited, status.conflicts], [true, false, []]);
  const pulled = syntheticGate();
  const w = await working(store);
  for (const n of ['names', 'phone', 'cards']) assert.ok(w[n].equals(pulled[n]), `${n}.bin is built back exactly`);
  const raw = (await store.db.query("SELECT data FROM gate_files WHERE copy = 'base' AND name = 'names.bin'")).rows[0].data;
  assert.ok(!raw.includes(Buffer.from('Smith, J')), 'stored encrypted');
  assert.strictEqual((await store.db.query("SELECT COUNT(*) AS n FROM gate_files WHERE copy = 'working'")).rows[0].n, 0);
  assert.deepStrictEqual(await gateStateCounts(store, PHONE), { gate_residents: 3, gate_cards: 2, gate_settings: dk.GATE_SETTING_FIELDS.length - 1 });
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
  assert.ok((await dk.readBaseFiles(store, PHONE)).names.equals(syntheticGate().names), 'the gate\'s copy is unchanged');
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
  names[0x2000] ^= 0xff; // free space after the directory: no value describes it
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

test('a residents pull updates the working copy at once, with unsent changes kept on top of the gate\'s', withStore(async (store) => {
  assert.strictEqual((await pullInto(store)).outcome, 'new');
  assert.strictEqual((await pullInto(store)).outcome, 'unchanged');
  const g1 = dk.applyResidentEdit(syntheticGate(), { directoryCode: '101', name: 'Smith, Jo' });
  assert.strictEqual((await pullInto(store, g1)).outcome, 'refreshed'); // no unsent changes: the working copy is the pull
  assert.ok((await working(store)).names.equals(g1.names));
  // Unsent here: talk time and 102's phone. Meanwhile at the gate: the outside line digit and 101's name.
  await setTalkTime(store, '2:30');
  await saveWorking(store, dk.applyResidentEdit(await working(store), { directoryCode: '102', phone: '5550142' }));
  const g2 = dk.applyResidentEdit(g1, { directoryCode: '101', name: 'Smith, John' });
  g2.names[0x1d] = 9;
  const r = await pullInto(store, g2);
  assert.deepStrictEqual([r.outcome, r.kept, r.fromGate, r.conflicts, r.notKept, r.status.conflicts], ['rebased', 2, 2, [], [], []]);
  const w = dk.decodeWorking(await working(store));
  assert.deepStrictEqual([w.settings.talkTime, w.settings.outsideLineDigit], ['2:30', '9']);
  const res = (code) => w.residents.find((x) => x.directoryCode === code);
  assert.deepStrictEqual([res('101').name, res('102').phone], ['Smith, John', dk.decodeWorking(dk.applyResidentEdit(g2, { directoryCode: '102', phone: '5550142' })).residents[1].phone]);
  // The gate's copy is the pull, and only the unsent changes differ from it.
  assert.ok((await dk.readBaseFiles(store, PHONE)).names.equals(g2.names));
  const unsent = dk.diffStates(dk.decodeWorking(g2), w);
  assert.deepStrictEqual([Object.keys(unsent.residents), Object.keys(unsent.settings)], [['102'], ['talkTime']]);
  // After a send the gate confirmed, nothing is unsent.
  await dk.replaceBase(store, PHONE, (await dk.prepareSend(store, PHONE)).files);
  assert.deepStrictEqual([(await dk.cacheStatus(store, PHONE)).edited, (await dk.readBaseFiles(store, PHONE)).names.equals(g2.names)], [false, false]);
}));

test('an item changed differently at the gate and here is a conflict: the change here is kept until decided, sends wait', withPull(async (store) => {
  await setTalkTime(store, '2:30');
  await saveWorking(store, dk.applyResidentEdit(await working(store), { directoryCode: '101', name: 'Smith, Jane' }));
  const g = dk.applyResidentEdit(syntheticGate(), { directoryCode: '101', name: 'Smith, Joan' });
  g.names[0x10] = 90; // talk time 1:30 at the gate
  const r = await pullInto(store, g);
  assert.deepStrictEqual([r.outcome, r.kept, r.conflicts.map((c) => c.label)], ['rebased', 2, ['Directory code 101 (Smith, Jane)', 'Talk time (m:ss)']]);
  assert.deepStrictEqual(r.status.conflicts.map((c) => [c.kind, c.key, c.gate, c.mine]),
    [['resident', '101', 'Name "Smith, Joan"', 'Name "Smith, Jane"'], ['setting', 'talkTime', '"1:30"', '"2:30"']]);
  await assert.rejects(() => dk.prepareSend(store, PHONE), (e) => e.status === 409 && /2 conflict/.test(e.message));
  assert.strictEqual((await pullInto(store, g)).outcome, 'unchanged');
  assert.strictEqual((await dk.cacheStatus(store, PHONE)).conflicts.length, 2); // still to decide
  let st = await dk.resolveConflict(store, PHONE, { kind: 'setting', key: 'talkTime', choice: 'gate' });
  assert.deepStrictEqual(st.conflicts.map((c) => c.key), ['101']);
  assert.strictEqual(dk.decodeWorking(await working(store)).settings.talkTime, '1:30');
  st = await dk.resolveConflict(store, PHONE, { kind: 'resident', key: '101', choice: 'mine' });
  assert.deepStrictEqual(st.conflicts, []);
  assert.strictEqual(dk.decodeWorking(await working(store)).residents.find((x) => x.directoryCode === '101').name, 'Smith, Jane');
  assert.ok((await dk.prepareSend(store, PHONE)).changedBlocks['names.bin'].length);
  await assert.rejects(() => dk.resolveConflict(store, PHONE, { kind: 'resident', key: '101', choice: 'mine' }), (e) => e.status === 404);
  await assert.rejects(() => dk.resolveConflict(store, PHONE, { kind: 'resident', key: '101', choice: 'both' }), (e) => e.status === 400);
}));

test('a resident removed at the gate but changed here is a conflict; taking the gate\'s removes it', withPull(async (store) => {
  await saveWorking(store, dk.applyResidentEdit(await working(store), { directoryCode: '102', entryCode: '4321' }));
  const r = await pullInto(store, dk.removeDirectoryCode(syntheticGate(), '102'));
  assert.deepStrictEqual(r.status.conflicts.map((c) => [c.key, c.gate, c.mine]), [['102', 'removed', 'ACME Deliveries']]);
  await dk.resolveConflict(store, PHONE, { kind: 'resident', key: '102', choice: 'gate' });
  assert.deepStrictEqual(dk.decodeWorking(await working(store)).residents.map((x) => x.directoryCode), ['101', '103']);
  assert.strictEqual((await dk.cacheStatus(store, PHONE)).edited, false);
}));

test('a layout change drops unsent changes; a change the files can\'t take is reported and left out', withPull(async (store) => {
  await setTalkTime(store, '2:30');
  const r = await pullInto(store, dk.convertDirDigits(syntheticGate(), 4));
  assert.deepStrictEqual([r.outcome, r.dropped.count, (await dk.cacheStatus(store, PHONE)).edited], ['dropped', 1, false]);
  assert.match(r.dropped.reason, /digits/);
  // Here a new code 1104 gets entry code 9999; at the gate someone else (1105) got 9999 meanwhile.
  const base = await working(store);
  await saveWorking(store, dk.addEntry(base, { directoryCode: '1104', name: 'New, Person', entryCode: '9999' }));
  const g = dk.addEntry(base, { directoryCode: '1105', name: 'Gate, Added', entryCode: '9999' });
  const r2 = await pullInto(store, g);
  assert.deepStrictEqual([r2.outcome, r2.kept, r2.notKept.map((n) => n.label)], ['rebased', 0, ['Directory code 1104 (New, Person)']]);
  assert.match(r2.notKept[0].error, /9999/);
  assert.ok((await working(store)).names.equals(g.names));
}));

test('migratePulledCopies applies a pull kept apart before 2026-11-13, then removes it', withPull(async (store) => {
  await setTalkTime(store, '2:30');
  const g = syntheticGate();
  g.names[0x1d] = 9;
  for (const [n, d] of [['names.bin', g.names], ['phone.bin', g.phone], ['cards.bin', g.cards]]) {
    await store.db.query("INSERT INTO gate_files (phone, copy, name, data, saved_at) VALUES ($1, 'pulled', $2, $3, $4)",
      [PHONE, n, dk.encryptBytes(store, d), T1]);
  }
  assert.deepStrictEqual(await dk.migratePulledCopies(store), [{ phone: PHONE, outcome: 'rebased' }]);
  assert.deepStrictEqual(await dk.migratePulledCopies(store), []);
  const w = dk.decodeWorking(await working(store));
  assert.deepStrictEqual([w.settings.talkTime, w.settings.outsideLineDigit], ['2:30', '9']);
  assert.strictEqual((await store.db.query("SELECT COUNT(*) AS n FROM gate_files WHERE copy = 'pulled'")).rows[0].n, 0);
}));

test('resetCache replaces saved edits with the last pull', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  await setTalkTime(store, '2:30');
  const status = await dk.resetCache(store, PHONE);
  assert.deepStrictEqual([status.edited, status.conflicts], [false, []]);
  assert.ok((await working(store)).names.equals(syntheticGate().names));
  assert.ok((await dk.cacheFileData(store, PHONE, 'names.map')).equals(Buffer.alloc(MAP_SIZE)));
}));

test('resetCache drops the working copy when a gate file is missing', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  await store.db.query("DELETE FROM gate_files WHERE copy = 'base' AND name = 'cards.bin'");
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

test('prepareSend refuses when nothing changed, files are missing, or conflicts wait', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  await assert.rejects(() => dk.prepareSend(store, PHONE), (e) => e.status === 409 && /no changes/.test(e.message));
  await setTalkTime(store, '2:30');
  const newer = syntheticGate();
  newer.names[0x10] = 90;
  await pullInto(store, newer);
  await assert.rejects(() => dk.prepareSend(store, PHONE), (e) => e.status === 409 && /conflict/.test(e.message));
  await store.db.query("DELETE FROM gate_files WHERE copy = 'base' AND name = 'cards.bin'");
  await dk.resetCache(store, PHONE);
  await assert.rejects(() => dk.prepareSend(store, PHONE), (e) => e.status === 409 && /missing files/.test(e.message));
}));

test('tidied edits save to the working copy and are what a send writes', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  // Fill the empty 103 with a name that sorts first, move card 504 to it, and give it an area code.
  let b = dk.applyResidentEdit(await working(store), { directoryCode: '101', cards: [] });
  b = dk.tidyBoard(dk.applyResidentEdit(b, { directoryCode: '103', name: 'Adams, A', cards: ['504', '7'], areaCode: '214', phone: '5550100' }));
  await saveWorking(store, b);
  const w = await working(store);
  assert.ok(w.names.equals(b.names) && w.cards.equals(b.cards) && w.phone.equals(b.phone));
  assert.deepStrictEqual(dk.parseNamesBin(w.names).directory.map((e) => e.directoryCode), ['103', '101', '102']);
  assert.deepStrictEqual([0, 4, 8, 12].map((o) => w.cards.subarray(o, o + 4).toString('hex')), ['0007f103', '01f8f103', '3e70ffff', 'ffffffff']);
  const sent = (await dk.prepareSend(store, PHONE)).files;
  assert.ok(sent['names.bin'].equals(b.names) && sent['cards.bin'].equals(b.cards));
}));

test('after a send, an edit saved while it ran is kept on top of the check pull', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  await saveWorking(store, dk.applyResidentEdit(await working(store), { directoryCode: '101', name: 'Smith, Joan' }));
  const sent = (await dk.prepareSend(store, PHONE)).files;
  await saveWorking(store, dk.applyResidentEdit(await working(store), { directoryCode: '102', entryCode: '4321' })); // during the send
  const pulled = { ...sent }; // the gate now holds what was sent
  assert.strictEqual((await dk.verifySend(store, PHONE, pulled, sent)).matches, true);
  assert.strictEqual((await dk.verifySend(store, PHONE, sent)).matches, false); // the working copy moved on
  const r = await dk.acceptSentPull(store, PHONE, pulled, sent);
  assert.deepStrictEqual([r.outcome, r.kept, r.conflicts], ['rebased', 1, []]);
  const rows = dk.residentRows(await working(store)).rows;
  assert.deepStrictEqual([rows.find((x) => x.directoryCode === '101').name, rows.find((x) => x.directoryCode === '102').entryCode], ['Smith, Joan', '4321']);
  assert.ok((await dk.readBaseFiles(store, PHONE)).names.equals(sent['names.bin']));
}));

test('a phone record whose directory code is not decimal is left out instead of breaking the gate', () => {
  const g = syntheticGate();
  Buffer.from([0x1a, 0x23, 0xff, 0xff, 0xff, 0xff, 0x99, 0x99, 0x01, 0xff]).copy(g.phone, 30);
  assert.deepStrictEqual(dk.residentRows(g).rows.map((r) => r.directoryCode), ['101', '102', '103']);
  assert.strictEqual(dk.checkRoundTrip(g).ok, true); // its bytes are kept as they are
});

test('a new area code after an unsent area-code mode change rebuilds against the new table', () => {
  let base = syntheticGate(); // 255 mode, table 805, 213 (now unused), 310
  base = dk.applyResidentEdit(base, { directoryCode: '101', areaCode: '805' });
  base = dk.applyResidentEdit(base, { directoryCode: '102', areaCode: '213', phone: '5550142' });
  base = dk.applyResidentEdit(base, { directoryCode: '102', areaCode: '310' });
  let work = dk.convertAreaCodeMode(base, 10);
  work = dk.tidyBoard(dk.applyResidentEdit(work, { directoryCode: '101', areaCode: '415' }, { areaCodeSlots: 10 }));
  assert.deepStrictEqual(dk.parseNamesBin(work.names).areaCodes, [null, '310', '415']);
  assert.deepStrictEqual(dk.fileDifferences(dk.buildFiles(base, dk.decodeWorking(work)), work), []);
});

test('entry codes swapped between residents rebuild without a duplicate error', () => {
  const g = syntheticGate();
  const w = dk.decodeWorking(g);
  const code = (c) => w.residents.find((r) => r.directoryCode === c);
  [code('101').entryCode, code('102').entryCode] = [code('102').entryCode, code('101').entryCode];
  const rows = dk.residentRows(dk.buildFiles(g, w)).rows;
  assert.deepStrictEqual(rows.slice(0, 2).map((r) => r.entryCode), ['5678', '1234']);
});

test('saveCacheFiles and readCache give the same files and status as the separate reads', withPull(async (store) => {
  const first = await dk.readCache(store, PHONE); // makes the working copy
  assert.deepStrictEqual(first.status, await dk.cacheStatus(store, PHONE));
  const edited = dk.applyResidentEdit(await working(store), { directoryCode: '101', name: 'Smith, Joan' });
  const saved = await dk.saveCacheFiles(store, PHONE, { 'names.bin': edited.names, 'phone.bin': edited.phone, 'cards.bin': edited.cards });
  const status = await dk.cacheStatus(store, PHONE);
  assert.deepStrictEqual(saved.status.files.map((f) => f.changedBlocks), status.files.map((f) => f.changedBlocks));
  assert.strictEqual(saved.status.edited, true);
  const again = await dk.readCache(store, PHONE);
  assert.ok(again.files['names.bin'].data.equals(edited.names));
  assert.deepStrictEqual(again.status.files.map((f) => f.changedBlocks), status.files.map((f) => f.changedBlocks));
}));

test('after a send with no edits meanwhile, the check pull becomes the base and the working copy', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  await saveWorking(store, dk.applyResidentEdit(await working(store), { directoryCode: '101', name: 'Smith, Joan' }));
  const sent = (await dk.prepareSend(store, PHONE)).files;
  assert.strictEqual(await dk.acceptSentPull(store, PHONE, { ...sent }, sent), null);
  assert.strictEqual((await dk.cacheStatus(store, PHONE)).edited, false);
  assert.ok((await dk.readBaseFiles(store, PHONE)).names.equals(sent['names.bin']));
}));

test('cards are matched by card number, so re-packed slots never make a false conflict', withPull(async (store) => {
  await dk.ensureCache(store, PHONE);
  const cardsOf = (b) => Object.fromEntries(dk.residentRows(b).rows.map((r) => [r.directoryCode, [...r.cards].sort()]));
  // Here: card 200 added to 101 (tidied: it takes slot 0). At the gate: card 50 added to 102 (also slot 0).
  await saveWorking(store, dk.tidyBoard(dk.applyResidentEdit(await working(store), { directoryCode: '101', cards: ['504', '200'] })));
  const r = await pullInto(store, dk.tidyBoard(dk.applyResidentEdit(syntheticGate(), { directoryCode: '102', cards: ['50'] })));
  assert.deepStrictEqual([r.outcome, r.conflicts, r.notKept], ['rebased', [], []]);
  const w = await working(store);
  assert.deepStrictEqual(cardsOf(w), { 101: ['00200', '00504'], 102: ['00050'], 103: [] });
  assert.deepStrictEqual(dk.residentRows(w).unassignedCards, ['15984']);
}));

test('reverting a card change still works after a later edit re-packed the slots', () => {
  const gate = syntheticGate();
  const b1 = dk.tidyBoard(dk.applyResidentEdit(gate, { directoryCode: '101', cards: ['504', '900'] }));
  const p1 = dk.diffStates(dk.decodeWorking(gate), dk.decodeWorking(b1));
  assert.deepStrictEqual(Object.keys(p1.cards), ['00900']); // 15984 only moved slot: not a change
  const b2 = dk.tidyBoard(dk.applyResidentEdit(b1, { directoryCode: '102', cards: ['100'] })); // moves 900 to another slot
  const undone = dk.undoValues(dk.decodeWorking(b2), p1);
  assert.ok(undone);
  const rows = dk.residentRows(dk.buildFiles(b2, undone)).rows;
  assert.deepStrictEqual(rows.map((x) => [x.directoryCode, x.cards]), [['101', ['00504']], ['102', ['00100']], ['103', []]]);
});

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

test('addMissingValues adds setting rows, extra bytes and sizes stored since the working copy was saved, once', withStore(async (store) => {
  const gate = syntheticGate();
  gate.names[0x0f] = 0x0a;
  gate.names[0xfb] = 0x05;
  gate.names[0x37] = 0x01;
  Buffer.from('00f9e0' + '0182b0', 'hex').copy(gate.names, 0xbf);
  await pullInto(store, gate);
  await dk.ensureCache(store, PHONE);
  await setTalkTime(store, '2:30');
  const NEW = ['dialType', 'multipleSystems', 'systemMemory', 'memoryChips', 'downloadStamp1', 'downloadStamp2'];
  const rows = async () => Object.fromEntries((await store.db.query('SELECT key, value FROM gate_settings WHERE phone = $1', [PHONE])).rows
    .map((r) => [r.key, r.value]));
  const before = await rows();
  assert.deepStrictEqual(NEW.map((k) => before[k]), ['Tone', '', '3000', 'Anti-pass back', '', '']);
  const head = async () => (await store.db.query('SELECT extra, sizes FROM gate_working WHERE phone = $1', [PHONE])).rows[0];
  assert.deepStrictEqual(await head(), { extra: { '037': '01' }, sizes: { names: 64000, phone: 30080, cards: 32000 } });
  // As saved before these were stored:
  await store.db.query('DELETE FROM gate_settings WHERE key = ANY($1)', [NEW]);
  await store.db.query('UPDATE gate_working SET extra = NULL, sizes = NULL');
  assert.deepStrictEqual(await dk.addMissingValues(store), [PHONE]);
  assert.deepStrictEqual(await dk.addMissingValues(store), []);
  assert.deepStrictEqual(await rows(), before);
  assert.deepStrictEqual(await head(), { extra: { '037': '01' }, sizes: { names: 64000, phone: 30080, cards: 32000 } });
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
  assert.strictEqual((await store.db.query("SELECT COUNT(*) AS n FROM gate_files WHERE copy = 'pulled' AND name = 'rcv_out.bin'")).rows[0].n, 1);
}));

// The synthetic gate with what a real one also holds: a master code, read-only values, undecoded non-blank bytes.
function fullGate() {
  const gate = syntheticGate();
  Buffer.from([1, 2, 0, 9]).copy(gate.names, 0); // master code 1209 (0 stored as 0x00)
  Object.assign(gate.names, { [0x0f]: 0x0a, [0x06]: 0x0a, [0xfb]: 0x05, [0x37]: 0x01, [0x43]: 0x01, [0x230]: 0x12 });
  Buffer.from('00f9e0' + '0182b0', 'hex').copy(gate.names, 0xbf);
  Buffer.from('70bfec6a' + '75bfec6a', 'hex').copy(gate.names, 0x15);
  return gate;
}

test('rebuild check: the files come out of the values alone, with the master code from managed_gates', () => {
  const gate = fullGate();
  const w = dk.decodeWorking(gate);
  assert.deepStrictEqual(w.extra, { '037': '01', '043': '01', '230': '12' });
  assert.deepStrictEqual(w.sizes, { names: 64000, phone: 30080, cards: 32000 });
  assert.strictEqual(w.residents.find((r) => r.directoryCode === '103').name, ''); // the gate's empty slot
  assert.deepStrictEqual(dk.checkRebuild(gate, { masterCode: '1209' }), { ok: true, problems: [] });
  // Without the master code only its 4 bytes are missing.
  assert.deepStrictEqual(dk.checkRebuild(gate).problems, [{ file: 'names.bin', bytes: 4, offsets: ['0x0', '0x1', '0x2', '0x3'], settings: ['masterCode'] }]);
  // Phone records out of code order keep their positions.
  const swapped = fullGate();
  gate.phone.copy(swapped.phone, 0, 10, 20);
  gate.phone.copy(swapped.phone, 10, 0, 10);
  assert.ok(dk.checkRebuild(swapped, { masterCode: '1209' }).ok);
  // The 10-area-code layout too.
  assert.ok(dk.checkRebuild(dk.convertAreaCodeMode(gate, 10), { masterCode: '1209' }).ok);
  // A byte no value describes (free space after the directory) is reported.
  const junk = fullGate();
  junk.names[0x2000] = 0;
  assert.deepStrictEqual(dk.checkRebuild(junk, { masterCode: '1209' }).problems, [{ file: 'names.bin', bytes: 1, offsets: ['0x2000'] }]);
  // Without recorded sizes there is nothing to build from.
  assert.throws(() => dk.buildFromValues({ ...w, sizes: undefined }), /sizes are not recorded/);
});

test('working copies and sends carry the master code saved with the gate login, 0 written as 00', withStore(async (store) => {
  await dk.createUser(store, { username: 'user1', ['pass' + 'word']: PW, createdBy: 't' });
  await dk.registerGate(store, { ...GATE_A, masterCode: '1209' }, 'user1');
  const same = syntheticGate();
  Buffer.from([1, 2, 0, 9]).copy(same.names, 0);
  await pullInto(store, same);
  await dk.ensureCache(store, PHONE);
  assert.strictEqual((await dk.cacheStatus(store, PHONE)).edited, false); // the gate holds the saved code: no change
  await pullInto(store); // a pull whose master code bytes differ (FF)
  await dk.resetCache(store, PHONE);
  assert.deepStrictEqual([...(await working(store)).names.subarray(0, 4)], [1, 2, 0, 9]);
  assert.deepStrictEqual((await dk.cacheStatus(store, PHONE)).files.find((f) => f.name === 'names.bin').changedBlocks, [0]);
  await setTalkTime(store, '2:30'); // a save rebuilds with the same code
  const { files, changedBlocks } = await dk.prepareSend(store, PHONE);
  assert.deepStrictEqual([...files['names.bin'].subarray(0, 4)], [1, 2, 0, 9]);
  assert.deepStrictEqual(changedBlocks['names.bin'], [0]);
  assert.throws(() => dk.buildFiles(same, dk.decodeWorking(same), { masterCode: '12a9' }), /4 digits/);
}));

test('buildFiles writes read-only settings and extra bytes from their stored values', () => {
  const gate = fullGate();
  const w = dk.decodeWorking(gate);
  const built = dk.buildFiles(gate, { ...w, settings: { ...w.settings, dialType: 'Rotary', memoryChips: '? (0x7)' }, extra: { ...w.extra, '037': '02' } });
  assert.deepStrictEqual([built.names[0x0f], built.names[0xfb], built.names[0x37]], [0x01, 0x07, 0x02]);
  assert.ok(dk.buildFiles(gate, w).names.equals(gate.names));
  // Every read-only value, including the raw "? (...)" form, writes back the bytes it came from.
  for (const f of dk.WRITTEN_FIELDS.filter((x) => !x.editable)) {
    for (const bytes of [gate.names.subarray(f.offset, f.offset + f.type.size), Buffer.alloc(f.type.size, 0xff), Buffer.alloc(f.type.size, 0x07)]) {
      assert.ok(f.type.encode(f.type.decode(bytes)).equals(bytes), `${f.key} ${bytes.toString('hex')}`);
    }
  }
  assert.throws(() => dk.applyGateSettings(gate.names, { dialType: 'Rotary' }), /read-only/);
});

test('checkPull records the rebuild check next to the round-trip check', withStore(async (store) => {
  const gate = fullGate();
  const check = await dk.checkPull(store, PHONE, gate, new Date(T1), { masterCode: '1209' });
  assert.deepStrictEqual([check.ok, check.rebuild.ok, check.carried], [true, true, ['masterCode']]);
  const s = await getGateState(store, PHONE);
  assert.deepStrictEqual([s.roundTripOk, s.rebuildOk, s.rebuildProblems], [true, true, []]);
  gate.names[0x2000] = 0;
  await dk.checkPull(store, PHONE, gate, new Date(T1));
  const t = await getGateState(store, PHONE);
  assert.deepStrictEqual([t.roundTripOk, t.rebuildOk, t.rebuildProblems.map((p) => p.offsets)], [true, false, [['0x0', '0x1', '0x2', '0x3', '0x2000']]]);
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
  const history = dk.orderRcvOut(rcv.data, rcv.mtime); // as readTransactionPage returns the saved history
  const tx = loadData(rcv.mtime, values, null, history).transactions;
  assert.deepStrictEqual(tx.rows.map((r) => [r.number, r.name, r.directoryCode]).reverse(),
    [['108', 'Lee, K', '108'], ['4821', 'Diaz, R', '201'], ['12345', '', '305'], ['04369', 'Unknown', '']]);
  assert.ok(tx.rows.every((r) => r.camera));
  const system = dk.orderRcvOut(Buffer.from('1112a35316000000ffff' + '1112e3530b000000ffff' + '1112e3530c000000ffff', 'hex'), rcv.mtime);
  assert.deepStrictEqual(loadData(rcv.mtime, values, null, system).transactions.rows.map((r) => [r.eventType, r.camera]).reverse(),
    [['RS232', false], ['Hold Begin', false], ['Hold End', false]]);
  assert.strictEqual(tx.updated, rcv.mtime);
  assert.strictEqual(loadData(null, values).transactions, null); // never pulled
  assert.deepStrictEqual(loadData(rcv.mtime, values, null, []).transactions.rows, []); // pulled, no events
});

test('transaction years: worked out backwards from the pull, allowing a gate clock a little ahead', () => {
  const rec = (mmdd) => `${mmdd}a35300f10800ffff`;
  const years = (dates, pulledAt) => dk.orderRcvOut(Buffer.from(dates.map(rec).join(''), 'hex'), pulledAt).map((record) => record.year);
  const nov21 = new Date(2026, 10, 21, 23, 59);
  assert.deepStrictEqual(years(['1120', '1122'], nov21), [2026, 2026], 'gate a few minutes ahead past midnight');
  assert.deepStrictEqual(years(['1225', '1120', '1121'], nov21), [2025, 2026, 2026], 'later in the year: the year before');
  assert.deepStrictEqual(years(['1120', '0000', '1121'], nov21), [2026, 2026, 2026], 'a record with no date changes nothing');
  assert.deepStrictEqual(years(['1230', '0101'], new Date(2026, 11, 31, 23, 59)), [2026, 2027], 'gate already in the new year');
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
  const state = await getGateState(store, PHONE);
  assert.deepStrictEqual([state.pulledAt, state.roundTripOk, state.problems], [T1, true, []]);
  const bad = syntheticGate();
  bad.names[0x07] = 0x0c;
  assert.strictEqual((await dk.checkPull(store, PHONE, bad, new Date(T2))).ok, false);
  assert.deepStrictEqual([(await getGateState(store, PHONE)).pulledAt, (await getGateState(store, PHONE)).roundTripOk], [T2, false]);
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
  assert.ok((await dk.historyEvent(store, '5550100', list.at(-1).id)).event.files); // kept for reverting
}));

test('entryHistory: one directory code\'s changes, newest first, with who and when, and reverts marked', withStore(async (store) => {
  const det = (key, fields, change = 'changed') => ({ key, label: `Resident ${key}`, change, fields });
  const a = await dk.addEvent(store, '5550100', { user: 'ann', action: 'change', summary: 'Edited directory code 101',
    details: [det('101', [{ field: 'Name', from: 'Smith, J', to: 'Smith, Jo' }])] });
  await dk.addEvent(store, '5550100', { user: 'bob', action: 'change', summary: 'Edited directory code 102', details: [det('102', [])] });
  await dk.addEvent(store, '5550100', { user: 'bob', action: 'note', summary: 'Changed the note for directory code 101',
    details: [{ key: '101', label: 'Directory code 101', change: 'changed', fields: [{ field: 'Note', from: '', to: 'Back gate' }] }] });
  await dk.addEvent(store, '5550100', { user: 'cy', action: 'revert', revertOf: a.id, summary: 'Reverted', details: [det('101', [])] });
  await dk.addEvent(store, '5550199', { user: 'zed', action: 'change', summary: 'other gate', details: [det('101', [])] });
  const h = await dk.entryHistory(store, '5550100', '101');
  assert.deepStrictEqual(h.map((c) => [c.user, c.action]), [['cy', 'revert'], ['bob', 'note'], ['ann', 'change']]);
  assert.deepStrictEqual(h[2].fields, [{ field: 'Name', from: 'Smith, J', to: 'Smith, Jo' }]);
  assert.strictEqual(h[2].revertedBy.user, 'cy');
  assert.strictEqual(h[1].revertedBy, null);
  assert.deepStrictEqual(await dk.entryHistory(store, '5550100', '999'), []);
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
  const saved = (await dk.readTransactionPage(store, '5550100')).records;
  assert.deepStrictEqual(saved.map((t) => t.minute), [10, 11, 12, 13, 14, 30, 31]);
  assert.ok(saved.every((t) => t.year === 2026 && t.code === '12345'));
  // Pages, newest first: 3, then the 3 before them, then the last one.
  const p1 = await dk.readTransactionPage(store, '5550100', { limit: 3 });
  const p2 = await dk.readTransactionPage(store, '5550100', { limit: 3, before: p1.next });
  const p3 = await dk.readTransactionPage(store, '5550100', { limit: 3, before: p2.next });
  assert.deepStrictEqual([p1, p2, p3].map((p) => p.records.map((t) => t.minute)), [[14, 30, 31], [11, 12, 13], [10]]);
  assert.strictEqual(p3.next, null);
  assert.strictEqual(await txHistoryCount(store, '5550100'), 7);
  assert.strictEqual(await txHistoryCount(store, '5550199'), 0);
  // The last pull time is recorded even when a pull adds nothing; an older time never replaces a newer one.
  const later = new Date(2026, 9, 22);
  assert.deepStrictEqual(await dk.mergeTransactions(store, '5550100', rcv(30, 31), later), { added: 0, kept: 2, gap: false });
  assert.strictEqual((await dk.txPulledAt(store, '5550100')).getTime(), later.getTime());
  await dk.mergeTransactions(store, '5550100', rcv(31), at);
  assert.strictEqual((await dk.txPulledAt(store, '5550100')).getTime(), later.getTime());
  assert.strictEqual(await dk.txPulledAt(store, '5550199'), null);
}));

test('rcv_out.bin is not kept: a pull skips it, and the stored ones are merged once and deleted', withStore(async (store) => {
  await dk.applyPull(store, PHONE, { 'rcv_out.bin': rcv(10, 11), 'names.bin': syntheticGate().names });
  const kept = (await store.db.query('SELECT copy, name FROM gate_files')).rows.map((r) => `${r.copy}/${r.name}`);
  assert.deepStrictEqual(kept, ['base/names.bin']);
  // As kept before 2026-11-13: one gate already merged (nothing new), one never merged.
  const at = new Date(2026, 9, 21, 12);
  await dk.mergeTransactions(store, PHONE, rcv(10, 11), at);
  await store.db.query('DELETE FROM tx_pulls');
  for (const [phone, data] of [[PHONE, rcv(10, 11)], ['5550199', rcv(20, 21, 22)]]) {
    await store.db.query(`INSERT INTO gate_files (phone, copy, name, data, saved_at) VALUES ($1, 'pulled', 'rcv_out.bin', $2, $3)`,
      [phone, dk.encryptBytes(store, data), at.toISOString()]);
  }
  assert.deepStrictEqual(await dk.migrateRcvOut(store), [{ phone: PHONE, added: 0 }, { phone: '5550199', added: 3 }]);
  assert.deepStrictEqual(await dk.migrateRcvOut(store), []);
  assert.deepStrictEqual((await dk.readTransactionPage(store, PHONE)).records.map((t) => t.minute), [10, 11]);
  assert.deepStrictEqual((await dk.readTransactionPage(store, '5550199')).records.map((t) => t.minute), [20, 21, 22]);
  assert.strictEqual((await dk.txPulledAt(store, '5550199')).getTime(), at.getTime());
  assert.strictEqual((await store.db.query("SELECT COUNT(*) AS n FROM gate_files WHERE name = 'rcv_out.bin'")).rows[0].n, 0);
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

test('accounts: the same username created twice at once gives one account and one refusal', withStore(async (store) => {
  const make = () => dk.createUser(store, { username: 'alex', password: PW, createdBy: 't' });
  const results = await Promise.allSettled([make(), make()]);
  assert.deepStrictEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  assert.strictEqual(results.find((result) => result.status === 'rejected').reason.status, 409);
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
  // Own password change (the route checks the current one): ends the other sessions, keeps this one; clears must-change.
  const keep = await dk.findSession(store, await dk.createSession(store, 'jane'), 60000);
  assert.ok(Math.abs(keep.createdAt - Date.now()) < 60000); // when it signed in (passkey changes on SSO-only accounts)
  const othertoken = await dk.createSession(store, 'jane');
  await assert.rejects(() => dk.changeOwnPassword(store, 'jane', { current: PW, next: PW, keepSession: keep.tokenHash }), /different/);
  await dk.changeOwnPassword(store, 'jane', { current: PW, next: NEW_PW, keepSession: keep.tokenHash });
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
  assert.strictEqual(await dk.useToken(store, 'reset', t1), null); // wrong kind: refused, and left unused
  assert.ok(await dk.peekToken(store, 'verify', t1));
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
  // Accepted twice at once (link and single sign-on): only one wins.
  const both = await Promise.allSettled([dk.acceptInvite(store, 'dee', NEW_PW), dk.acceptInviteWithSso(store, 'dee')]);
  assert.deepStrictEqual(both.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  const accepted = await dk.getUser(store, 'dee');
  if (!(await dk.authenticate(store, 'dee', NEW_PW))) await dk.setPassword(store, 'dee', NEW_PW); // the SSO one won
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

test('clientAddress trusts X-Forwarded-For only from Caddy on this machine; signInKeys', () => {
  assert.strictEqual(dk.clientAddress('127.0.0.1', '203.0.113.7'), '203.0.113.7');
  assert.strictEqual(dk.clientAddress('::ffff:127.0.0.1', '203.0.113.7'), '203.0.113.7');
  assert.strictEqual(dk.clientAddress('::1', '10.0.0.1, 203.0.113.7'), '203.0.113.7'); // the last entry
  assert.strictEqual(dk.clientAddress('198.51.100.9', '203.0.113.7'), '198.51.100.9'); // not from loopback: ignored
  assert.strictEqual(dk.clientAddress('127.0.0.1', undefined), '127.0.0.1');
  assert.deepStrictEqual(dk.signInKeys('jane', '203.0.113.7', 5), [['jane|203.0.113.7', 5], ['ip:203.0.113.7', 20], ['jane', 50]]);
});

test('reauthNeeded: who must re-confirm before an email or passkey change', () => {
  const H = 3600000;
  const base = { strong: false, hasPassword: true, passkeys: 0, signedInAt: 0, resetAt: null, now: 4 * H, windowMs: 3 * H };
  const need = (over, change) => dk.reauthNeeded({ ...base, ...over }, change);
  assert.strictEqual(need({ strong: true, passkeys: 2 }, 'remove-passkey'), 'ok');
  assert.strictEqual(need({}, 'email'), 'password');
  assert.strictEqual(need({}, 'add-passkey'), 'password'); // the first passkey
  // Just signed in: the first passkey without the password again (the browser saving one after a password sign-in).
  assert.strictEqual(need({ signedInAt: 4 * H - dk.FRESH_SIGN_IN_MS }, 'add-passkey'), 'ok');
  assert.strictEqual(need({ signedInAt: 4 * H - dk.FRESH_SIGN_IN_MS - 1 }, 'add-passkey'), 'password');
  assert.strictEqual(need({ signedInAt: 4 * H, passkeys: 1 }, 'add-passkey'), 'step-up', 'not when the account already has one');
  assert.strictEqual(need({ signedInAt: 4 * H }, 'email'), 'password');
  assert.strictEqual(need({ passkeys: 1 }, 'add-passkey'), 'step-up');
  assert.strictEqual(need({ passkeys: 1 }, 'remove-passkey'), 'step-up');
  // Lost passkey: signed in after a reset by email, within the window.
  assert.strictEqual(need({ passkeys: 1, resetAt: 2 * H, signedInAt: 2 * H + 1 }, 'remove-passkey'), 'ok');
  assert.strictEqual(need({ passkeys: 1, resetAt: 2 * H, signedInAt: 2 * H + 1 }, 'add-passkey'), 'password');
  assert.strictEqual(need({ passkeys: 1, resetAt: 2 * H, signedInAt: 2 * H - 1 }, 'remove-passkey'), 'step-up'); // session from before the reset
  assert.strictEqual(need({ passkeys: 1, resetAt: 0, signedInAt: 1 }, 'remove-passkey'), 'step-up'); // reset too long ago
  // No password (single sign-on only).
  assert.strictEqual(need({ hasPassword: false, signedInAt: 2 * H }, 'email'), 'ok');
  assert.strictEqual(need({ hasPassword: false, signedInAt: 0 }, 'email'), 'sign-in-again');
  assert.strictEqual(need({ hasPassword: false, passkeys: 1, signedInAt: 4 * H }, 'email'), 'step-up');
});

test('sessions end after their maximum age; a reset by email stops older reset links and is recorded', withStore(async (store) => {
  await dk.createUser(store, { username: 'jane', password: PW, createdBy: 't', email: 'jane@example.com' });
  const tok = await dk.createSession(store, 'jane');
  await store.db.query("UPDATE sessions SET created_at = now() - interval '8 days'");
  assert.ok(await dk.findSession(store, tok, 3600000)); // no maximum age given
  assert.strictEqual(await dk.findSession(store, tok, 3600000, 7 * 86400000), null); // too old: refused and deleted
  await dk.createSession(store, 'jane');
  await store.db.query("UPDATE sessions SET created_at = now() - interval '8 days'");
  assert.deepStrictEqual(await dk.sweepSessions(store, 3600000, 7 * 86400000), ['jane']);
  const old = await dk.createToken(store, 'reset', 'jane');
  assert.strictEqual((await dk.getUser(store, 'jane')).resetAt, null);
  await dk.setPassword(store, 'jane', NEW_PW, { byEmail: true });
  assert.ok((await dk.getUser(store, 'jane')).resetAt);
  assert.strictEqual(await dk.useToken(store, 'reset', old), null);
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
  await assert.rejects(() => dk.grantAccess(store, '5550100', 'bob', 'owner', 'ann'), /admin, editor or readonly/);
  await dk.grantAccess(store, '5550100', 'BOB', 'readonly', 'ann');
  await assert.rejects(() => dk.grantAccess(store, '5550100', 'bob', 'admin', 'ann'), (e) => e.status === 409 && /already has access/.test(e.message));
  assert.deepStrictEqual((await dk.userGates(store, 'bob')).map((g) => [g.phoneNumber, g.role]), [['5550100', 'readonly']]);
  assert.deepStrictEqual((await dk.gateUsers(store, '5550100')).map((u) => [u.username, u.role, u.grantedBy]), [['ann', 'admin', 'ann'], ['bob', 'readonly', 'ann']]);
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
  await assert.rejects(() => dk.createApiKey(store, '5550100', { name: 'x', role: 'owner' }, 'ann'), /admin, editor or readonly/);
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
    // uv: false for a passkey saved without checking the user (flags user present + attested data only).
    register(options, origin = 'https://gate.example.com', { uv = true } = {}) {
      const authData = Buffer.concat([sha(options.rp.id), Buffer.from([uv ? 0x45 : 0x41]), counter(0), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, Buffer.from(cose)]);
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
  const RP = { rpID: 'gate.example.com', origin: 'https://gate.example.com', challenges: new dk.PasskeyChallenges() };
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
  const local = { rpID: 'localhost', origin: 'http://localhost:8080', challenges: RP.challenges };
  const a4 = await dk.authenticationOptions(local);
  await assert.rejects(() => dk.signInWithPasskey(store, key.signIn(a4, 9, 'http://localhost:8080'), local),
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
  await assert.rejects(async () => dk.signInWithPasskey(store, key.signIn(await dk.authenticationOptions(RP), 30), RP),
    (e) => /not registered here/.test(e.message) && e instanceof dk.UnknownPasskeyError && e.status === 401, 'the page tells the browser to stop offering it');
}));

test('passkeys saved by the browser after a password sign-in: no user check then, only with their own challenge', withStore(async (store) => {
  const RP = { rpID: 'gate.example.com', origin: 'https://gate.example.com', challenges: new dk.PasskeyChallenges() };
  await dk.createUser(store, { username: 'ann', password: PW, createdBy: 't', mustChangePassword: false });
  assert.strictEqual(await dk.passkeyUserHandle(store, 'ann'), null);
  const key = softAuthenticator();
  const auto = await dk.autoRegistrationOptions(store, 'ann', RP);
  assert.strictEqual(auto.authenticatorSelection.userVerification, 'preferred');
  await assert.rejects(() => dk.addPasskey(store, 'ann', key.register(auto, RP.origin, { uv: false }), 'Saved', RP), /could not be added/,
    'an auto challenge is not a normal one');
  const normal = await dk.registrationOptions(store, 'ann', RP);
  await assert.rejects(() => dk.addPasskey(store, 'ann', key.register(normal, RP.origin, { uv: false }), 'Saved', RP), /could not be added/,
    'a normal add still needs the user checked');
  const again = await dk.autoRegistrationOptions(store, 'ann', RP);
  await assert.rejects(() => dk.addAutoPasskey(store, 'ann', key.register(normal, RP.origin, { uv: false }), 'Saved', RP), /could not be added/,
    'a normal challenge is not an auto one');
  const pk = await dk.addAutoPasskey(store, 'ann', key.register(again, RP.origin, { uv: false }), 'Saved', RP);
  assert.strictEqual(pk.name, 'Saved');
  assert.match(await dk.passkeyUserHandle(store, 'ann'), /^[\w-]{43}$/);
  // Signing in with it still needs the user checked.
  const a = await dk.authenticationOptions(RP);
  assert.strictEqual(a.userVerification, 'required');
  assert.strictEqual(await dk.signInWithPasskey(store, key.signIn(a, 1), RP), 'ann');
}));

test('step-up: passkey confirmation of the signed-in user only; sessions remember when they were confirmed', withStore(async (store) => {
  const RP = { rpID: 'gate.example.com', origin: 'https://gate.example.com', challenges: new dk.PasskeyChallenges() };
  await dk.createUser(store, { username: 'ann', ['pass' + 'word']: PW, createdBy: 't', mustChangePassword: false });
  await dk.createUser(store, { username: 'bob', ['pass' + 'word']: PW, createdBy: 't', mustChangePassword: false });
  await assert.rejects(() => dk.confirmationOptions(store, 'ann', RP), (e) => e.status === 409 && /no passkey for gate.example.com/.test(e.message));
  const annKey = softAuthenticator();
  const bobKey = softAuthenticator();
  await dk.addPasskey(store, 'ann', annKey.register(await dk.registrationOptions(store, 'ann', RP)), 'Phone', RP);
  await dk.addPasskey(store, 'bob', bobKey.register(await dk.registrationOptions(store, 'bob', RP)), 'Key', RP);
  const c1 = await dk.confirmationOptions(store, 'ann', RP);
  assert.deepStrictEqual([c1.allowCredentials.map((c) => c.id), c1.userVerification], [[annKey.id], 'required']);
  await dk.confirmWithPasskey(store, 'ann', annKey.signIn(c1, 1), RP);
  await assert.rejects(() => dk.confirmWithPasskey(store, 'ann', annKey.signIn(c1, 2), RP), (e) => e.status === 401); // challenge used once
  // Another account's passkey, a sign-in challenge, or another user's confirmation challenge don't count.
  await assert.rejects(async () => dk.confirmWithPasskey(store, 'ann', bobKey.signIn(await dk.confirmationOptions(store, 'ann', RP), 1), RP), /belongs to another account/);
  await assert.rejects(async () => dk.confirmWithPasskey(store, 'ann', annKey.signIn(await dk.authenticationOptions(RP), 3), RP), (e) => e.status === 401);
  await assert.rejects(async () => dk.confirmWithPasskey(store, 'bob', bobKey.signIn(await dk.confirmationOptions(store, 'ann', RP), 2), RP), (e) => e.status === 401);
  // ... and a confirmation challenge can't sign anyone in.
  await assert.rejects(async () => dk.signInWithPasskey(store, annKey.signIn(await dk.confirmationOptions(store, 'ann', RP), 4), RP), (e) => e.status === 401);
  // Sessions: a passkey sign-in is confirmed from the start; a password session once marked.
  const strong = await dk.findSession(store, await dk.createSession(store, 'ann', { strong: true }), 60000);
  assert.ok(Math.abs(strong.strongAt - Date.now()) < 5000);
  const tok = await dk.createSession(store, 'bob');
  assert.strictEqual((await dk.findSession(store, tok, 60000)).strongAt, null);
  const at = await dk.markSessionStrong(store, (await dk.findSession(store, tok, 60000)).tokenHash, 1_800_000_000_000);
  assert.strictEqual((await dk.findSession(store, tok, 60000)).strongAt, at);
}));

test('docs/openapi.json matches the routes an API key can use (paths, methods, roles) and its references resolve', () => {
  const root = path.join(import.meta.dirname, '..');
  const routesDir = path.join(root, 'web', 'routes');
  const src = fs.readdirSync(routesDir).map((f) => fs.readFileSync(path.join(routesDir, f), 'utf8')).join('\n');
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'openapi.json'), 'utf8'));
  const fromRoutes = new Map();
  for (const m of src.matchAll(/(webOnly\()?route\('(GET|POST|PUT|DELETE)', (`[^`]*`|'[^']*'|G), '([a-z-]+)'/g)) {
    const [, webOnly, method, raw, scope] = m;
    if (webOnly || !scope.startsWith('gate')) continue;
    const sub = raw === 'G' ? '' : raw.replace(/^[`']|[`']$/g, '').replace('${G}', '');
    fromRoutes.set(`${method.toLowerCase()} /api/gates/{phone}${sub.replace(/:(\w+)/g, '{$1}')}`, scope === 'gate' ? 'readonly' : scope === 'gate-editor' ? 'editor' : 'admin');
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
  assert.strictEqual(c.security.sessionMaxHours, 168);
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
  assert.strictEqual(dk.loadConfig({ env: { TRUST_PROXY: 'TRUE' }, args: [] }).server.trustProxy, true);
  assert.throws(() => dk.loadConfig({ env: { TRUST_PROXY: 'maybe' }, args: [] }), /TRUST_PROXY/);
  assert.throws(() => dk.loadConfig({ env: { PORT: '99999' }, args: [] }), /PORT/);
  assert.throws(() => dk.loadConfig({ env: { HOST: '   ' }, args: [] }), /server\.host/);
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
  assert.throws(() => dk.normalizeSchedule({ days: [], time: '02:00', actions: ['send'] }), /day/);
  assert.throws(() => dk.normalizeSchedule([]), /day/);
  assert.throws(() => dk.normalizeSchedule({ days: [1], time: '24:00', actions: ['send'] }), /Time/);
  assert.throws(() => dk.normalizeSchedule({ days: [1], time: '2:00', actions: ['x'] }), /transfer/);
  assert.deepStrictEqual(dk.normalizeSchedule({ days: [3, 1, 1, 9], time: '2:05', actions: ['snapshots', 'transactions', 'send'] }),
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
  assert.throws(() => dk.normalizeCameraSettings({ ...CAM, serial: 'x' }), /serial/);
  assert.throws(() => dk.normalizeCameraSettings([]), /serial/);
  assert.throws(() => dk.normalizeCameraSettings({ ...CAM, channels: [] }), /channels/);
  assert.throws(() => dk.normalizeCameraSettings({ ...CAM, channels: [{ channel: 1 }, { channel: '1' }] }), /twice/);
  assert.throws(() => dk.normalizeCameraSettings({ ...CAM, frames: 9 }), /Frames/);
  assert.throws(() => dk.normalizeCameraSettings({ ...CAM, framesAfter: -1 }), /after the minute/);
  assert.strictEqual(dk.normalizeCameraSettings({ ...CAM, framesAfter: '0' }).framesAfter, 0);
  assert.throws(() => dk.normalizeCameraSettings({ ...CAM, mode: 'film' }), /Save must be/);
  assert.strictEqual(dk.normalizeCameraSettings({ ...CAM, mode: 'video' }).mode, 'video');
  assert.throws(() => dk.normalizeCameraSettings({ ...CAM, clipTries: 0 }), /Video tries/);
  assert.throws(() => dk.normalizeCameraSettings({ ...CAM, clipTries: 6 }), /Video tries/);
  assert.strictEqual(dk.normalizeCameraSettings({ ...CAM, clipTries: '4' }).clipTries, 4);
  assert.deepStrictEqual(dk.normalizeCameraSettings({ ...CAM, channels: [...CAM.channels, { channel: '' }] }), {
    enabled: true, serial: CAM.serial, username: 'viewer', channels: [{ channel: 1, name: 'Front gate' }, { channel: 2, name: '' }],
    clockOffset: 0, mode: 'snapshots', frames: 3, framesAfter: 0, clipTries: 2, events: 'access', backfillHours: 24, keepDays: 0,
  });
  assert.strictEqual(dk.normalizeCameraSettings({ ...CAM, keepDays: '30' }).keepDays, 30);
  assert.throws(() => dk.normalizeCameraSettings({ ...CAM, keepDays: 7 }), /Keep pictures/);
  await assert.rejects(() => dk.saveCameraSettings(store, '5550100', 'u1', { ...CAM, password: '' }), /password is required/);
  const saved = await dk.saveCameraSettings(store, '555-0100', 'u1', CAM);
  assert.strictEqual(saved.password, undefined);
  assert.strictEqual(saved.savedBy, 'u1');
  const raw = (await store.db.query('SELECT password FROM cameras WHERE phone = $1', ['5550100'])).rows[0].password;
  assert.ok(raw.startsWith('v1:') && dk.decrypt(store, raw) === 'pw'); // stored encrypted
  await dk.saveCameraSettings(store, '5550100', 'u2', { ...CAM, password: '', clockOffset: -5 });
  const again = await dk.recorderSettings(store, '5550100');
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
  const cfg = dk.normalizeCameraSettings(CAM);
  const now = ts + 3600000;
  const rows = [
    { ts, access: 'Admit' }, { ts, access: 'Deny' }, { ts: ts - 60000, access: '' },
    { ts: ts - 120000, access: 'Deny' }, { ts: now - 30000, access: 'Admit' }, { ts: ts - 2 * 86400000, access: 'Admit' },
  ];
  assert.deepStrictEqual(dk.pendingMinutes(cfg, rows, {}, now).map((p) => p.minute), ['20261019-0956', '20261019-0954']);
  assert.strictEqual(dk.pendingMinutes({ ...cfg, events: 'all' }, rows, {}, now).length, 3);
  // RS232 transfers and hold-open events never get footage, even with events 'all'; a minute shared with a visit does.
  const system = [{ ts: ts - 180000, eventType: 'RS232', access: '' }, { ts: ts - 240000, eventType: 'Hold Begin', access: 'Hold' },
    { ts: ts - 300000, eventType: 'Hold End', access: 'Rels' }, { ts: ts - 300000, eventType: 'Directory', access: 'Admit' }];
  assert.deepStrictEqual(dk.pendingMinutes({ ...cfg, events: 'all' }, system, {}, now).map((p) => p.minute), ['20261019-0951']);
  assert.deepStrictEqual(['20261019-0953', '20261019-0952', '20261019-0951', '20261019-0900'].map((m) => dk.noFootageMinute(system, m)),
    [true, true, false, false]);
  assert.deepStrictEqual([...dk.noFootageMinutes(system)].sort(), ['20261019-0952', '20261019-0953']); // all at once, for the clean-up
  // Also modem transfers, anti-pass back maintenance and System relay commands, but not a momentary open (System Admit).
  assert.deepStrictEqual([['Modem-to-Modem', ''], ['Modem', ''], ['APB Re-Sync', ''], ['APB Counter', ''], ['System', 'Hold'],
    ['System', 'H/U'], ['System', '1 Hour'], ['System', 'Admit'], ['Open Request', 'Admit'], ['Cards', 'Deny']]
    .map(([eventType, access]) => dk.footageApplies({ eventType, access })), [false, false, false, false, false, false, false, true, true, true]);
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
  put('20261111-0900', { 'ch1.rec2.mp4': 7, 'ch1.mp4.parts.txt': 3 }); // only leftovers: the folder goes too
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
    { minutes: 0, files: 0, bytes: 0, leftovers: 6, leftoverBytes: 88, missing: 1 });
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
  const cfg = { ...dk.normalizeCameraSettings({ ...CAM, mode: 'video', backfillHours: 720 }), keepDays: 30 };
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
  s = await dk.refreshSnapshot(store, holeRunner, { phone: '5550100', dir, minute: '20261019-0955', file: 'ch1-00.jpg' });
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
  await assert.rejects(dk.refreshSnapshot(store, downRunner, { phone: '5550100', dir, minute: '20261019-1003', file: 'ch1-00.jpg' }, opts),
    (e) => e.status === 502 && /Could not reach/.test(e.message));
  assert.match(refreshLog[0], /^Gate 5550100: 20261019-1003\/ch1-00\.jpg refresh failed \(\/cam\/playback\?channel=1&starttime=2026_10_19_10_03_05\)/);
  assert.strictEqual((await dk.listSnapshots(store, '5550100'))['20261019-1003'].status, 'failed');
  await assert.rejects(dk.refreshSnapshot(store, runner, { phone: '5550100', dir, minute: '20261019-1003', file: '..\\key' }, opts), (e) => e.status === 400);
  await assert.rejects(dk.refreshSnapshot(store, runner, { phone: '5550100', dir, minute: '20261019-1003', file: 'ch9-00.jpg' }, opts), (e) => e.status === 404, 'a camera not set up');
  await assert.rejects(dk.refreshSnapshot(store, runner, { phone: '5550100', dir, minute: '20261019-1104', file: 'ch1-00.jpg' }, opts), (e) => e.status === 404, 'a minute not in the log');
  asked = [];
  s = await dk.refreshSnapshot(store, runner, { phone: '5550100', dir, minute: '20261019-1003', file: 'ch1-00.jpg' }, opts);
  assert.deepStrictEqual([s.status, s.files, s.attempts], ['partial', ['ch1-00.jpg'], 1]);
  await dk.refreshSnapshot(store, runner, { phone: '5550100', dir, minute: '20261019-1003', file: 'ch1-a00.jpg' }, opts);
  s = await dk.refreshSnapshot(store, runner, { phone: '5550100', dir, minute: '20261019-1003', file: 'ch1-a30.jpg' }, opts);
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
  await assert.rejects(dk.runSnapshots(store, runner, '5550100', dir, [{ ts: new Date(2026, 9, 19, 9, 31).getTime(), eventType: 'RS232' }],
    { now: ts + 600000, minute: '20261019-0931' }), (e) => e.status === 400 && /data transfers/.test(e.message));
  // Saved footage of a minute whose transactions all never get footage is deleted and marked removed.
  assert.ok(fs.readdirSync(path.join(dir, 'snapshots', '20261019-0930')).length);
  const at930 = new Date(2026, 9, 19, 9, 30).getTime();
  const kept = await dk.removeNoFootageSnapshots(store, '5550100', dir, [{ ts: at930, eventType: 'RS232' }, { ts: at930, eventType: 'Directory', access: 'Admit' }]);
  assert.strictEqual(kept.minutes, 0); // a visit in the same minute keeps it
  const gone = await dk.removeNoFootageSnapshots(store, '5550100', dir, [{ ts: at930, eventType: 'RS232' }, { ts: at930, eventType: 'Hold End', access: 'Rels' }]);
  assert.deepStrictEqual([gone.minutes, gone.files > 0], [1, true]);
  assert.strictEqual(fs.existsSync(path.join(dir, 'snapshots', '20261019-0930')), false);
  const removed = (await dk.listSnapshots(store, '5550100'))['20261019-0930'];
  assert.deepStrictEqual([removed.status, removed.files], ['removed', []]);

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
    ['/cam/playback?channel=1&starttime=2026_10_19_09_40_05&endtime=2026_10_19_09_42_05', 'ch1.new.rec0.mp4', 120],
    ['finish', ['ch1.new.rec0.mp4'], 'ch1.new.mp4', 'ch1.new.jpg'],
    ['/cam/playback?channel=2&starttime=2026_10_19_09_40_05&endtime=2026_10_19_09_42_05', 'ch2.new.rec0.mp4', 120],
    ['finish', ['ch2.new.rec0.mp4'], 'ch2.new.mp4', 'ch2.new.jpg'],
  ]);
  assert.deepStrictEqual((await dk.listSnapshots(store, '5550100'))['20261019-0940'].files.sort(), ['ch1.mp4', 'ch2.mp4']);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'snapshots', '20261019-0940')).sort(), ['ch1.jpg', 'ch1.mp4', 'ch2.jpg', 'ch2.mp4']);
  calls.length = 0;
  s = await dk.refreshSnapshot(store, videoRunner, { phone: '5550100', dir, minute: '20261019-0940', file: 'ch2.mp4' });
  assert.deepStrictEqual(calls.map((c) => c.slice(0, 2)), [
    ['/cam/playback?channel=2&starttime=2026_10_19_09_40_05&endtime=2026_10_19_09_42_05', 'ch2.new.rec0.mp4'], ['finish', ['ch2.new.rec0.mp4']],
  ]);
  assert.strictEqual(s.status, 'done');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'snapshots', '20261019-0940')).sort(), ['ch1.jpg', 'ch1.mp4', 'ch2.jpg', 'ch2.mp4']);

  // A stream that ends early: the rest is asked for from where it stopped, and the parts are joined.
  calls.length = 0;
  partSecs = [42.6, 50.2, 27.9];
  const resumeLog = [];
  await dk.refreshSnapshot(store, videoRunner, { phone: '5550100', dir, minute: '20261019-0940', file: 'ch1.mp4' }, { log: (m) => resumeLog.push(m) });
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
  await assert.rejects(dk.refreshSnapshot(store, videoRunner, { phone: '5550100', dir, minute: '20261019-0940', file: 'ch1.mp4' }, { log: (m) => shortLog.push(m) }),
    /sent only 7 s of 120 s/);
  assert.strictEqual(calls.filter((c) => c[0] === 'finish').length, 2);
  assert.ok(shortLog.includes('Gate 5550100: 20261019-0940/ch1.mp4: the recorder sent 7 s of 120 s, kept it, trying again'));
  assert.ok(shortLog.includes('Gate 5550100: 20261019-0940/ch1.mp4: the recorder sent 7 s of 120 s, deleted it (not longer than the one kept)'));
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'snapshots', '20261019-0940')).sort(), ['ch1.jpg', 'ch1.mp4', 'ch2.jpg', 'ch2.mp4']);
  assert.deepStrictEqual((await dk.listSnapshots(store, '5550100'))['20261019-0940'].short, {});
  // A video cut off by a crash (on disk, not in the log) is fetched again, not taken as a full one.
  fs.mkdirSync(path.join(dir, 'snapshots', '20261019-0942'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'snapshots', '20261019-0942', 'ch1.mp4'), 'cut off');
  await dk.runSnapshots(store, videoRunner, '5550100', dir, [], { now: ts + 600000, minute: '20261019-0942' });
  assert.strictEqual((await dk.listSnapshots(store, '5550100'))['20261019-0942'].short['ch1.mp4'], 7);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'snapshots', '20261019-0942', 'ch1.mp4'), 'utf8'), 'mp4');
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
    assert.deepStrictEqual(calls.filter((c) => c[0] !== 'finish').map((c) => c[1]), i ? ['ch2.new.rec0.mp4', 'ch2.new.rec0.mp4'].slice(0, secsList.length) : ['ch2.new.rec0.mp4', 'ch2.new.rec0.mp4']);
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
  s = await dk.refreshSnapshot(store, gapRunner, { phone: '5550100', dir, minute: '20261019-0940', file: 'ch1.mp4' }, { log: (m) => gapLog.push(m) });
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
  await assert.rejects(dk.refreshSnapshot(store, noRecRunner, { phone: '5550100', dir, minute: '20261019-0940', file: 'ch1.mp4' }), /No recording at this time/);
  assert.strictEqual(calls.length, 23);
  // A failed resume joins what was saved; no video at all is an error.
  calls.length = 0;
  partSecs = [42];
  const failRunner = { ...videoRunner, grabFrame: async (cfg, query, out, o) => {
    if (calls.length) throw new Error('Camera bridge exited (code 1)');
    return videoRunner.grabFrame(cfg, query, out, o);
  } };
  await dk.refreshSnapshot(store, failRunner, { phone: '5550100', dir, minute: '20261019-0940', file: 'ch1.mp4' });
  assert.deepStrictEqual(calls.at(-1)[1], ['ch1.new.rec0.mp4']);
  calls.length = 0;
  partSecs = [0.4];
  await dk.refreshSnapshot(store, videoRunner, { phone: '5550100', dir, minute: '20261019-0940', file: 'ch1.mp4' }); // asked again from the start
  assert.deepStrictEqual(calls.at(-1)[1], ['ch1.new.rec1.mp4']);
  assert.strictEqual(calls[1][0], '/cam/playback?channel=1&starttime=2026_10_19_09_40_05&endtime=2026_10_19_09_42_05');
  partSecs = [0.4, 0.4, 0.4];
  await assert.rejects(dk.refreshSnapshot(store, videoRunner, { phone: '5550100', dir, minute: '20261019-0940', file: 'ch1.mp4' }), /sent no video/);
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

test('a lost idle database connection is logged, not thrown (it would end the server)', withStore(async (store, dir) => {
  await dk.configureLogging({ logsDir: dir, toConsole: false });
  try { store.pool.emit('error', new Error('terminating connection due to administrator command')); } finally { await dk.closeLogging(); }
  const [line] = fs.readFileSync(path.join(dir, dk.LOG_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual([line.level, line.message], ['error', 'Database connection lost: terminating connection due to administrator command']);
  assert.strictEqual((await dk.one(store, 'SELECT 1 AS x')).x, 1);
}));

test('log: JSON lines with the context, secrets replaced, rotated when too big', withDir(async (dir) => {
  await dk.configureLogging({ logsDir: dir, toConsole: false, maxBytes: 600, maxFiles: 2 });
  try {
    await withContext({ requestId: 'r1', user: 'alice' }, async () => {
      dk.logger('gate').error`Gate ${'5550100'}: failed for bob@example.com with dkg_0123456789ab_${'x'.repeat(30)} via rtsp://admin:pw@10.0.0.1/a`;
      dk.logger('api').info('Key created', { password: 'hunter2', masterCode: '1234', name: 'script' });
    });
  } finally { await dk.closeLogging(); }
  const lines = fs.readFileSync(path.join(dir, dk.LOG_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map(({ time, ...rest }) => rest), [
    { level: 'error', category: 'doorking.gate', requestId: 'r1', user: 'alice',
      message: 'Gate 5550100: failed for REDACTED@EMAIL.ADDRESS with dkg_[API key] via rtsp://[login]@10.0.0.1/a' },
    { level: 'info', category: 'doorking.api', requestId: 'r1', user: 'alice', message: 'Key created', name: 'script' },
  ]);
  await dk.configureLogging({ logsDir: dir, toConsole: false, maxBytes: 600, maxFiles: 2 });
  try { for (let i = 0; i < 20; i++) dk.logger('server').info`${'x'.repeat(100)}`; } finally { await dk.closeLogging(); }
  assert.ok(fs.existsSync(path.join(dir, `${dk.LOG_FILE}.1`)), 'rotated');
  assert.ok(!fs.existsSync(path.join(dir, `${dk.LOG_FILE}.3`)), 'at most maxFiles old files');
}));

// --- The server (web/app.ts), started for real on a test schema and a spare port ---

const freePort = () => new Promise((resolve) => {
  const probe = http.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

// Runs fn({ app, store, call, media, dks }) with a started Application. dks.hold(ms): DKS Cloud requests (a local fake)
// answer 500 after ms (CheckLogin answers OK at once). call(method, path, { body, cookie, key, host }) -> { status, body, cookie };
// host: the Host header (localhost:<port> is the name passkeys work on), else 127.0.0.1:<port>.
function withServer(fn) {
  return withDir(async (dir) => {
    const dks = { holdMs: 0, relays: '0000000000000000000', setRelaysCalls: [] };
    const fake = http.createServer((req, res) => {
      const action = req.headers.soapaction || '';
      if (/\/CheckLogin"$/.test(action)) return res.end('<CheckLoginResult>OK</CheckLoginResult>');
      if (/\/GetRelays"$/.test(action)) return res.end(`<GetRelaysResult>${dks.relays}</GetRelaysResult>`);
      if (/\/SetRelays"$/.test(action)) {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const match = /<Settings>([^<]+)<\/Settings>/.exec(body);
          if (match) { dks.setRelaysCalls.push(match[1]); dks.relays = match[1].slice(1); }
          res.end('<SetRelaysResult>OK</SetRelaysResult>');
        });
        return;
      }
      setTimeout(() => { res.statusCode = 500; res.end('fake DKS Cloud: no'); }, dks.holdMs);
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const port = await freePort();
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ server: { port }, paths: { media: path.join(dir, 'media'), logs: path.join(dir, 'logs') },
      dks: { url: `http://127.0.0.1:${fake.address().port}/DkWebService.asmx` } }), { mode: 0o600 });
    const config = dk.loadConfig({ file, env: {}, args: [] });
    const storeOptions = { connection: TEST_DB, keyFile: path.join(dir, 'key'), schema: `t_${crypto.randomBytes(6).toString('hex')}` };
    const app = new Application({ config, cameras: dk.createCameraRunner({}), mailer: null, storeOptions });
    const logLines = console.log;
    console.log = () => {}; // the start-up lines
    try { await app.start(); } finally { console.log = logLines; }
    const store = app.db();
    const call = (method, route, { body, cookie, key, host, headers: extra } = {}) => new Promise((resolve, reject) => {
      const headers = { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(cookie && { Cookie: cookie }),
        ...(key && { Authorization: `Bearer ${key}` }), ...(host && { Host: host }), ...extra };
      const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: (text.startsWith('{') || text.startsWith('[')) ? JSON.parse(text) : text,
          cookie: String((res.headers['set-cookie'] || [''])[0]).split(';')[0] }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    try {
      await fn({ app, config, store, call, media: path.join(dir, 'media'), dks: { hold: (ms) => { dks.holdMs = ms; }, relays: () => dks.relays, setRelaysCalls: dks.setRelaysCalls } });
    } finally {
      await app.stop('test');
      await dropStore(await dk.openStore(storeOptions));
      await new Promise((r) => fake.close(r));
    }
  });
}

async function signIn(call, username, password) {
  const r = await call('POST', '/api/session', { body: { user: username, password } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.cookie;
}

test('usHolidaysForYear computes floating US holidays accurately and orders chronologically', () => {
  const byName = (year) => Object.fromEntries(dk.usHolidaysForYear(year).map((h) => [h.name, `${h.month}/${h.day}`]));
  const h2026 = byName(2026);
  assert.strictEqual(h2026['Martin Luther King Jr. Day'], '1/19');
  assert.strictEqual(h2026["Presidents' Day"], '2/16');
  assert.strictEqual(h2026['Memorial Day'], '5/25');
  assert.strictEqual(h2026['Labor Day'], '9/7');
  assert.strictEqual(h2026['Columbus Day'], '10/12');
  assert.strictEqual(h2026['Thanksgiving'], '11/26');
  assert.strictEqual(h2026['Day after Thanksgiving'], '11/27');
  const h2027 = byName(2027);
  assert.strictEqual(h2027['Memorial Day'], '5/31');
  assert.strictEqual(h2027['Thanksgiving'], '11/25');
});

test('searchGate ranks exact card/entry/directory code matches above names and pages', () => {
  const residents = [
    { directoryCode: '101', name: 'Smith, J', type: 'Resident', hidden: false, areaCode: '214', areaCodeIndex: 0, phone: '5550101', entryCode: '4821', securityLevel: 1, elevatorRef: 1, floor: '', cards: ['10234'], entryOffset: 0, recordOffset: 0, note: 'Front gate' },
    { directoryCode: '102', name: 'Baker, L', type: 'Resident', hidden: false, areaCode: '214', areaCodeIndex: 0, phone: '5550102', entryCode: '', securityLevel: 1, elevatorRef: 1, floor: '', cards: ['20001'], entryOffset: 20, recordOffset: 10, note: '' },
  ];
  const transactions = [
    { ts: 1, minute: '20261121-0900', date: '2026-11-21', time: '9:00 AM', eventType: 'Cards', number: '10234', lookup: 'card', name: 'Smith, J', access: 'Admit', relay: 'Entry', apb: '', directoryCode: '101', camera: true, raw: '00' },
  ];
  const cardHits = searchGate('10234', { residents, transactions, elevators: true });
  assert.strictEqual(cardHits[0].kind, 'resident');
  assert.strictEqual(cardHits[0].resident.directoryCode, '101');
  const codeHits = searchGate('4821', { residents, transactions, elevators: true });
  assert.strictEqual(codeHits[0].kind, 'resident');
  assert.strictEqual(codeHits[0].resident.directoryCode, '101');
  const pageHits = searchGate('holidays', { residents, transactions, elevators: true });
  assert.strictEqual(pageHits[0].kind, 'page');
  assert.strictEqual(pageHits[0].page, 'holidays');
});

test('server: GET /send returns human-readable From -> To changes for unsent edits', withServer(async ({ store, call }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'alice');
  await pullInto(store);
  await dk.ensureCache(store, GATE_A.phoneNumber);
  const cookie = await signIn(call, 'alice', PW);
  assert.strictEqual((await call('PUT', `/api/gates/${GATE_A.phoneNumber}/residents/101`, { cookie, body: { name: 'Smith, Jane' } })).status, 200);
  assert.strictEqual((await call('PUT', `/api/gates/${GATE_A.phoneNumber}/settings`, { cookie, body: { talkTime: '2:00' } })).status, 200);
  const preview = await call('GET', `/api/gates/${GATE_A.phoneNumber}/send`, { cookie });
  assert.strictEqual(preview.status, 200);
  assert.ok(Array.isArray(preview.body.changes) && preview.body.changes.length >= 2);
  const resChange = preview.body.changes.find((c) => c.key === '101');
  assert.ok(resChange && resChange.fields.some((f) => f.field === 'Name' && f.from === 'Smith, J' && f.to === 'Smith, Jane'));
  const talkChange = preview.body.changes.find((c) => c.key === 'talkTime');
  assert.ok(talkChange && talkChange.fields.some((f) => f.to === '2:00'));
}));

test('server: timed Safe Hold-Open saves a relay timer, cancels cleanly, and auto-releases when due', withServer(async ({ app, store, call, dks }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'alice');
  const cookie = await signIn(call, 'alice', PW);
  const held = await call('PUT', `/api/gates/${GATE_A.phoneNumber}/relays`, { cookie, body: { '1': true, holdMinutes: 30 } });
  assert.strictEqual(held.status, 200);
  assert.strictEqual(held.body.timers.length, 1);
  assert.strictEqual(held.body.timers[0].relay, 1);
  assert.strictEqual(dks.relays()[1], '1');
  // Move timer into the past and trigger checkRelayTimers -> relay auto-releases and timer clears.
  await dk.setRelayTimer(store, GATE_A.phoneNumber, 1, new Date(Date.now() - 1000), 'alice');
  await app.modules.jobs.checkRelayTimers();
  assert.strictEqual(dks.relays()[1], '0');
  assert.deepStrictEqual(await dk.listRelayTimers(store, GATE_A.phoneNumber), []);
  // Hold again and cancel timer without changing physical relay.
  assert.strictEqual((await call('PUT', `/api/gates/${GATE_A.phoneNumber}/relays`, { cookie, body: { '2': true, holdMinutes: 15 } })).status, 200);
  const cancelled = await call('DELETE', `/api/gates/${GATE_A.phoneNumber}/relays/2/timer`, { cookie });
  assert.strictEqual(cancelled.status, 200);
  assert.deepStrictEqual(cancelled.body.timers, []);
  assert.strictEqual(dks.relays()[2], '1');
}));

test('server: pull archive dedupes identical pulls, diffs against working copy, and restores with History', withServer(async ({ store, call }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'alice');
  const gate = syntheticGate();
  await dk.applyPull(store, GATE_A.phoneNumber, { 'names.bin': gate.names, 'phone.bin': gate.phone, 'cards.bin': gate.cards });
  await dk.ensureCache(store, GATE_A.phoneNumber);
  const first = await dk.archivePull(store, GATE_A.phoneNumber, gate, { actor: 'alice' });
  assert.ok(first && first.residentsCount === 2 && first.cardsCount === 2);
  // Identical bytes are skipped.
  assert.strictEqual(await dk.archivePull(store, GATE_A.phoneNumber, gate, { actor: 'alice' }), null);
  const cookie = await signIn(call, 'alice', PW);
  assert.strictEqual((await call('PUT', `/api/gates/${GATE_A.phoneNumber}/residents/101`, { cookie, body: { name: 'Smith, Edited' } })).status, 200);
  const list = await call('GET', `/api/gates/${GATE_A.phoneNumber}/pull-archive`, { cookie });
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.pulls.length, 1);
  const diff = await call('GET', `/api/gates/${GATE_A.phoneNumber}/pull-archive/${first.id}/diff`, { cookie });
  assert.strictEqual(diff.status, 200);
  assert.ok(diff.body.changes.some((c) => c.key === '101' && c.fields.some((f) => f.from === 'Smith, Edited' && f.to === 'Smith, J')));
  const restored = await call('POST', `/api/gates/${GATE_A.phoneNumber}/pull-archive/${first.id}/restore`, { cookie, body: {} });
  assert.strictEqual(restored.status, 200);
  const after = await call('GET', `/api/gates/${GATE_A.phoneNumber}/residents/101`, { cookie });
  assert.strictEqual(after.body.name, 'Smith, J');
}));

test('buildAccessAudit finds dormant credentials, unknown cards, entry-code frequency, and traffic stats', withStore(async (store) => {
  await pullInto(store);
  await dk.ensureCache(store, PHONE);
  // Seed two transactions: card 00504 (belongs to 101 Smith, J) admitted, and unknown card 20000 admitted; 102 stays dormant.
  const bcd = (n) => parseInt(String(n), 16);
  const now = new Date();
  const makeRec = (type, cardNum, admit) => {
    const h = now.getHours() % 12 || 12;
    const b = Buffer.from([bcd(now.getMonth() + 1), bcd(now.getDate()), bcd(h) | (now.getHours() >= 12 ? 0x20 : 0) | (admit ? 0x40 : 0), bcd(now.getMinutes()), type, 0, 0, 0, 0xff, 0xff]);
    b.writeUInt16BE(cardNum, 5);
    return b;
  };
  await dk.mergeTransactions(store, PHONE, Buffer.concat([makeRec(2, 504, true), makeRec(2, 20000, true), makeRec(2, 20000, false)]), now);
  const audit = await dk.buildAccessAudit(store, PHONE, { days: 90, now: now.getTime() + 60000 });
  assert.ok(audit.dormant.some((d) => d.directoryCode === '102'), '102 has an entry code with no recent use');
  assert.ok(!audit.dormant.some((d) => d.directoryCode === '101'), '101 used card 00504 recently');
  assert.strictEqual(audit.unknownCards.length, 1);
  assert.deepStrictEqual([audit.unknownCards[0].cardNumber, audit.unknownCards[0].uses, audit.unknownCards[0].admits, audit.unknownCards[0].denies], ['20000', 2, 1, 1]);
  assert.strictEqual(audit.traffic.admits, 2);
  assert.strictEqual(audit.traffic.denies, 1);
}));

test('webhooks: SSRF URL blocking, HMAC-SHA256 signing, delivery, retry backoff, and cascade delete', withStore(async (store) => {
  assert.throws(() => dk.checkWebhookUrl('http://example.com/hook'), /https/);
  assert.throws(() => dk.checkWebhookUrl('https://127.0.0.1/hook'), /loopback/);
  assert.throws(() => dk.checkWebhookUrl('https://169.254.169.254/latest/meta-data'), /loopback/);
  const received = [];
  let failNext = true;
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = failNext ? 500 : 200;
      res.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${receiver.address().port}/hook`;
    const { webhook, secret } = await dk.createWebhook(store, PHONE, { name: 'HA', url, events: ['relay.changed'] }, 'alice', true);
    assert.ok(secret.startsWith('whsec_'));
    assert.strictEqual(await dk.queueWebhookEvent(store, PHONE, 'pull.completed', {}), 0);
    assert.strictEqual(await dk.queueWebhookEvent(store, PHONE, 'relay.changed', { relay: 1 }), 1);
    // First delivery fails (500) -> stays queued for retry.
    assert.deepStrictEqual(await dk.deliverQueuedWebhooks(store), { sent: 0, failed: 1 });
    let deliveries = await dk.listWebhookDeliveries(store, PHONE);
    assert.deepStrictEqual([deliveries[0].status, deliveries[0].attempts, deliveries[0].lastStatus], ['queued', 1, 500]);
    // Second delivery succeeds (200) -> marked sent, valid HMAC signature.
    failNext = false;
    await dk.run(store, 'UPDATE webhook_deliveries SET next_try = now() - interval \'1 minute\'');
    assert.deepStrictEqual(await dk.deliverQueuedWebhooks(store), { sent: 1, failed: 0 });
    deliveries = await dk.listWebhookDeliveries(store, PHONE);
    assert.strictEqual(deliveries[0].status, 'sent');
    const last = received[received.length - 1];
    assert.strictEqual(last.headers['x-doorking-event'], 'relay.changed');
    assert.strictEqual(last.headers['x-doorking-signature'], dk.signWebhookPayload(secret, String(last.headers['x-doorking-timestamp']), last.body));
    // Test ping works synchronously and delete cascades deliveries.
    assert.strictEqual((await dk.sendTestWebhook(store, PHONE, webhook.id)).ok, true);
    await dk.deleteWebhook(store, PHONE, webhook.id);
    assert.deepStrictEqual(await dk.listWebhookDeliveries(store, PHONE), []);
  } finally {
    await new Promise((r) => receiver.close(r));
  }
}));

test('server: editor role edits working copy + bulk/import, but cannot send, control relays, or manage users', withServer(async ({ store, call }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  await dk.createUser(store, { username: 'eddie', password: PW, createdBy: 'alice', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'alice');
  await dk.grantAccess(store, GATE_A.phoneNumber, 'eddie', 'editor', 'alice');
  await pullInto(store);
  await dk.ensureCache(store, GATE_A.phoneNumber);
  const edCookie = await signIn(call, 'eddie', PW);
  // Editor can edit working copy, run bulk updates, and preview/apply CSV import.
  assert.strictEqual((await call('PUT', `/api/gates/${GATE_A.phoneNumber}/residents/101`, { cookie: edCookie, body: { name: 'Smith, Ed' } })).status, 200);
  const bulk = await call('POST', `/api/gates/${GATE_A.phoneNumber}/residents/bulk`, { cookie: edCookie, body: { action: 'setSecurityLevel', codes: ['101', '102'], securityLevel: 5 } });
  assert.strictEqual(bulk.status, 200);
  assert.strictEqual(bulk.body.count, 2);
  const preview = await call('POST', `/api/gates/${GATE_A.phoneNumber}/residents/import`, {
    cookie: edCookie,
    body: { dryRun: true, rows: [{ directoryCode: '101', name: 'Smith, Imported' }, { directoryCode: '104', name: 'New Person', phone: '5550104', areaCode: '214' }] },
  });
  assert.strictEqual(preview.status, 200);
  assert.deepStrictEqual([preview.body.added, preview.body.updated, preview.body.errors.length], [1, 1, 0]);
  // dryRun did not save.
  assert.strictEqual((await call('GET', `/api/gates/${GATE_A.phoneNumber}/residents/101`, { cookie: edCookie })).body.name, 'Smith, Ed');
  // Apply import saves both in one History entry.
  const applied = await call('POST', `/api/gates/${GATE_A.phoneNumber}/residents/import`, {
    cookie: edCookie,
    body: { rows: [{ directoryCode: '101', name: 'Smith, Imported' }, { directoryCode: '104', name: 'New Person', phone: '5550104', areaCode: '214' }] },
  });
  assert.strictEqual(applied.status, 200);
  assert.strictEqual((await call('GET', `/api/gates/${GATE_A.phoneNumber}/residents/104`, { cookie: edCookie })).body.name, 'New Person');
  // Editor CANNOT send to gate, control live relays, download raw files, or manage gate users.
  assert.strictEqual((await call('POST', `/api/gates/${GATE_A.phoneNumber}/send`, { cookie: edCookie, body: { confirm: true } })).status, 403);
  assert.strictEqual((await call('PUT', `/api/gates/${GATE_A.phoneNumber}/relays`, { cookie: edCookie, body: { '1': true } })).status, 403);
  assert.strictEqual((await call('GET', `/api/gates/${GATE_A.phoneNumber}/users`, { cookie: edCookie })).status, 403);
}));

test('server: sign-in, wrong passwords limited, and pages need a session', withServer(async ({ store, call }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  assert.strictEqual((await call('GET', '/api/me')).status, 401);
  const cookie = await signIn(call, 'alice', PW);
  assert.strictEqual((await call('GET', '/api/me', { cookie })).body.username, 'alice');
  for (let i = 0; i < 5; i++) assert.strictEqual((await call('POST', '/api/session', { body: { user: 'alice', password: 'wrong password here' } })).status, 401);
  const blocked = await call('POST', '/api/session', { body: { user: 'alice', password: PW } });
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual((await call('GET', '/api/gates/%E0', { cookie })).status, 400);
}));

test('server: simultaneous wrong sign-ins cannot burst past the rate limit', withServer(async ({ store, call }) => {
  await dk.createUser(store, { username: 'bob', password: PW, createdBy: 'test', mustChangePassword: false });
  const results = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/session', { body: { user: 'bob', password: 'wrong password here' } })));
  assert.strictEqual(results.filter((r) => r.status === 401).length, 5);
  assert.strictEqual(results.filter((r) => r.status === 429).length, 5);
}));

test('server: changing your own password needs the current one, and a different new one', withServer(async ({ store, call }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  const cookie = await signIn(call, 'alice', PW);
  const change = (current, password) => call('PUT', '/api/me/password', { cookie, body: { current, password } });
  assert.strictEqual((await change('wrong password here', NEW_PW)).status, 403);
  assert.match((await change(PW, PW)).body.error, /different/);
  assert.strictEqual((await change(PW, NEW_PW)).status, 200);
  assert.ok(await dk.authenticate(store, 'alice', NEW_PW));
}));

test('server: an API key reaches only its own gate, never the web-only routes; sends need a passkey confirmation', withServer(async ({ store, call }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'alice');
  await dk.registerGate(store, { ...GATE_A, phoneNumber: '5550111' }, 'alice');
  const { key } = await dk.createApiKey(store, GATE_A.phoneNumber, { name: 'script', role: 'admin' }, 'alice');
  assert.strictEqual((await call('GET', `/api/gates/${GATE_A.phoneNumber}/prefs`, { key })).status, 200);
  assert.strictEqual((await call('GET', '/api/gates/5550111/prefs', { key })).status, 403);
  assert.strictEqual((await call('GET', `/api/gates/${GATE_A.phoneNumber}/users`, { key })).status, 403);
  assert.strictEqual((await call('GET', `/api/gates/${GATE_A.phoneNumber}/prefs`, { key: 'dkg_000000000000_nope' })).status, 401);
  const cookie = await signIn(call, 'alice', PW);
  const send = await call('POST', `/api/gates/${GATE_A.phoneNumber}/send`, { cookie, body: {} });
  assert.strictEqual(send.status, 403);
  assert.strictEqual(send.body.stepUp, true);
}));

test('server: stop() refuses new requests and waits for the running gate connection', withServer(async ({ app, store, call, dks }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'alice');
  const cookie = await signIn(call, 'alice', PW);
  dks.hold(800);
  assert.strictEqual((await call('POST', `/api/gates/${GATE_A.phoneNumber}/pull`, { cookie, body: { what: 'transactions' } })).status, 202);
  const started = Date.now();
  const stopping = app.stop('test');
  assert.strictEqual((await call('GET', `/api/gates/${GATE_A.phoneNumber}/job`, { cookie }).catch(() => ({ status: 503 }))).status, 503);
  await stopping;
  assert.ok(Date.now() - started >= 500, 'stop() returned before the gate connection ended');
}));

test('server: one gate connection at a time per DKS account; gates on other accounts run at the same time', withServer(async ({ store, call, dks }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'alice');
  await dk.registerGate(store, { ...GATE_A, phoneNumber: '5550111', dksUser: 'otheruser' }, 'alice');
  await dk.registerGate(store, { ...GATE_A, phoneNumber: '5550122', dksUser: 'DKSUser' }, 'alice'); // the same login as GATE_A
  const cookie = await signIn(call, 'alice', PW);
  dks.hold(800);
  const pull = (phone) => call('POST', `/api/gates/${phone}/pull`, { cookie, body: { what: 'transactions' } });
  assert.strictEqual((await pull(GATE_A.phoneNumber)).status, 202);
  assert.strictEqual((await pull('5550111')).status, 202, 'another DKS account is not blocked');
  const same = await pull('5550122');
  assert.strictEqual(same.status, 409);
  assert.match(same.body.error, /same DKS login/);
  assert.strictEqual((await call('GET', '/api/gates/5550122/job', { cookie })).body.busyElsewhere, true);
  assert.strictEqual((await call('GET', '/api/gates/5550122/relays', { cookie })).status, 409, 'relay calls wait for the account too');
  const job = (await call('GET', `/api/gates/${GATE_A.phoneNumber}/job`, { cookie })).body;
  assert.strictEqual(job.state, 'running');
  assert.strictEqual(job.account, undefined, 'the DKS login is not shown');
  assert.strictEqual((await call('GET', '/api/gates/5550111/job', { cookie })).body.state, 'running');
  // The gate's DKS login changed while its pull runs: the gate itself is still busy.
  await dk.updateGateLogin(store, GATE_A.phoneNumber, { dksUser: 'newlogin', dksPassword: 'pw' });
  assert.strictEqual((await pull(GATE_A.phoneNumber)).status, 409);
}));

test('server: a gate\'s stored data is not deleted while its connection runs', withServer(async ({ store, call, dks }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'alice');
  const cookie = `sid=${await dk.createSession(store, 'alice', { strong: true })}`; // just confirmed with a passkey
  dks.hold(800);
  assert.strictEqual((await call('POST', `/api/gates/${GATE_A.phoneNumber}/pull`, { cookie, body: { what: 'transactions' } })).status, 202);
  const refused = await call('POST', `/api/gates/${GATE_A.phoneNumber}/delete-data`, { cookie, body: { confirm: true } });
  assert.strictEqual(refused.status, 409);
  assert.ok(await dk.gateExists(store, GATE_A.phoneNumber));
}));

test('server: the gate-add window shows the newest add of the user', withServer(async ({ store, call, dks }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  const cookie = await signIn(call, 'alice', PW);
  dks.hold(100);
  const add = (phoneNumber) => call('POST', '/api/gates', { cookie, body: { phoneNumber, masterCode: '1234', dksUser: 'u', dksPassword: 'p' } });
  const settled = async () => { while ((await call('GET', '/api/gate-add', { cookie })).body.job?.state === 'running') await new Promise((r) => setTimeout(r, 50)); };
  for (const phone of ['5550111', '5550122']) {
    assert.strictEqual((await add(phone)).status, 202);
    await settled();
  }
  dks.hold(800);
  assert.strictEqual((await add('5550111')).status, 202);
  const { job } = (await call('GET', '/api/gate-add', { cookie })).body;
  assert.deepStrictEqual([job.phoneNumber, job.state, job.account], ['5550111', 'running', undefined]);
}));

test('server: saved videos: byte ranges, a cancelled request closes the file, a missing file is a 404', withServer(async ({ app, store, call, media }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'alice');
  const cookie = await signIn(call, 'alice', PW);
  const folder = path.join(media, GATE_A.phoneNumber, 'snapshots', '20261019-0955');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'ch1.mp4'), Buffer.alloc(4 << 20, 7));
  fs.writeFileSync(path.join(folder, 'ch1-00.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const jpg = await call('GET', `/api/gates/${GATE_A.phoneNumber}/snapshots/20261019-0955/ch1-00.jpg`, { cookie });
  assert.strictEqual(jpg.status, 200);
  const missingJpg = await call('GET', `/api/gates/${GATE_A.phoneNumber}/snapshots/20261019-0955/ch9-00.jpg`, { cookie });
  assert.deepStrictEqual([missingJpg.status, missingJpg.body], [404, { error: 'Snapshot not found' }]);
  const get = (range, { cancel = false } = {}) => new Promise((resolve, reject) => {
    const req = http.get({ agent: false, host: '127.0.0.1', port: app.port(), path: `/api/gates/${GATE_A.phoneNumber}/snapshots/20261019-0955/ch1.mp4`,
      headers: { Cookie: cookie, ...(range && { Range: range }) } }, (res) => {
      if (cancel) { res.once('data', () => { req.destroy(); resolve({ status: res.statusCode }); }); return; }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, range: res.headers['content-range'], length: Buffer.concat(chunks).length }));
    });
    req.on('error', reject);
  });
  assert.deepStrictEqual(await get('bytes=10-19'), { status: 206, range: `bytes 10-19/${4 << 20}`, length: 10 });
  assert.strictEqual((await get('bytes=99999999-')).status, 416);
  const open = () => fs.readdirSync('/proc/self/fd').filter((fd) => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith('ch1.mp4'); } catch { return false; } }).length;
  await get('', { cancel: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.strictEqual(open(), 0, 'the file is closed once the browser cancels');
  fs.rmSync(folder, { recursive: true });
  assert.strictEqual((await get('bytes=0-9')).status, 404);
}));

test('server: stop() returns promptly even with a paused video download open', withServer(async ({ app, store, call, media }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'alice');
  const cookie = await signIn(call, 'alice', PW);
  const folder = path.join(media, GATE_A.phoneNumber, 'snapshots', '20261019-0955');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'ch1.mp4'), Buffer.alloc(16 << 20, 7));
  const sock = net.connect(app.port(), '127.0.0.1');
  sock.write(`GET /api/gates/${GATE_A.phoneNumber}/snapshots/20261019-0955/ch1.mp4 HTTP/1.1\r\nHost: 127.0.0.1:${app.port()}\r\nCookie: ${cookie}\r\n\r\n`);
  await new Promise((resolve) => sock.once('data', resolve));
  sock.pause();
  const started = Date.now();
  await app.stop('test');
  sock.destroy();
  assert.ok(Date.now() - started < 2000, `stop() took ${Date.now() - started} ms with a paused stream`);
}));

test('DksCloudClient: builds escaped SOAP envelopes and parses normal, empty, entity, CDATA and fault replies', async () => {
  let reply = '';
  let status = 200;
  let lastBody = '';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      res.statusCode = status;
      res.end(reply);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/DkWebService.asmx`;
  const env = (inner) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
  const client = new dk.DksCloudClient({ url });
  try {
    reply = env('<CheckLoginResponse xmlns="http://offbyone.org/DkRemoteModemWebService"><CheckLoginResult>OK</CheckLoginResult></CheckLoginResponse>');
    assert.strictEqual(await client.checkLogin('a&b<c>', '"p\'w"'), 'OK');
    assert.ok(lastBody.includes('<UserID>a&amp;b&lt;c&gt;</UserID>'));
    assert.ok(lastBody.includes('<password>&quot;p&apos;w&quot;</password>'));

    reply = env('<GetSessionStatusResponse><GetSessionStatusResult>a &amp; b &lt;c&gt; line&#xD;\n2</GetSessionStatusResult></GetSessionStatusResponse>');
    assert.strictEqual(await client.getSessionStatus('s1'), 'a & b <c> line\r\n2');

    reply = env('<GetSessionStatusResponse><GetSessionStatusResult /></GetSessionStatusResponse>');
    assert.strictEqual(await client.getSessionStatus('s1'), '');

    reply = env('<GetSessionStatusResponse><GetSessionStatusResult><![CDATA[00012 & <b>]]></GetSessionStatusResult></GetSessionStatusResponse>');
    assert.strictEqual(await client.getSessionStatus('s1'), '00012 & <b>');

    status = 500;
    reply = env('<soap:Fault><faultstring>Bad &amp; broken</faultstring></soap:Fault>');
    await assert.rejects(() => client.getSessionStatus('s1'), /SOAP fault: Bad & broken/);

    status = 502;
    reply = '<html><body><h1>502 Bad Gateway</h1><p>truncated';
    await assert.rejects(() => client.getSessionStatus('s1'), /HTTP 502/);

    status = 200;
    reply = '<!DOCTYPE foo [<!ENTITY xxe "pwned">]><GetSessionStatusResult>&xxe;</GetSessionStatusResult>';
    await assert.rejects(() => client.getSessionStatus('s1'), /DOCTYPE/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('server: a wrong first-account setup code is refused, whatever its characters', withServer(async ({ call }) => {
  for (const setupCode of ['0123456789', 'é'.repeat(10), '']) {
    const reply = await call('POST', '/api/setup', { body: { setupCode, username: 'alice', password: PW } });
    assert.strictEqual(reply.status, 403, `${setupCode}: ${JSON.stringify(reply.body)}`);
  }
}));

test('server: two gates added at once on the same DKS login: one starts, the other waits', withServer(async ({ store, call, dks }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  const cookie = await signIn(call, 'alice', PW);
  dks.hold(300);
  const add = (phoneNumber) => call('POST', '/api/gates', { cookie, body: { phoneNumber, masterCode: '1234', dksUser: 'u', dksPassword: 'p' } });
  const replies = await Promise.all([add('5550111'), add('5550122')]);
  assert.deepStrictEqual(replies.map((reply) => reply.status).sort(), [202, 409]);
}));

test('server: scheduled transfers queue per DKS account', withServer(async ({ app, store, call, dks }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  const gates = [GATE_A.phoneNumber, '5550111', '5550122'];
  await dk.registerGate(store, GATE_A, 'alice');
  await dk.registerGate(store, { ...GATE_A, phoneNumber: gates[1], dksUser: 'otheruser' }, 'alice');
  await dk.registerGate(store, { ...GATE_A, phoneNumber: gates[2] }, 'alice'); // the same login as GATE_A
  const keys = [];
  for (const phone of gates) keys.push((await dk.createApiKey(store, phone, { name: 'script', role: 'admin' }, 'alice')).key);
  dks.hold(800);
  const ids = [];
  for (const phone of gates) ids.push((await dk.saveSchedule(store, phone, 'alice', { days: [0], time: '03:00', actions: ['transactions'], enabled: false })).id);
  // Queued at the same moment (as due schedules are): the two on one login (either may go first) run one after the other.
  const schedules = await Promise.all(gates.map((phone, i) => dk.getSchedule(store, phone, ids[i])));
  assert.deepStrictEqual(await Promise.all(schedules.map((schedule) => app.modules.jobs.queueSchedule(schedule, true))), [true, true, true]);
  await new Promise((r) => setTimeout(r, 200));
  const states = async () => Promise.all(gates.map(async (phone, i) => (await call('GET', `/api/gates/${phone}/job`, { key: keys[i] })).body.state));
  const first = await states();
  assert.strictEqual(first[1], 'running', 'another DKS login runs at the same time');
  assert.deepStrictEqual([first[0], first[2]].sort(), ['idle', 'running'], 'one of the two on the same DKS login waits');
  const waiting = first[0] === 'idle' ? 0 : 2;
  assert.strictEqual((await dk.getSchedule(store, gates[waiting], ids[waiting])).lastRun, null, 'it waits: it did not run (and fail as busy)');
  // Both are known as queued or running: Run now again starts neither a second time.
  assert.deepStrictEqual(await Promise.all(schedules.map((schedule) => app.modules.jobs.queueSchedule(schedule, true))), [false, false, false]);
  // Deleted while it waits: it doesn't run.
  assert.strictEqual((await call('DELETE', `/api/gates/${gates[waiting]}/schedules/${ids[waiting]}`, { key: keys[waiting] })).status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual((await states())[waiting], 'idle');
}));

test('page files: the built page, /assets/ and the app files at the top of the build; nothing outside it', (t) => {
  for (const bad of ['/../config.json', '/assets/../../config.json', '/.env', '/sw.js/x', '/%2e%2e/config.json', '/index.html.bak', '/api']) {
    assert.strictEqual(staticFile(bad), null, bad);
  }
  if (!staticFile('/')) return t.skip('the page is not built (npm run build)');
  assert.deepStrictEqual(staticFile('/manifest.webmanifest')?.[1], 'application/manifest+json');
  assert.deepStrictEqual(staticFile('/sw.js')?.[1], 'text/javascript');
  assert.deepStrictEqual(staticFile('/index.html')?.[1], 'text/html', 'the service worker caches it by this name');
  assert.deepStrictEqual(staticFile('/pwa-192x192.png')?.[1], 'image/png');
});

test('server: a passkey is saved without the password only for the first one, right after signing in', withServer(async ({ app, store, call }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  const host = `localhost:${app.port()}`;
  const signInOn = async () => (await call('POST', '/api/session', { host, body: { user: 'alice', password: PW } })).cookie;
  const autoOptions = (cookie) => call('POST', '/api/me/passkeys/options', { host, cookie, body: { auto: true } });
  const fresh = await autoOptions(await signInOn());
  assert.strictEqual(fresh.status, 200, JSON.stringify(fresh.body));
  assert.strictEqual(fresh.body.authenticatorSelection.userVerification, 'preferred');
  const cookie = await signInOn();
  await store.db.query("UPDATE sessions SET created_at = now() - interval '3 minutes' WHERE username = 'alice'");
  assert.strictEqual((await autoOptions(cookie)).status, 409, 'signed in more than 2 minutes ago');
  const now = await signInOn();
  const key = softAuthenticator();
  const options = (await autoOptions(now)).body;
  const added = await call('POST', '/api/me/passkeys', { host, cookie: now, body: { auto: true, name: 'Saved', response: key.register(options, `http://${host}`, { uv: false }) } });
  assert.strictEqual(added.status, 201, JSON.stringify(added.body));
  assert.strictEqual((await autoOptions(now)).status, 409, 'the account has a passkey now');
}));

test('passkey approvals: one code per account, for 10 minutes', () => {
  const approvals = new dk.PasskeyApprovals();
  const first = approvals.create('ann', 0).code;
  const { code } = approvals.create('ann', 0);
  assert.strictEqual(approvals.accepts('ann', first, 1), first === code, 'a new code replaces the old one');
  assert.strictEqual(approvals.accepts('bob', code, 1), false, 'only for its own account');
  assert.strictEqual(approvals.accepts('ann', code, dk.APPROVAL_MS), true);
  assert.strictEqual(approvals.accepts('ann', code, dk.APPROVAL_MS + 1), false, 'expired');
});

test('server: a device signed in with a passkey approves another device to add one', withServer(async ({ app, store, call }) => {
  await dk.createUser(store, { username: 'alice', password: PW, createdBy: 'test', mustChangePassword: false });
  const host = `localhost:${app.port()}`;
  const origin = `http://${host}`;
  const laptop = softAuthenticator();
  const rp = { rpID: 'localhost', origin, challenges: new dk.PasskeyChallenges() };
  await dk.addPasskey(store, 'alice', laptop.register(await dk.registrationOptions(store, 'alice', rp), origin), 'Laptop', rp);
  // The laptop signs in with its passkey (a confirmed session) and creates a code.
  const signInOptions = (await call('POST', '/api/passkey/options', { host, body: {} })).body;
  const laptopCookie = (await call('POST', '/api/passkey/session', { host, body: { response: laptop.signIn(signInOptions, 1, origin) } })).cookie;
  const approval = await call('POST', '/api/me/passkeys/approval', { host, cookie: laptopCookie, body: {} });
  assert.strictEqual(approval.status, 201, JSON.stringify(approval.body));
  assert.match(approval.body.code, /^[A-HJKMNP-Z2-9]{8}$/);
  // The phone signs in with the password: without the code it must confirm with a passkey it doesn't have.
  const phoneCookie = (await call('POST', '/api/session', { host, body: { user: 'alice', password: PW } })).cookie;
  const options = (body) => call('POST', '/api/me/passkeys/options', { host, cookie: phoneCookie, body });
  assert.strictEqual((await options({})).body.stepUp, true);
  assert.strictEqual((await options({ approval: 'WRONGCOD' })).status, 403);
  const typed = `${approval.body.code.slice(0, 4).toLowerCase()}-${approval.body.code.slice(4)}`; // as typed: case and dash ignored
  const phone = softAuthenticator();
  const allowed = await options({ approval: typed });
  assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
  assert.strictEqual((await call('POST', '/api/me/passkeys', { host, cookie: phoneCookie, body: { name: 'Phone', response: phone.register(allowed.body, origin) } })).status, 201);
  assert.strictEqual((await options({ approval: approval.body.code })).status, 403, 'used up once a passkey was added');
  // Five wrong codes drop a code.
  const second = (await call('POST', '/api/me/passkeys/approval', { host, cookie: laptopCookie, body: {} })).body.code;
  for (let i = 0; i < 5; i++) await options({ approval: 'WRONGCOD' });
  assert.strictEqual((await options({ approval: second })).status, 403);
}));

// --- Single sign-on (OpenID Connect) ---

// A minimal OpenID provider on localhost: discovery, signing key, and a token endpoint that checks PKCE and the client
// secret and signs the ID token (RS256) with the flow's nonce. authorize(url, claims) answers an authorization request
// like a signed-in user would; the result is the callback's query.
async function mockProvider(issuerPath = '/oidc') {
  const http = await import('node:http');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (claims) => {
    const head = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64(claims)}`;
    return `${head}.${crypto.sign('sha256', Buffer.from(head), privateKey).toString('base64url')}`;
  };
  let issuer = '';
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (o, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'] });
    }
    if (url.pathname.endsWith('/jwks')) return json({ keys: [jwk] });
    if (url.pathname.endsWith('/token')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const f = new URLSearchParams(body);
        const c = codes.get(f.get('code'));
        codes.delete(f.get('code'));
        if (!c || f.get('client_secret') !== 'shh' || f.get('redirect_uri') !== c.redirectUri
          || crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') !== c.challenge) return json({ error: 'invalid_grant' }, 400);
        const now = Math.floor(Date.now() / 1000);
        json({ access_token: 'at', token_type: 'Bearer', expires_in: 300,
          id_token: sign({ iss: issuer, aud: 'app-id', iat: now, exp: now + 300, nonce: c.nonce, ...c.claims }) });
      });
      return undefined;
    }
    return json({ error: 'not found' }, 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${server.address().port}${issuerPath}`;
  const authorize = (url, claims, { nonce } = {}) => {
    const q = new URL(url).searchParams;
    const code = crypto.randomBytes(8).toString('hex');
    codes.set(code, { claims, nonce: nonce ?? q.get('nonce'), challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
    return new URLSearchParams({ code, state: q.get('state') });
  };
  return { issuer, authorize, close: () => server.close() };
}
const provider = (over = {}) => ({ id: 'work', name: 'Work', issuer: 'https://login.example.com/tenant/v2.0', clientId: 'app-id',
  clientSecret: 'shh', allowedDomains: ['example.com'], autoCreate: false, passwords: true, ...over });
const ssoResult = (claims, over = {}) => ({ mode: 'signin', identity: dk.claimsOf({ email_verified: true, ...claims }), ...over });

test('config: sso providers are checked; the client secret is masked', withDir(async (dir) => {
  const file = path.join(dir, 'config.json');
  const write = (o) => fs.writeFileSync(file, JSON.stringify(o), { mode: 0o600 });
  const one = { id: 'Entra', name: 'Microsoft', issuer: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0',
    clientId: 'app', clientSecret: 'shh', allowedDomains: ['Example.com'] };
  write({ sso: { providers: [one] } });
  const c = dk.loadConfig({ file, env: {}, args: [] });
  assert.deepStrictEqual(c.sso.providers, [{ ...one, id: 'entra', allowedDomains: ['example.com'], autoCreate: false, passwords: true, maxAgeHours: 0 }]);
  assert.strictEqual(dk.maskedConfig(c).sso.providers[0].clientSecret, '***');
  write({});
  assert.deepStrictEqual(dk.loadConfig({ file, env: {}, args: [] }).sso, { providers: [] });
  const bad = (providers, re) => { write({ sso: { providers } }); assert.throws(() => dk.loadConfig({ file, env: {}, args: [] }), re); };
  bad([{ ...one, issuer: 'https://login.microsoftonline.com/common/v2.0' }], /name your Entra tenant/);
  bad([{ ...one, issuer: 'http://idp.example.com' }], /https:\/\//);
  bad([{ ...one, autoCreate: true, allowedDomains: [] }], /autoCreate" needs allowedDomains/);
  bad([one, { ...one }], /two providers have the id "entra"/);
  bad([{ ...one, id: 'no spaces' }], /lower-case letters/);
  bad([{ ...one, passwords: 'no' }], /passwords" must be true or false/);
  bad([{ ...one, allowedDomains: 'example.com' }], /list of domains/);
  bad([{ ...one, tenant: 'x' }], /unknown setting "sso.providers\[0\].tenant"/);
  bad([{ ...one, maxAgeHours: 1.5 }], /maxAgeHours" must be a whole number of hours, 0-720/);
  bad([{ ...one, maxAgeHours: 721 }], /maxAgeHours" must be a whole number/);
  bad([{ ...one, clientId: '' }], /clientId" must be text \(required\)/);
  write({ sso: { list: [] } });
  assert.throws(() => dk.loadConfig({ file, env: {}, args: [] }), /unknown setting "sso.list"/);
}));

test('single sign-on flow: state, browser binding, PKCE and nonce are checked against a real token exchange', async () => {
  const sso = new dk.SsoFlows();
  const idp = await mockProvider();
  try {
    const p = provider({ issuer: idp.issuer });
    const redirectUri = 'https://gate.example.com/api/sso/work/callback';
    const start = await dk.startSso(sso, p, { mode: 'signin', redirectUri });
    const q = new URL(start.url).searchParams;
    assert.strictEqual(new URL(start.url).origin + new URL(start.url).pathname, `${idp.issuer}/authorize`);
    assert.deepStrictEqual(['client_id', 'redirect_uri', 'scope', 'response_type', 'code_challenge_method', 'prompt'].map((k) => q.get(k)),
      ['app-id', redirectUri, 'openid email profile', 'code', 'S256', 'select_account']);
    assert.ok(q.get('state') && q.get('nonce') && q.get('code_challenge'));
    assert.strictEqual(q.get('max_age'), null); // no session-age limit by default
    const answer = idp.authorize(start.url, { sub: 'u-1', email: 'Jane@Example.com', email_verified: true, name: 'Jane' });
    await assert.rejects(dk.finishSso(sso, p, answer, 'another-browser'), (e) => e.status === 400 && /another browser/.test(e.message));
    await assert.rejects(dk.finishSso(sso, p, answer, start.binding), /expired or was already used/); // the attempt is used up either way

    const s2 = await dk.startSso(sso, p, { mode: 'invite', redirectUri, inviteToken: 'tok' });
    const r = await dk.finishSso(sso, p, idp.authorize(s2.url, { sub: 'u-1', email: 'Jane@Example.com', email_verified: true, name: 'Jane' }), s2.binding);
    assert.deepStrictEqual(r, { mode: 'invite', username: undefined, inviteToken: 'tok', strong: false,
      identity: { subject: 'u-1', email: 'jane@example.com', emailVerified: true, name: 'Jane', hd: '',
        auth: { amr: [], acr: '', authTime: null }, groups: [] } });

    const s3 = await dk.startSso(sso, p, { mode: 'signin', redirectUri });
    await assert.rejects(dk.finishSso(sso, p, idp.authorize(s3.url, { sub: 'u-1' }, { nonce: 'forged' }), s3.binding), (e) => /nonce/.test(e.cause.message));
    const s4 = await dk.startSso(sso, p, { mode: 'signin', redirectUri });
    const denied = new URLSearchParams({ error: 'access_denied', error_description: 'User cancelled', state: new URL(s4.url).searchParams.get('state') });
    await assert.rejects(dk.finishSso(sso, p, denied, s4.binding), /Work didn't sign you in: User cancelled/);
    // An issuer without a path (as Google's) is discovered too.
    const bare = await mockProvider('');
    try {
      const s5 = await dk.startSso(sso, provider({ id: 'bare', issuer: bare.issuer }), { mode: 'signin', redirectUri });
      assert.strictEqual((await dk.finishSso(sso, provider({ id: 'bare', issuer: bare.issuer }), bare.authorize(s5.url, { sub: 'b-1' }), s5.binding)).identity.subject, 'b-1');
    } finally { bare.close(); }
  } finally { idp.close(); }
});

test('single sign-on session age: maxAgeHours bounds auth_time; linking needs a fresh sign-in', async () => {
  const sso = new dk.SsoFlows();
  const idp = await mockProvider();
  try {
    const p = provider({ issuer: idp.issuer, maxAgeHours: 12 });
    const redirectUri = 'https://gate.example.com/api/sso/work/callback';
    const now = Math.floor(Date.now() / 1000);
    const attempt = async (claims, mode = 'signin') => {
      const s = await dk.startSso(sso, p, { mode, redirectUri, username: mode === 'link' ? 'jane' : undefined });
      return [new URL(s.url).searchParams, dk.finishSso(sso, p, idp.authorize(s.url, { sub: 'u-1', ...claims }), s.binding)];
    };
    const [q, ok] = await attempt({ auth_time: now - 11 * 3600 });
    assert.strictEqual(q.get('max_age'), String(12 * 3600));
    assert.strictEqual((await ok).identity.subject, 'u-1');
    await assert.rejects((await attempt({ auth_time: now - 13 * 3600 }))[1], /more than 12 hours old/);
    await assert.rejects((await attempt({}))[1], /didn't say when you signed in \(auth_time\)/);
    // Linking asks for a fresh sign-in and refuses one made before the attempt.
    const [lq, linked] = await attempt({ auth_time: now }, 'link');
    assert.strictEqual(lq.get('max_age'), '0');
    assert.strictEqual((await linked).mode, 'link');
    await assert.rejects((await attempt({ auth_time: now - 3600 }, 'link'))[1], /linking needs a fresh sign-in/);
    // Without maxAgeHours, sign-ins don't need auth_time, but linking still does.
    const free = provider({ issuer: idp.issuer });
    const s = await dk.startSso(sso, free, { mode: 'link', redirectUri, username: 'jane' });
    await assert.rejects(dk.finishSso(sso, free, idp.authorize(s.url, { sub: 'u-1' }), s.binding), /auth_time/);
  } finally { idp.close(); }
});

test('single sign-on accounts: linked, matched by a trusted email, invitations, new accounts, and refusals', withStore(async (store) => {
  const p = provider();
  await assert.rejects(dk.completeSso(store, p, ssoResult({ sub: 'j', email: 'jane@example.com' })), (e) => e.status === 403 && /no account for jane@example.com/.test(e.message));
  await dk.createUser(store, { username: 'jane', ['pass' + 'word']: PW, email: 'jane@example.com', createdBy: 't', mustChangePassword: false });
  await dk.confirmEmail(store, 'jane', 'jane@example.com');
  assert.deepStrictEqual(await dk.completeSso(store, p, ssoResult({ sub: 'j', email: 'jane@example.com' })), { username: 'jane', outcome: 'linked' });
  assert.deepStrictEqual(await dk.completeSso(store, p, ssoResult({ sub: 'j', email: 'renamed@other.com' })), { username: 'jane', outcome: 'signed-in' });
  const ids = await dk.listIdentities(store, 'jane', [p]);
  assert.deepStrictEqual(ids.map((i) => [i.provider, i.providerName, i.subject, i.email, Boolean(i.lastUsedAt)]), [['work', 'Work', 'j', 'renamed@other.com', true]]);
  assert.strictEqual((await dk.getUser(store, 'jane')).signIns, 2);
  // Untrusted emails: another domain, marked unverified, or (Google) not from the Workspace.
  await assert.rejects(dk.completeSso(store, p, ssoResult({ sub: 'x', email: 'x@other.com' })), /only accounts from example.com/);
  await assert.rejects(dk.completeSso(store, p, ssoResult({ sub: 'x', email: 'jane@example.com', email_verified: false })), /isn't verified/);
  await assert.rejects(dk.completeSso(store, p, ssoResult({ sub: 'x' })), /didn't give an email address/);
  const google = provider({ id: 'google', name: 'Google', issuer: 'https://accounts.google.com' });
  await assert.rejects(dk.completeSso(store, google, ssoResult({ sub: 'g', email: 'jane@example.com' })), /isn't a example.com Google Workspace account/);
  assert.strictEqual((await dk.completeSso(store, google, ssoResult({ sub: 'g', email: 'jane@example.com', hd: 'example.com' }))).username, 'jane');
  // Without allowedDomains nobody is matched by email.
  await assert.rejects(dk.completeSso(store, provider({ id: 'any', allowedDomains: [] }), ssoResult({ sub: 'a', email: 'jane@example.com' })), /no account linked/);
  // An invitation waiting on the email is accepted: no password, email confirmed.
  await dk.createUser(store, { username: 'bob', email: 'bob@example.com', createdBy: 'jane', invite: true });
  assert.deepStrictEqual(await dk.completeSso(store, p, ssoResult({ sub: 'b', email: 'bob@example.com' })), { username: 'bob', outcome: 'invite-accepted' });
  const bob = await dk.getUser(store, 'bob');
  assert.deepStrictEqual([bob.invited, bob.hasPassword, bob.email], [false, false, 'bob@example.com']);
  assert.strictEqual(await dk.authenticate(store, 'bob', '!sso'), null);
  // New accounts only with autoCreate: username from the address, no password.
  const auto = provider({ id: 'auto', autoCreate: true });
  assert.deepStrictEqual(await dk.completeSso(store, auto, ssoResult({ sub: 'c1', email: 'Carol.Smith+gate@example.com' })), { username: 'carol.smith.gate', outcome: 'created' });
  await store.db.query("UPDATE users SET email = NULL WHERE username = 'carol.smith.gate'");
  assert.strictEqual((await dk.completeSso(store, auto, ssoResult({ sub: 'c2', email: 'carol.smith+gate@example.com' }))).username, 'carol.smith.gate-2');
  assert.strictEqual((await dk.completeSso(store, auto, ssoResult({ sub: 'c3', email: 'q@example.com' }))).username, 'q00');
  const carol = await dk.getUser(store, 'carol.smith.gate-2');
  assert.deepStrictEqual([carol.hasPassword, carol.invited, carol.createdBy, carol.email], [false, false, 'sso:auto', 'carol.smith+gate@example.com']);
  // Linking from User Settings: any email for providers without domains; never another account's identity.
  assert.deepStrictEqual(await dk.completeSso(store, provider({ id: 'any', allowedDomains: [] }), ssoResult({ sub: 'a', email: 'me@gmail.com' }, { mode: 'link', username: 'bob' })),
    { username: 'bob', outcome: 'linked' });
  await assert.rejects(dk.completeSso(store, p, ssoResult({ sub: 'j', email: 'jane@example.com' }, { mode: 'link', username: 'bob' })), (e) => e.status === 409);
  await assert.rejects(dk.completeSso(store, p, ssoResult({ sub: 'z', email: 'z@other.com' }, { mode: 'link', username: 'bob' })), /only accounts from example.com can/);
}));

test('single sign-on invitations by link, password rules and unlinking', withStore(async (store) => {
  const p = provider({ passwords: false });
  await dk.createUser(store, { username: 'dee', email: 'dee@example.com', createdBy: 't', invite: true });
  const token = await dk.createToken(store, 'invite', 'dee');
  // A refused attempt doesn't use up the invitation.
  await assert.rejects(dk.completeSso(store, p, ssoResult({ sub: 'd', email: 'dee@other.com' }, { mode: 'invite', inviteToken: token })), /only accounts from example.com can/);
  assert.deepStrictEqual(await dk.completeSso(store, p, ssoResult({ sub: 'd', email: 'dee@example.com' }, { mode: 'invite', inviteToken: token })),
    { username: 'dee', outcome: 'invite-accepted' });
  await assert.rejects(dk.completeSso(store, p, ssoResult({ sub: 'd2', email: 'dee@example.com' }, { mode: 'invite', inviteToken: token })), /invalid, used or expired/);
  // Two invitations accepted at once with the same provider account: one is linked; the other invitation stays unused.
  const invite = async (username) => {
    await dk.createUser(store, { username, email: `${username}@example.com`, createdBy: 't', invite: true });
    return dk.createToken(store, 'invite', username);
  };
  const [fay, gus] = [await invite('fay'), await invite('gus')];
  const both = await Promise.allSettled([fay, gus].map((inviteToken) =>
    dk.completeSso(store, p, ssoResult({ sub: 'same', email: 'fay@example.com' }, { mode: 'invite', inviteToken }))));
  assert.deepStrictEqual(both.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
  const loser = both[0].status === 'rejected' ? 'fay' : 'gus';
  assert.strictEqual((await dk.getUser(store, loser)).invited, true, 'still invited');
  assert.ok(await dk.peekToken(store, 'invite', loser === 'fay' ? fay : gus), 'its invitation still works');
  // A provider with passwords: false keeps its accounts from password sign-in.
  await dk.createUser(store, { username: 'eve', ['pass' + 'word']: PW, createdBy: 't', mustChangePassword: false });
  assert.deepStrictEqual(await dk.passwordBlockers(store, 'eve', [p]), []);
  await dk.completeSso(store, p, ssoResult({ sub: 'e', email: 'eve@example.com' }, { mode: 'link', username: 'eve' }));
  assert.deepStrictEqual(await dk.passwordBlockers(store, 'eve', [p]), ['Work']);
  const refuse = async (u) => ((await dk.passwordBlockers(store, u, [p])).length ? 'use Work' : null);
  assert.strictEqual(await dk.authenticate(store, 'eve', PW, refuse), null); // refused like a wrong password, so it can't confirm an old one
  assert.strictEqual((await dk.getUser(store, 'eve')).signIns, 0);
  // Unlinking keeps a way to sign in: dee (no password) can't drop her only sign-in; eve's password works again once unlinked.
  await assert.rejects(dk.unlinkIdentity(store, 'dee', { provider: 'work', subject: 'd' }, [p]), (e) => e.status === 409 && /only way to sign in/.test(e.message));
  await dk.unlinkIdentity(store, 'eve', { provider: 'work', subject: 'e' }, [p]);
  assert.deepStrictEqual(await dk.passwordBlockers(store, 'eve', [p]), []);
  await assert.rejects(dk.unlinkIdentity(store, 'eve', { provider: 'work', subject: 'e' }, [p]), (e) => e.status === 404);
  // dee (no password) with one passkey: it can't go while it is her only way in, once Work is no longer configured.
  await store.db.query("INSERT INTO passkeys (id, username, rp_id, name, public_key, counter, device_type, backed_up, created_at) VALUES ('k1', 'dee', 'localhost', 'Phone', '\\x00', 0, 'singleDevice', false, now())");
  assert.strictEqual(await dk.signInLeftWithoutPasskey(store, 'dee', 'k1', [p]), true, 'Work is still linked');
  assert.strictEqual(await dk.signInLeftWithoutPasskey(store, 'dee', 'k1', []), false);
  assert.strictEqual(await dk.signInLeftWithoutPasskey(store, 'eve', 'none', []), true, 'eve has a password');
  const other = provider({ id: 'other', name: 'Other', allowedDomains: [] });
  await dk.completeSso(store, other, ssoResult({ sub: 'd3', email: 'dee@home.net' }, { mode: 'link', username: 'dee' }));
  await dk.unlinkIdentity(store, 'dee', { provider: 'work', subject: 'd' }, [p, other]);
  assert.deepStrictEqual((await dk.listIdentities(store, 'dee', [p, other])).map((i) => i.providerName), ['Other']);
}));

test('web push: auto-generated VAPID keys, subscription validation, delivery and 410 pruning', withStore(async (store) => {
  await dk.createUser(store, { username: 'alice', ['pass' + 'word']: PW, createdBy: 't', mustChangePassword: false });
  const v1 = await dk.ensureVapidKeys(store, {});
  const v2 = await dk.ensureVapidKeys(store, {});
  assert.strictEqual(v1.publicKey, v2.publicKey, 'reuses stored VAPID keypair');
  assert.strictEqual(v1.privateKey, v2.privateKey);
  const explicit = await dk.ensureVapidKeys(store, { vapidPublicKey: 'pub-explicit', vapidPrivateKey: 'priv-explicit', subject: 'mailto:ops@example.com' });
  assert.deepStrictEqual(explicit, { publicKey: 'pub-explicit', privateKey: 'priv-explicit', subject: 'mailto:ops@example.com' });

  await assert.rejects(dk.savePushSubscription(store, 'alice', { endpoint: 'http://insecure.test/p', keys: { p256dh: 'A'.repeat(40), auth: 'B'.repeat(20) } }), /https/);
  const sub1 = await dk.savePushSubscription(store, 'alice', { endpoint: 'https://push.example.com/ok', keys: { p256dh: 'A'.repeat(40), auth: 'B'.repeat(20) }, label: 'iPhone' });
  const sub2 = await dk.savePushSubscription(store, 'alice', { endpoint: 'https://push.example.com/gone', keys: { p256dh: 'C'.repeat(40), auth: 'D'.repeat(20) }, label: 'Old Chrome' });
  assert.strictEqual((await dk.listPushSubscriptions(store, 'alice')).length, 2);

  const delivered = [];
  const res = await dk.sendPushToUsers(store, v1, ['alice'], { title: 'Gate alert', body: 'Send failed' }, {
    sendFn: async (sub, data) => {
      if (sub.endpoint.endsWith('/gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
      delivered.push({ endpoint: sub.endpoint, payload: JSON.parse(data) });
    },
  });
  assert.deepStrictEqual(res, { sent: 1, failed: 0, removed: 1 });
  assert.strictEqual(delivered.length, 1);
  assert.strictEqual(delivered[0].payload.title, 'Gate alert');
  assert.deepStrictEqual((await dk.listPushSubscriptions(store, 'alice')).map((s) => s.id), [sub1.id]);
  assert.strictEqual(await dk.deletePushSubscription(store, 'alice', sub1.id), true);
  assert.strictEqual((await dk.listPushSubscriptions(store, 'alice')).length, 0);
  assert.ok(sub2.id);
}));

test('single sign-on enhancements: strong MFA step-up detection, group role mapping, SSO badge, and per-gate requireStrongAdmin', withServer(async ({ store, call }) => {
  const now = Date.now();
  const nowSec = Math.floor(now / 1000);
  const p = provider({
    strongAcrs: ['urn:mace:incommon:iap:silver'],
    roleMap: { claim: 'groups', map: { 'gate-admins': { [GATE_A.phoneNumber]: 'admin' }, 'gate-editors': { '*': 'editor' } } },
  });
  assert.strictEqual(dk.isStrongSso(p, { amr: ['pwd', 'mfa'], acr: '', authTime: nowSec - 60 }, now), true);
  assert.strictEqual(dk.isStrongSso(p, { amr: ['hwk'], acr: '', authTime: nowSec - 60 }, now), true);
  assert.strictEqual(dk.isStrongSso(p, { amr: ['pwd'], acr: 'urn:mace:incommon:iap:silver', authTime: nowSec - 60 }, now), true);
  assert.strictEqual(dk.isStrongSso(p, { amr: ['pwd'], acr: '', authTime: nowSec - 60 }, now), false, 'password-only is not strong');
  assert.strictEqual(dk.isStrongSso(p, { amr: ['mfa'], acr: '', authTime: null }, now), false, 'missing auth_time is not strong');
  assert.strictEqual(dk.isStrongSso(p, { amr: ['mfa'], acr: '', authTime: nowSec - 4 * 3600 }, now), false, 'stale auth_time is not strong');

  await dk.createUser(store, { username: 'owner', ['pass' + 'word']: PW, email: 'owner@example.com', createdBy: 't', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'owner');
  await dk.createUser(store, { username: 'ssoadmin', ['pass' + 'word']: PW, email: 'ssoadmin@example.com', createdBy: 't', mustChangePassword: false });
  await dk.confirmEmail(store, 'ssoadmin', 'ssoadmin@example.com');
  const claims = dk.claimsOf({ sub: 's-1', email: 'ssoadmin@example.com', email_verified: true, amr: ['pwd', 'mfa'], auth_time: nowSec, groups: ['gate-admins'] }, 'groups');
  await dk.completeSso(store, p, { mode: 'signin', identity: claims, strong: true });
  assert.strictEqual(await dk.accessOf(store, GATE_A.phoneNumber, 'ssoadmin'), 'admin', 'roleMap granted admin access');
  const users = await dk.gateUsers(store, GATE_A.phoneNumber);
  assert.deepStrictEqual(users.find((u) => u.username === 'ssoadmin')?.ssoProviders, ['work']);

  const cookie = await signIn(call, 'owner', PW);
  // Push routes
  const pushGet = await call('GET', '/api/me/push', { cookie });
  assert.strictEqual(pushGet.status, 200);
  assert.ok(pushGet.body.publicKey.length > 20);
  const pushSave = await call('POST', '/api/me/push', {
    cookie,
    body: { endpoint: 'https://push.example.com/device1', keys: { p256dh: 'E'.repeat(40), auth: 'F'.repeat(20) }, label: 'Test Phone' },
  });
  assert.strictEqual(pushSave.status, 200);
  assert.strictEqual(pushSave.body.subscriptions.length, 1);
  const pushDel = await call('DELETE', `/api/me/push/${pushSave.body.subscriptions[0].id}`, { cookie });
  assert.strictEqual(pushDel.status, 200);
  assert.strictEqual(pushDel.body.subscriptions.length, 0);

  // Per-gate requireStrongAdmin: turn on, then non-strong session is refused on gate-admin routes!
  const enable = await call('PUT', `/api/gates/${GATE_A.phoneNumber}/prefs`, { cookie, body: { requireStrongAdmin: true } });
  assert.strictEqual(enable.status, 200);
  assert.strictEqual(enable.body.requireStrongAdmin, true);
  const refused = await call('PUT', `/api/gates/${GATE_A.phoneNumber}/prefs`, { cookie, body: { relayLabels: { '0': 'Front' } } });
  assert.strictEqual(refused.status, 403);
  assert.strictEqual(refused.body.stepUp, true);
  // With a strong session (e.g. passkey or MFA SSO), the same admin route succeeds.
  const strongSid = await dk.createSession(store, 'owner', { strong: true });
  const allowed = await call('PUT', `/api/gates/${GATE_A.phoneNumber}/prefs`, { cookie: `sid=${strongSid}`, body: { relayLabels: { '0': 'Front' } } });
  assert.strictEqual(allowed.status, 200);
  assert.strictEqual(allowed.body.relayLabels['0'], 'Front');
}));

test('safe entry code generator, welcome message, and filled ResidentInstructions.pdf download', withServer(async ({ app, store, call }) => {
  // Weak-code filter & collision avoidance
  for (const bad of ['0000', '1111', '1234', '4321', '1212', '1122', '1221', '2026', '2580']) {
    assert.strictEqual(dk.isWeakEntryCode(bad), true, `${bad} should be rejected`);
  }
  const taken = ['4827', '7391'];
  for (let i = 0; i < 20; i++) {
    const code = dk.generateSafeEntryCode(taken);
    assert.match(code, /^\d{4}$/);
    assert.strictEqual(dk.isWeakEntryCode(code), false);
    assert.ok(!taken.includes(code));
  }
  // Welcome message formatting
  const msg = dk.buildWelcomeMessage({
    siteName: 'Oakridge Estates', residentName: 'Smith, Jane', directoryCode: '101', entryCode: '4827',
    grantAccessDigit: '9', adminPhone: '2145550199', hidden: false, cards: ['504'],
  });
  assert.match(msg, /Oakridge Estates/);
  assert.match(msg, /Directory Code: 101/);
  assert.match(msg, /#4827/);
  assert.match(msg, /Press 9 to open/);
  assert.match(msg, /\(214\) 555-0199/);
  assert.match(msg, /504/);

  // Filled ResidentInstructions.pdf bytes & HTTP route
  await dk.createUser(store, { username: 'alice', ['pass' + 'word']: PW, createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'alice');
  await pullInto(store);
  await dk.ensureCache(store, GATE_A.phoneNumber);
  const cookie = await signIn(call, 'alice', PW);

  const resList = await call('GET', `/api/gates/${GATE_A.phoneNumber}/residents`, { cookie });
  assert.strictEqual(resList.status, 200);
  assert.ok(resList.body.grantAccessDigit, 'residents reply exposes grantAccessDigit');

  const pdfRes = await fetch(`http://127.0.0.1:${app.port()}/api/gates/${GATE_A.phoneNumber}/residents/instructions.pdf`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      residentName: 'Smith, Jane', directoryCode: '101', entryCode: '4827', adminPhone: '2145550199', saveAdminPhone: true,
    }),
  });
  assert.strictEqual(pdfRes.status, 200);
  assert.strictEqual(pdfRes.headers.get('content-type'), 'application/pdf');
  assert.match(pdfRes.headers.get('content-disposition') || '', /ResidentInstructions-101-Smith_Jane\.pdf/);
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  assert.strictEqual(buf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.ok(buf.length > 20000);
  assert.strictEqual((await dk.getPrefs(store, GATE_A.phoneNumber)).adminPhone, '2145550199');
}));

test('resident portal lifecycle: email binding across gates, turnover wipe (passkeys/sessions/password), and SSO block', withStore(async (store) => {
  const GATE_B = { ...GATE_A, phoneNumber: '5550101' };
  await dk.createUser(store, { username: 'admin', ['pass' + 'word']: PW, email: 'admin@example.com', createdBy: 't', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'admin');
  await dk.registerGate(store, GATE_B, 'admin');

  // 1. Enabling portal on Gate A with a brand-new email creates an invited resident account.
  const first = await dk.syncResidentPortal(store, { phone: GATE_A.phoneNumber, code: '101', email: 'jane@unit.test', enabled: true, actor: 'admin' });
  assert.strictEqual(first.action, 'invited');
  assert.ok(first.inviteUsername);
  const resUser = first.inviteUsername;
  assert.strictEqual(await dk.accessOf(store, GATE_A.phoneNumber, resUser), 'resident');
  assert.strictEqual(await dk.isResidentOnlyUser(store, resUser), true);

  // Resident accepts invite, gets a passkey, push subscription, and session.
  await dk.acceptInvite(store, resUser, PW);
  assert.strictEqual((await dk.authenticate(store, 'jane@unit.test', PW))?.username, resUser, 'resident signs in with email');
  await dk.createSession(store, resUser);
  await store.db.query("INSERT INTO passkeys (id, username, rp_id, name, public_key, counter, device_type, backed_up, created_at) VALUES ('rp-k1', $1, 'localhost', 'iPhone', '\\x00', 0, 'singleDevice', false, now())", [resUser]);
  await dk.savePushSubscription(store, resUser, { endpoint: 'https://push.example.com/res1', keys: { p256dh: 'A'.repeat(40), auth: 'B'.repeat(20) }, label: 'iPhone' });

  // SSO is blocked for resident-only accounts.
  const ssoProv = provider({ allowedDomains: ['unit.test'] });
  await assert.rejects(dk.completeSso(store, ssoProv, ssoResult({ sub: 'j-sso', email: 'jane@unit.test' })), (e) => e.status === 403 && /Resident Portal/.test(e.message));

  // 2. Enabling portal on Gate B with the SAME email binds directly to the existing user (no re-signup).
  const bound = await dk.syncResidentPortal(store, { phone: GATE_B.phoneNumber, code: '205', email: 'jane@unit.test', enabled: true, actor: 'admin' });
  assert.strictEqual(bound.action, 'bound');
  assert.strictEqual(bound.boundUsername, resUser);
  assert.strictEqual(await dk.accessOf(store, GATE_B.phoneNumber, resUser), 'resident');

  // 3. Disabling Gate A keeps Jane's account & passkey intact because she still has Gate B.
  const disableA = await dk.syncResidentPortal(store, { phone: GATE_A.phoneNumber, code: '101', enabled: false, actor: 'admin' });
  assert.strictEqual(disableA.action, 'revoked');
  assert.strictEqual(disableA.wipedPrevious, false);
  assert.strictEqual(await dk.accessOf(store, GATE_A.phoneNumber, resUser), null);
  assert.ok(await dk.getUser(store, resUser), 'account survives while Gate B access remains');

  // 4. Removing email on Gate B automatically turns off portal access AND wipes user, passkeys, sessions, push subs!
  const clearB = await dk.syncResidentPortal(store, { phone: GATE_B.phoneNumber, code: '205', email: '', enabled: true, actor: 'admin' });
  assert.strictEqual(clearB.wipedPrevious, true);
  assert.strictEqual(await dk.getUser(store, resUser), null, 'user completely wiped');
  assert.strictEqual((await dk.listPasskeys(store, resUser)).length, 0, 'passkeys wiped');
  assert.strictEqual((await dk.listPushSubscriptions(store, resUser)).length, 0, 'push subscriptions wiped');

  // 5. Replacing email while enabled wipes old resident and invites the new email from scratch.
  const bob = await dk.syncResidentPortal(store, { phone: GATE_A.phoneNumber, code: '101', email: 'bob@unit.test', enabled: true, actor: 'admin' });
  const replaced = await dk.syncResidentPortal(store, { phone: GATE_A.phoneNumber, code: '101', email: 'carol@unit.test', enabled: true, actor: 'admin' });
  assert.strictEqual(replaced.action, 'replaced');
  assert.strictEqual(replaced.wipedPrevious, true);
  assert.strictEqual(await dk.getUser(store, bob.inviteUsername), null, 'previous resident wiped');
  assert.ok(replaced.inviteUsername && await dk.getUser(store, replaced.inviteUsername), 'new resident invited');
}));

test('resident portal E2E: strict isolation, Buzz Me In Portal Open (tx_history safe), reroll cap + schedule ETA, suspicious report, change request, and login audit', withServer(async ({ store, call, dks }) => {
  await dk.createUser(store, { username: 'admin', ['pass' + 'word']: PW, email: 'admin@example.com', createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'admin');
  await pullInto(store);
  await dk.ensureCache(store, GATE_A.phoneNumber);
  const adminCookie = await signIn(call, 'admin', PW);

  // Enable Resident Portal + Buzz Me In (2s pulse, max 1 reroll/day) + schedule a daily Send.
  const prefsRes = await call('PUT', `/api/gates/${GATE_A.phoneNumber}/prefs`, {
    cookie: adminCookie,
    body: {
      residentPortal: { enabled: true, buzzEnabled: true, buzzRelays: [0], pulseSeconds: 2, maxRerollsPerDay: 1, autoSendReroll: false, allowRequests: true },
    },
  });
  assert.strictEqual(prefsRes.status, 200);
  await dk.saveSchedule(store, GATE_A.phoneNumber, 'admin', { days: [0, 1, 2, 3, 4, 5, 6], time: '02:00', actions: ['send'], enabled: true });

  // Enable portal for unit 101 via PUT /residents/101.
  const editRes = await call('PUT', `/api/gates/${GATE_A.phoneNumber}/residents/101`, {
    cookie: adminCookie,
    body: { email: 'smith@unit.test', portalEnabled: true },
  });
  assert.strictEqual(editRes.status, 200);
  const resUsername = editRes.body.portal.inviteUsername;
  assert.ok(resUsername);
  await dk.acceptInvite(store, resUsername, PW);

  // Resident signs in using their EMAIL (plus one intentional wrong password for login audit).
  assert.strictEqual((await call('POST', '/api/session', { body: { user: 'smith@unit.test', ['pass' + 'word']: 'WrongPassword123!' } })).status, 401);
  const resSignIn = await call('POST', '/api/session', { body: { user: 'smith@unit.test', ['pass' + 'word']: PW } });
  assert.strictEqual(resSignIn.status, 200);
  const resCookie = resSignIn.cookie;

  // Strict route isolation: resident CANNOT hit any staff gate routes or SSO.
  for (const forbidden of [
    ['GET', `/api/gates/${GATE_A.phoneNumber}/residents`],
    ['GET', `/api/gates/${GATE_A.phoneNumber}/data`],
    ['GET', `/api/gates/${GATE_A.phoneNumber}/relays`],
    ['GET', `/api/gates/${GATE_A.phoneNumber}/login-audit`],
    ['GET', `/api/gates/${GATE_A.phoneNumber}/users`],
  ]) {
    assert.strictEqual((await call(forbidden[0], forbidden[1], { cookie: resCookie })).status, 403, `resident blocked from ${forbidden[1]}`);
  }

  // Portal /me and /status work cleanly.
  const me = await call('GET', `/api/portal/gates/${GATE_A.phoneNumber}/me`, { cookie: resCookie });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.unit.directoryCode, '101');
  assert.ok(me.body.reroll.nextScheduledSend, 'includes next scheduled send ETA');
  const st = await call('GET', `/api/portal/gates/${GATE_A.phoneNumber}/status`, { cookie: resCookie });
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.body.available, true);

  // Buzz Me In pulses relay 0 ('1' then '0') and records a Portal Open event visible in portal + admin transactions
  // without inserting anything into tx_history!
  const buzz = await call('POST', `/api/portal/gates/${GATE_A.phoneNumber}/buzz`, { cookie: resCookie, body: { relay: 0 } });
  assert.strictEqual(buzz.status, 200);
  assert.strictEqual(buzz.body.ok, true);
  assert.ok(dks.setRelaysCalls.length >= 2, 'pulsed on then off');
  const txHistoryCount = (await store.db.query('SELECT COUNT(*)::int AS c FROM tx_history WHERE phone = $1', [GATE_A.phoneNumber])).rows[0].c;
  assert.strictEqual(txHistoryCount, 0, 'tx_history stays pure hardware truth');

  const act = await call('GET', `/api/portal/gates/${GATE_A.phoneNumber}/activity`, { cookie: resCookie });
  assert.strictEqual(act.status, 200);
  assert.strictEqual(act.body.rows.length, 1);
  assert.strictEqual(act.body.rows[0].eventType, 'Portal Open');
  assert.strictEqual(act.body.rows[0].source, 'portal');

  const adminData = await call('GET', `/api/gates/${GATE_A.phoneNumber}/data`, { cookie: adminCookie });
  assert.strictEqual(adminData.status, 200);
  assert.ok(adminData.body.transactions.rows.some((r) => r.eventType === 'Portal Open'), 'Portal Open merged into admin Transactions');

  // Report as suspicious -> admin sees and resolves it.
  const rep = await call('POST', `/api/portal/gates/${GATE_A.phoneNumber}/activity/report`, {
    cookie: resCookie,
    body: { txSource: 'portal', txKey: act.body.rows[0].txKey, note: 'Not me!' },
  });
  assert.strictEqual(rep.status, 201);
  const adminReps = await call('GET', `/api/gates/${GATE_A.phoneNumber}/suspicious-reports`, { cookie: adminCookie });
  assert.strictEqual(adminReps.body.reports.length, 1);
  assert.strictEqual((await call('POST', `/api/gates/${GATE_A.phoneNumber}/suspicious-reports/${adminReps.body.reports[0].id}/resolve`, { cookie: adminCookie, body: { reviewNote: 'Checked camera' } })).status, 200);

  // Reroll gate code: 1st succeeds with scheduled send ETA; 2nd within 24h returns 429.
  const reroll1 = await call('POST', `/api/portal/gates/${GATE_A.phoneNumber}/reroll-code`, { cookie: resCookie, body: {} });
  assert.strictEqual(reroll1.status, 200);
  assert.match(reroll1.body.entryCode, /^\d{4}$/);
  assert.strictEqual(reroll1.body.remainingToday, 0);
  assert.ok(reroll1.body.nextScheduledSend);
  const reroll2 = await call('POST', `/api/portal/gates/${GATE_A.phoneNumber}/reroll-code`, { cookie: resCookie, body: {} });
  assert.strictEqual(reroll2.status, 429);

  // Self-service phone change request -> admin approves & applies to working copy.
  const reqPost = await call('POST', `/api/portal/gates/${GATE_A.phoneNumber}/requests`, {
    cookie: resCookie,
    body: { kind: 'phone', payload: { phone: '2145550177' }, note: 'New cell' },
  });
  assert.strictEqual(reqPost.status, 201);
  const rev = await call('POST', `/api/gates/${GATE_A.phoneNumber}/resident-requests/${reqPost.body.request.id}/review`, {
    cookie: adminCookie, body: { decision: 'approved', apply: true },
  });
  assert.strictEqual(rev.status, 200);
  const updated101 = await call('GET', `/api/gates/${GATE_A.phoneNumber}/residents/101`, { cookie: adminCookie });
  assert.strictEqual(updated101.body.phone, '555-0177');

  // Account phone self-service: GET /api/me falls back to unit's call-box phone, and PUT /api/me syncs directly to the unit.
  const meBefore = await call('GET', '/api/me', { cookie: resCookie });
  assert.strictEqual(meBefore.status, 200);
  assert.strictEqual(meBefore.body.phone, '+12145550177');
  const mePhonePut = await call('PUT', '/api/me', { cookie: resCookie, body: { phone: '(469) 555-0199' } });
  assert.strictEqual(mePhonePut.status, 200);
  assert.strictEqual(mePhonePut.body.phone, '+14695550199');
  assert.deepStrictEqual(mePhonePut.body.gatePhoneSync?.updatedUnits, ['101']);
  const updated101Self = await call('GET', `/api/gates/${GATE_A.phoneNumber}/residents/101`, { cookie: adminCookie });
  assert.strictEqual(updated101Self.body.areaCode, '469');
  assert.strictEqual(updated101Self.body.phone, '555-0199');

  // Login audit log records both failed and successful sign-ins for admin review.
  const auditAll = await call('GET', `/api/gates/${GATE_A.phoneNumber}/login-audit`, { cookie: adminCookie });
  assert.strictEqual(auditAll.status, 200);
  assert.ok(auditAll.body.entries.some((e) => e.username === resUsername && e.outcome === 'failed'));
  assert.ok(auditAll.body.entries.some((e) => e.username === resUsername && e.outcome === 'success'));
}));

test('android native sessions: Bearer dks_ works across webOnly routes, enforces step-up, revokes on sign-out, and assetlinks/config validate', withServer(async ({ store, call, config }) => {
  await dk.createUser(store, { username: 'alice', password: 'correct-horse-battery', createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'alice');

  // Browser sign-in (without X-Client-Auth: bearer) omits sessionToken.
  const webLogin = await call('POST', '/api/session', { body: { user: 'alice', password: 'correct-horse-battery' } });
  assert.strictEqual(webLogin.status, 200);
  assert.strictEqual(webLogin.body.sessionToken, undefined);

  // Native sign-in (X-Client-Auth: bearer) returns dks_<64-hex> sessionToken.
  const nativeLogin = await call('POST', '/api/session', {
    body: { user: 'alice', password: 'correct-horse-battery' },
    headers: { 'X-Client-Auth': 'bearer' },
  });
  assert.strictEqual(nativeLogin.status, 200);
  assert.match(nativeLogin.body.sessionToken, /^dks_[a-f0-9]{64}$/);
  const tok = nativeLogin.body.sessionToken;

  // Bearer dks_ authenticates user-scoped and webOnly routes (unlike per-gate dkg_ API keys).
  const me = await call('GET', '/api/session', { key: tok });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.loggedIn, true);
  assert.strictEqual(me.body.user, 'alice');

  const gates = await call('GET', '/api/gates', { key: tok });
  assert.strictEqual(gates.status, 200);
  assert.strictEqual(gates.body.gates.length, 1);

  const users = await call('GET', `/api/gates/${GATE_A.phoneNumber}/users`, { key: tok });
  assert.strictEqual(users.status, 200, 'webOnly gate-admin route accessible to native user session');

  // Step-up routes still enforce passkey confirmation for native user sessions.
  const keyCreate = await call('POST', `/api/gates/${GATE_A.phoneNumber}/api-keys`, {
    key: tok,
    body: { name: 'CI', role: 'readonly' },
  });
  assert.strictEqual(keyCreate.status, 403);
  assert.strictEqual(keyCreate.body.stepUp, true);

  // Unknown dks_ token returns 401 (and public GET /api/session treats it as logged out).
  const badTok = `dks_${'0'.repeat(64)}`;
  assert.strictEqual((await call('GET', '/api/gates', { key: badTok })).status, 401);
  const pubBad = await call('GET', '/api/session', { key: badTok });
  assert.strictEqual(pubBad.status, 200);
  assert.strictEqual(pubBad.body.loggedIn, false);

  // Sign-out via Bearer dks_ revokes the session immediately.
  assert.strictEqual((await call('DELETE', '/api/session', { key: tok })).status, 200);
  assert.strictEqual((await call('GET', '/api/gates', { key: tok })).status, 401);

  // Digital Asset Links returns [] when unconfigured, and androidApkKeyHashOrigin encodes SHA-256 hex to base64url.
  const emptyLinks = await call('GET', '/.well-known/assetlinks.json');
  assert.strictEqual(emptyLinks.status, 200);
  assert.deepStrictEqual(emptyLinks.body, []);

  const fp = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
  config.android.packageName = 'com.doorking.gate';
  config.android.sha256CertFingerprints = [fp];
  const links = await call('GET', '/.well-known/assetlinks.json');
  assert.strictEqual(links.status, 200);
  assert.strictEqual(links.body.length, 1);
  assert.strictEqual(links.body[0].target.package_name, 'com.doorking.gate');
  assert.deepStrictEqual(links.body[0].target.sha256_cert_fingerprints, [fp]);
  assert.strictEqual(
    dk.androidApkKeyHashOrigin(fp),
    `android:apk-key-hash:${Buffer.from(fp.replace(/:/g, ''), 'hex').toString('base64url')}`,
  );
}));

test('audit security fixes: unverified email cannot hijack portal, unknown logins redacted, history strips PII, bulk delete revokes portal, SSRF hardened, ISO portal dates', withServer(async ({ store, call }) => {
  await dk.createUser(store, { username: 'admin', password: 'admin-password-123', email: 'admin@example.com', createdBy: 'test', mustChangePassword: false });
  await dk.createUser(store, { username: 'attacker', password: 'attacker-password-1', createdBy: 'test', mustChangePassword: false });
  await dk.createUser(store, { username: 'viewer', password: 'viewer-password-123', createdBy: 'test', mustChangePassword: false });
  await dk.registerGate(store, GATE_A, 'admin');
  await dk.grantAccess(store, GATE_A.phoneNumber, 'viewer', 'readonly', 'admin');
  await pullInto(store);
  await dk.ensureCache(store, GATE_A.phoneNumber);

  const adminCookie = (await call('POST', '/api/session', { body: { user: 'admin', password: 'admin-password-123' } })).cookie;
  const attackerCookie = (await call('POST', '/api/session', { body: { user: 'attacker', password: 'attacker-password-1' } })).cookie;
  const viewerCookie = (await call('POST', '/api/session', { body: { user: 'viewer', password: 'viewer-password-123' } })).cookie;

  // 1. Unverified pending_email on an active account must NOT bind when admin enables portal for that neighbor's email.
  const setPending = await call('PUT', '/api/me', {
    cookie: attackerCookie,
    body: { email: 'neighbor@example.com', password: 'attacker-password-1' },
  });
  assert.strictEqual(setPending.status, 200);
  const synced = await dk.syncResidentPortal(store, {
    phone: GATE_A.phoneNumber, code: '101', email: 'neighbor@example.com', enabled: true, actor: 'admin',
  });
  assert.notStrictEqual(synced.record?.username, 'attacker', 'unverified pending_email must not hijack unit');
  assert.strictEqual(synced.action, 'invited');

  // 2. Failed login with an unknown username (e.g. mistyped password) must be redacted as "unknown" in login_audit.
  await call('POST', '/api/session', { body: { user: 'MySecretPassword99!', password: 'wrong' } });
  const auditRes = await call('GET', `/api/gates/${GATE_A.phoneNumber}/login-audit`, { cookie: adminCookie });
  assert.strictEqual(auditRes.status, 200);
  assert.ok(!auditRes.body.entries.some((e: { identifier: string }) => e.identifier.includes('MySecretPassword99!')));
  assert.ok(auditRes.body.entries.some((e: { identifier: string; username: string | null }) => e.username === null && e.identifier === 'unknown'));

  // 3. GET /history must not expose private email/phone to read-only viewers.
  await dk.updateUserSettings(store, 'admin', { phone: '+12145550101' });
  const hist = await call('GET', `/api/gates/${GATE_A.phoneNumber}/history`, { cookie: viewerCookie });
  assert.strictEqual(hist.status, 200);
  const adminEntry = hist.body.users.find((u: { username: string }) => u.username === 'admin');
  assert.ok(adminEntry);
  assert.strictEqual(adminEntry.email, undefined);
  assert.strictEqual(adminEntry.phone, undefined);

  // 4. Bulk delete must revoke Resident Portal access for deleted units.
  const bulkDel = await call('POST', `/api/gates/${GATE_A.phoneNumber}/residents/bulk`, {
    cookie: adminCookie,
    body: { action: 'delete', codes: ['101'] },
  });
  assert.strictEqual(bulkDel.status, 200);
  assert.strictEqual(await dk.getResidentPortal(store, GATE_A.phoneNumber, '101'), null);

  // 5. SSRF checks block private LAN & IPv4-mapped IPv6 on webhooks and push subscriptions.
  for (const badUrl of ['https://10.0.0.1/hook', 'https://192.168.1.5/hook', 'https://172.16.0.1/hook', 'https://[::ffff:127.0.0.1]/hook']) {
    assert.throws(() => dk.checkWebhookUrl(badUrl), /loopback, private network/i);
    await assert.rejects(() => dk.savePushSubscription(store, 'viewer', {
      endpoint: badUrl,
      keys: { p256dh: 'a'.repeat(40), auth: 'b'.repeat(20) },
    }), /loopback, private network/i);
  }

  // 6. Portal Open transactions use ISO YYYY-MM-DD dates matching hardware tx_history.
  const ev = await dk.recordPortalEvent(store, {
    phone: GATE_A.phoneNumber, directoryCode: '101', username: 'admin', relay: 0, result: 'done',
    ts: new Date(2026, 10, 23, 9, 5, 0),
  });
  const row = dk.portalEventToTxRow(ev, new Map([['101', 'Test']]));
  assert.strictEqual(row.date, '2026-11-23');
  assert.strictEqual(row.time, '9:05 AM');
}));
