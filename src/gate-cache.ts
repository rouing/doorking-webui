import fs from 'node:fs';
import path from 'node:path';
import { all, decryptBytes, encryptBytes, getMeta, one, run, setMeta, transaction, type Store } from './db.ts';
import { GATE_SETTING_FIELDS, decodeGateSettings } from './gate-settings.ts';
import {
  addSettingRows, buildFiles, checkRoundTrip, decodeWorking, deleteWorkingState, fileDifferences, loadWorkingState, saveWorkingState,
} from './gate-state.ts';
import type { BoardBuffers } from './residents-edit.ts';

// The gate's working copy. Nothing here talks to the gate.
// gate_files (encrypted: names.bin holds the master code) keeps per gate and file:
//   pulled   the latest pull (every pulled file, rcv_out.bin included)
//   base     the files as pulled when the working copy was made (what the gate holds)
// The working copy itself is values in tables (gate_residents, gate_cards, gate_settings, gate_working; see
// gate-state.ts). Its board files are built from base + values whenever they are read; a write is decoded into
// values and stored only when the files rebuild from them byte for byte. A file's change map (one byte per 128-byte
// block, 1 = block differs from base: the blocks a send uploads) is worked out from base and working copy.
export const CACHE_FILES = ['names.bin', 'phone.bin', 'cards.bin'];
const BLOCK_SIZE = 128;
const NAMES_MODE_DELTA = 0x380; // names.bin size difference between the 255 and 10 area-code layouts

export type CacheFileStatus =
  | { name: string; cached: false; pulled: boolean }
  | { name: string; cached: true; changedBlocks: number[]; newerPull: boolean; baseTime: Date; savedTime: Date };
export interface CacheStatus { exists: boolean; edited: boolean; newerPull: boolean; files: CacheFileStatus[] }
export interface StoredFile { data: Buffer; savedAt: Date }
type Copy = 'pulled' | 'base' | 'working';
type Copies = Record<Copy, Map<string, StoredFile>>;

const statusError = (msg: string, status: number) => Object.assign(new Error(msg), { status });
const phoneDigits = (phone: unknown): string => String(phone || '').replace(/\D/g, '');

// Sizes allowed for a working-copy file: the pulled size, or for names.bin the other area-code layout's size.
const sizeOk = (name: string, base: Buffer, data: Buffer): boolean => data.length === base.length
  || (name === 'names.bin' && Math.abs(data.length - base.length) === NAMES_MODE_DELTA);
const mapName = (name: string) => name.replace(/\.bin$/, '.map');

export function blockMap(base: Buffer, work: Buffer): Buffer {
  const map = Buffer.alloc(Math.ceil(work.length / BLOCK_SIZE));
  for (let i = 0; i < work.length; i++) if (work[i] !== base[i]) map[Math.floor(i / BLOCK_SIZE)] = 1;
  return map;
}
const changed = (map: Buffer): number[] => [...map.keys()].filter((i) => map[i]);

// The stored files (copies as kept in gate_files).
async function loadFiles(store: Store, phone: unknown, names: string[]): Promise<Copies> {
  const rows = await all<{ copy: Copy; name: string; data: Buffer; saved_at: string }>(store,
    'SELECT copy, name, data, saved_at FROM gate_files WHERE phone = $1 AND name = ANY($2)', [phoneDigits(phone), names]);
  const out: Copies = { pulled: new Map(), base: new Map(), working: new Map() };
  for (const r of rows) out[r.copy].set(r.name, { data: decryptBytes(store, r.data), savedAt: new Date(r.saved_at) });
  return out;
}

const boardOf = (m: Map<string, StoredFile>): BoardBuffers => ({
  names: m.get('names.bin')!.data, phone: m.get('phone.bin')!.data, cards: m.get('cards.bin')!.data,
});
const hasAll = (m: Map<string, StoredFile>) => CACHE_FILES.every((n) => m.has(n));

// pulled and base from gate_files; working built from base and the working copy's values.
async function loadCopies(store: Store, phone: unknown, names: string[] = CACHE_FILES): Promise<Copies & { baseOk: boolean }> {
  const c = await loadFiles(store, phone, [...new Set([...names, ...CACHE_FILES])]);
  c.working = new Map();
  const w = await loadWorkingState(store, phone);
  if (w && hasAll(c.base)) {
    const built = buildFiles(boardOf(c.base), w.state);
    for (const n of CACHE_FILES) c.working.set(n, { data: built[n.replace('.bin', '') as keyof BoardBuffers], savedAt: w.savedAt });
  }
  return { ...c, baseOk: Boolean(w && w.baseOk) };
}

async function putFile(store: Store, phone: unknown, copy: Copy, name: string, data: Buffer, savedAt: Date = new Date()): Promise<void> {
  await run(store, `INSERT INTO gate_files (phone, copy, name, data, saved_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone, copy, name) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at`,
  [phoneDigits(phone), copy, name, encryptBytes(store, data), savedAt.toISOString()]);
}

function statusOf(c: Copies): CacheStatus {
  const files = CACHE_FILES.map((name): CacheFileStatus => {
    const work = c.working.get(name);
    const base = c.base.get(name);
    const pulled = c.pulled.get(name);
    if (!work || !base) return { name, cached: false, pulled: Boolean(pulled) };
    return {
      name,
      cached: true,
      changedBlocks: changed(blockMap(base.data, work.data)),
      newerPull: Boolean(pulled) && !pulled!.data.equals(base.data),
      baseTime: base.savedAt,
      savedTime: work.savedAt,
    };
  });
  const cached = files.filter((f): f is Extract<CacheFileStatus, { cached: true }> => f.cached);
  return {
    exists: cached.length > 0,
    edited: cached.some((f) => f.changedBlocks.length),
    newerPull: cached.some((f) => f.newerPull),
    files,
  };
}

// Per file: whether it is cached, the changed blocks, and whether the last pull differs from the base.
export async function cacheStatus(store: Store, phone: unknown): Promise<CacheStatus> {
  return statusOf(await loadCopies(store, phone));
}

// Saves the files of a pull as the gate's latest pull. The working copy is not changed (see syncCacheAfterPull).
export async function savePulledFiles(store: Store, phone: unknown, files: Record<string, Buffer>, at: Date = new Date()): Promise<void> {
  await transaction(store, async (tx) => {
    for (const [name, data] of Object.entries(files)) await putFile(tx, phone, 'pulled', name.toLowerCase(), data, at);
  });
}

// One file of the latest pull (e.g. rcv_out.bin), or null.
export async function readPulledFile(store: Store, phone: unknown, name: string): Promise<StoredFile | null> {
  return (await loadFiles(store, phone, [name])).pulled.get(name) || null;
}

// The latest pull's files: { name: { data, savedAt } }.
export async function readPulledFiles(store: Store, phone: unknown, names: string[]): Promise<Record<string, StoredFile>> {
  return Object.fromEntries((await loadFiles(store, phone, names)).pulled);
}

// Replaces the working copy (and its base) with the last pulled files. Saved edits are lost. The working copy's
// values are decoded from the pull; when the pull fails the round-trip check, editing stays locked (baseOk false).
export async function resetCache(store: Store, phone: unknown): Promise<CacheStatus> {
  await transaction(store, async (tx) => {
    const c = await loadFiles(tx, phone, CACHE_FILES);
    if (!CACHE_FILES.some((n) => c.pulled.has(n))) throw statusError('No resident files yet. Pull residents from the gate.', 404);
    for (const name of CACHE_FILES) {
      const src = c.pulled.get(name);
      if (!src) {
        await run(tx, "DELETE FROM gate_files WHERE phone = $1 AND name = $2 AND copy IN ('base', 'working')", [phoneDigits(phone), name]);
        continue;
      }
      await putFile(tx, phone, 'base', name, src.data, src.savedAt);
    }
    await run(tx, "DELETE FROM gate_files WHERE phone = $1 AND copy = 'working'", [phoneDigits(phone)]);
    if (!hasAll(c.pulled)) { await deleteWorkingState(tx, phone); return; }
    const pulled = boardOf(c.pulled);
    await saveWorkingState(tx, phone, decodeWorking(pulled), { baseOk: checkRoundTrip(pulled).ok });
  });
  return cacheStatus(store, phone);
}

// Makes the working copy when there is none yet.
export async function ensureCache(store: Store, phone: unknown): Promise<CacheStatus> {
  const status = await cacheStatus(store, phone);
  return status.exists ? status : resetCache(store, phone);
}

// After a residents pull: refresh the working copy when it has no saved edits; an edited copy is kept.
export async function syncCacheAfterPull(store: Store, phone: unknown): Promise<{ refreshed: boolean; status: CacheStatus }> {
  const status = await cacheStatus(store, phone);
  if (status.edited) return { refreshed: false, status };
  return { refreshed: true, status: await resetCache(store, phone) };
}

// { data, base, savedTime, baseTime } for each working-copy file (throws 404 when one is missing).
export async function readCacheFiles(store: Store, phone: unknown):
  Promise<Record<string, { data: Buffer; base: Buffer; savedTime: Date; baseTime: Date }>> {
  const c = await loadCopies(store, phone);
  return Object.fromEntries(CACHE_FILES.map((name) => {
    const work = c.working.get(name);
    const base = c.base.get(name);
    if (!work || !base) throw statusError(`${name} is not in the working copy. Pull residents from the gate.`, 404);
    return [name, { data: work.data, base: base.data, savedTime: work.savedAt, baseTime: base.savedAt }];
  }));
}

// { data, base, savedTime, baseTime } for one cached file.
export async function readCacheFile(store: Store, phone: unknown, name: string):
  Promise<{ data: Buffer; base: Buffer; savedTime: Date; baseTime: Date }> {
  const c = CACHE_FILES.includes(name) ? await loadCopies(store, phone, [name]) : null;
  const work = c && c.working.get(name);
  const base = c && c.base.get(name);
  if (!work || !base) throw statusError(`${name} is not in the working copy. Pull residents from the gate.`, 404);
  return { data: work.data, base: base.data, savedTime: work.savedAt, baseTime: base.savedAt };
}

// Saves working-copy files (names.bin, phone.bin and/or cards.bin; the others stay as they are). Each must keep the
// base file's size, except names.bin, which may switch area-code layout (see sizeOk). The files are decoded into
// the working copy's values, which are stored only when the files rebuild from them byte for byte; otherwise
// nothing is saved (409). Refused (409) while the base failed the round-trip check. Returns the changed blocks.
export async function writeCacheFiles(store: Store, phone: unknown, files: Record<string, Buffer>): Promise<Record<string, number[]>> {
  const c = await loadCopies(store, phone);
  for (const name of Object.keys(files)) {
    if (!CACHE_FILES.includes(name) || !c.working.has(name)) {
      throw statusError(`${name} is not in the working copy. Pull residents from the gate.`, 404);
    }
  }
  if (!c.baseOk) {
    throw statusError('Editing is locked for this gate: its last pull could not be rebuilt byte for byte from its values (round-trip check). Nothing was saved.', 409);
  }
  const merged = new Map(c.working);
  for (const [name, data] of Object.entries(files)) {
    const base = c.base.get(name)!.data;
    if (!sizeOk(name, base, data)) throw new Error(`${name} must stay ${base.length} bytes`);
    merged.set(name, { data, savedAt: new Date() });
  }
  const want = boardOf(merged);
  const state = decodeWorking(want);
  let rebuilt: BoardBuffers;
  try { rebuilt = buildFiles(boardOf(c.base), state); } catch (e) {
    throw statusError(`This change can't be stored as gate values (${(e as Error).message}). Nothing was saved.`, 409);
  }
  const diff = fileDifferences(want, rebuilt);
  if (diff.length) {
    throw statusError(`This change can't be stored as gate values: rebuilding gives different bytes (${diff
      .map((d) => `${d.file} ${d.bytes} at ${d.offsets.join(' ')}`).join('; ')}). Nothing was saved.`, 409);
  }
  await saveWorkingState(store, phone, state, { baseOk: true });
  return Object.fromEntries(CACHE_FILES.map((n) => [n, changed(blockMap(c.base.get(n)!.data, merged.get(n)!.data))]));
}

// Saves one working-copy file (see writeCacheFiles).
export async function writeCacheFile(store: Store, phone: unknown, name: string, data: Buffer): Promise<{ changedBlocks: number[] }> {
  return { changedBlocks: (await writeCacheFiles(store, phone, { [name]: data }))[name] };
}

// Once per gate: a working copy stored as files (gate_files 'working', before the values tables) becomes values.
// It must rebuild byte for byte from base + values; the files are deleted only then. Returns the gates converted.
export async function migrateWorkingFiles(store: Store): Promise<string[]> {
  const phones = (await all<{ phone: string }>(store, "SELECT DISTINCT phone FROM gate_files WHERE copy = 'working'")).map((r) => r.phone);
  for (const phone of phones) {
    const c = await loadFiles(store, phone, CACHE_FILES);
    await transaction(store, async (tx) => {
      if (hasAll(c.base) && hasAll(c.working)) {
        const work = boardOf(c.working);
        const state = decodeWorking(work);
        const diff = fileDifferences(work, buildFiles(boardOf(c.base), state));
        if (diff.length) throw new Error(`Gate ${phone}: its working copy doesn't rebuild from its values (${JSON.stringify(diff)}); kept as files`);
        const savedAt = new Date(Math.max(...[...c.working.values()].map((f) => f.savedAt.getTime())));
        await saveWorkingState(tx, phone, state, { baseOk: checkRoundTrip(boardOf(c.base)).ok, savedAt });
      }
      await run(tx, "DELETE FROM gate_files WHERE phone = $1 AND copy = 'working'", [phone]);
    });
  }
  return phones;
}

// Values the app learned to store after a working copy was saved (setting rows, the extra bytes, the file sizes) are
// added, decoded from the working copy's files (where such bytes still come from the base); the rest is kept.
// Returns the gates that got values.
export async function addMissingValues(store: Store): Promise<string[]> {
  const done: string[] = [];
  for (const { phone, complete } of await all<{ phone: string; complete: boolean }>(store,
    'SELECT phone, extra IS NOT NULL AND sizes IS NOT NULL AS complete FROM gate_working ORDER BY phone')) {
    const have = new Set((await all<{ key: string }>(store, 'SELECT key FROM gate_settings WHERE phone = $1', [phone])).map((r) => r.key));
    if (complete && GATE_SETTING_FIELDS.every((f) => f.secret || have.has(f.key))) continue;
    const c = await loadCopies(store, phone);
    if (!hasAll(c.working)) continue;
    const w = decodeWorking(boardOf(c.working));
    await transaction(store, async (tx) => {
      const missing = decodeGateSettings(c.working.get('names.bin')!.data).filter((s) => !s.secret && !have.has(s.key));
      await addSettingRows(tx, phone, Object.fromEntries(missing.map((s) => [s.key, s.value])));
      await run(tx, 'UPDATE gate_working SET extra = COALESCE(extra, $2), sizes = COALESCE(sizes, $3) WHERE phone = $1',
        [phone, JSON.stringify(w.extra), JSON.stringify(w.sizes)]);
    });
    done.push(phone);
  }
  return done;
}

// A working-copy file (.bin) or its change map (.map) for download, or null.
export async function cacheFileData(store: Store, phone: unknown, name: string): Promise<Buffer | null> {
  const bin = CACHE_FILES.find((n) => n === name || mapName(n) === name);
  if (!bin) return null;
  const c = await loadCopies(store, phone, [bin]);
  const work = c.working.get(bin);
  const base = c.base.get(bin);
  if (!work || !base) return null;
  return name === bin ? work.data : blockMap(base.data, work.data);
}

// Files and maps (keyed by .bin name) for a send. Refused when nothing changed, a file is missing, or the
// last pull differs from the base (the gate may have been changed elsewhere; Reset to gate first).
export async function prepareSend(store: Store, phone: unknown) {
  const c = await loadCopies(store, phone);
  const status = statusOf(c);
  const fail = (msg: string): never => { throw statusError(msg, 409); };
  if (status.files.some((f) => !f.cached)) fail('The working copy is missing files. Pull residents from the gate.');
  if (status.newerPull) fail('A newer pull differs from the working copy base. Reset to gate before sending.');
  if (!status.edited) fail('The working copy has no changes to send.');
  const files: Record<string, Buffer> = {};
  const maps: Record<string, Buffer> = {};
  const changedBlocks: Record<string, number[]> = {};
  for (const name of CACHE_FILES) {
    const data = c.working.get(name)!.data;
    const base = c.base.get(name)!.data;
    if (!sizeOk(name, base, data)) fail(`${name} must stay ${base.length} bytes`);
    const map = blockMap(base, data);
    files[name] = data;
    maps[name] = map;
    changedBlocks[name] = changed(map);
  }
  return { files, maps, changedBlocks };
}

// Compares files pulled after a send with the working copy. differentBlocks lists the 128-byte blocks per file.
export async function verifySend(store: Store, phone: unknown, pulled: Record<string, Buffer | undefined>) {
  const work = await readCacheFiles(store, phone);
  const differentBlocks: Record<string, number[] | 'size differs'> = {};
  for (const name of CACHE_FILES) {
    const { data } = work[name];
    const got = pulled[name];
    if (!got || got.length !== data.length) { differentBlocks[name] = 'size differs'; continue; }
    const blocks = changed(blockMap(data, got));
    if (blocks.length) differentBlocks[name] = blocks;
  }
  return { matches: !Object.keys(differentBlocks).length, differentBlocks };
}

// Pulled files kept in gate_files. Board files (names/phone/cards) and the transaction ring buffer.
const PULLED_FILES = [...CACHE_FILES, 'rcv_out.bin'];

function findFile(dir: string, name: string): string | null {
  const f = fs.existsSync(dir) && fs.readdirSync(dir).find((n) => n.toLowerCase() === name);
  return f ? path.join(dir, f) : null;
}

// One-time move of the board files kept on disk before gate_files (<root>/<phone>/*.bin, cache/base/*.bin,
// cache/*.bin and cache/*.map): each copy is stored with its file time, read back and compared, then the files are
// deleted (camera pictures in <root>/<phone>/snapshots stay). Returns { phone: files moved }, or null when it already ran.
export async function importGateFiles(store: Store, root: string): Promise<Record<string, number> | null> {
  if (await getMeta(store, 'gateFilesImported')) return null;
  const moved: Record<string, number> = {};
  const gates = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => /^\d+$/.test(n)) : [];
  for (const phone of gates) {
    const dir = path.join(root, phone);
    const sources: [Copy, string, string][] = [];
    for (const name of PULLED_FILES) {
      const f = findFile(dir, name);
      if (f) sources.push(['pulled', name, f]);
    }
    for (const name of CACHE_FILES) {
      const b = findFile(path.join(dir, 'cache', 'base'), name);
      const w = findFile(path.join(dir, 'cache'), name);
      if (b && w) sources.push(['base', name, b], ['working', name, w]);
    }
    if (!sources.length) continue;
    if (await one(store, 'SELECT 1 AS x FROM gate_files WHERE phone = $1', [phone])) {
      throw new Error(`Gate ${phone} already has files in the database; not importing its files from ${dir}`);
    }
    await transaction(store, async (tx) => {
      for (const [copy, name, file] of sources) await putFile(tx, phone, copy, name, fs.readFileSync(file), fs.statSync(file).mtime);
    });
    const back = await loadFiles(store, phone, PULLED_FILES);
    for (const [copy, name, file] of sources) {
      if (!back[copy].get(name)?.data.equals(fs.readFileSync(file))) throw new Error(`Gate ${phone}: ${copy} ${name} did not read back the same`);
    }
    for (const [, , file] of sources) fs.rmSync(file);
    for (const name of CACHE_FILES) fs.rmSync(path.join(dir, 'cache', mapName(name)), { force: true });
    for (const d of [path.join(dir, 'cache', 'base'), path.join(dir, 'cache')]) {
      if (fs.existsSync(d) && !fs.readdirSync(d).length) fs.rmdirSync(d);
    }
    moved[phone] = sources.length;
  }
  await setMeta(store, 'gateFilesImported', new Date().toISOString());
  return moved;
}
