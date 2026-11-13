import fs from 'node:fs';
import path from 'node:path';
import { all, decryptBytes, encryptBytes, getMeta, one, run, setMeta, transaction, type Store } from './db.ts';
import { getGate } from './gate-list.ts';
import { GATE_SETTING_FIELDS, decodeGateSettings } from './gate-settings.ts';
import {
  addSettingRows, buildFiles, checkRoundTrip, decodeWorking, deleteWorkingState, describeConflict, diffStates, fileDifferences, itemsOf,
  loadWorkingState, rebasePlan, sameItem, saveWorkingState, setConflicts, withItem,
  type Conflict, type ConflictKind, type ItemChange, type RebasePlan, type WorkingState,
} from './gate-state.ts';
import { namesLayout } from './board-files.ts';
import { updateMiddlePointer, type BoardBuffers } from './residents-edit.ts';

// The gate's working copy. Nothing here talks to the gate.
// gate_files (encrypted: names.bin holds the master code) keeps per gate and file the base: the latest residents
// pull, i.e. what the gate holds (rcv_out.bin isn't kept: its events go into tx_history, see tx-history.ts). Until
// 2026-11-13 a newer pull waited in a separate `pulled` copy until Reset to gate; migratePulledCopies converts those.
// The working copy itself is values in tables (gate_residents, gate_cards, gate_settings, gate_working; see
// gate-state.ts). Its board files are built from base + values whenever they are read; a write is decoded into
// values and stored only when the files rebuild from them byte for byte. A file's change map (one byte per 128-byte
// block, 1 = block differs from base: the blocks a send uploads) is worked out from base and working copy.
// Each residents pull becomes the base at once (applyPull); unsent changes are put back on top of it, and items both
// sides changed differently become conflicts that must be decided before a send.
export const CACHE_FILES = ['names.bin', 'phone.bin', 'cards.bin'];
const BLOCK_SIZE = 128;
const NAMES_MODE_DELTA = 0x380; // names.bin size difference between the 255 and 10 area-code layouts

// pulled: the gate's file is stored. A conflict as shown: { kind, key, label, gate, mine } (the two values in words).
export type CacheFileStatus =
  | { name: string; cached: false; pulled: boolean }
  | { name: string; cached: true; changedBlocks: number[]; baseTime: Date; savedTime: Date };
export interface ConflictView extends Conflict { gate: string; mine: string }
export interface CacheStatus { exists: boolean; edited: boolean; conflicts: ConflictView[]; files: CacheFileStatus[] }
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

// The base from gate_files; working built from base and the working copy's values, with the master code saved with
// the gate's login (managed_gates; for a gate not managed here the base's bytes stay). conflicts: as stored.
type Loaded = Copies & { baseOk: boolean; masterCode?: string; conflicts: Conflict[] };
async function loadCopies(store: Store, phone: unknown, names: string[] = CACHE_FILES): Promise<Loaded> {
  const c = await loadFiles(store, phone, [...new Set([...names, ...CACHE_FILES])]);
  c.working = new Map();
  const [w, gate] = await Promise.all([loadWorkingState(store, phone), getGate(store, phone)]);
  const masterCode = gate ? gate.masterCode : undefined;
  if (w && hasAll(c.base)) {
    const built = buildFiles(boardOf(c.base), w.state, { masterCode });
    for (const n of CACHE_FILES) c.working.set(n, { data: built[n.replace('.bin', '') as keyof BoardBuffers], savedAt: w.savedAt });
  }
  return { ...c, baseOk: Boolean(w && w.baseOk), masterCode, conflicts: w ? w.conflicts : [] };
}

async function putFile(store: Store, phone: unknown, copy: Copy, name: string, data: Buffer, savedAt: Date = new Date()): Promise<void> {
  await run(store, `INSERT INTO gate_files (phone, copy, name, data, saved_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone, copy, name) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at`,
  [phoneDigits(phone), copy, name, encryptBytes(store, data), savedAt.toISOString()]);
}

function statusOf(c: Loaded): CacheStatus {
  const files = CACHE_FILES.map((name): CacheFileStatus => {
    const work = c.working.get(name);
    const base = c.base.get(name);
    if (!work || !base) return { name, cached: false, pulled: Boolean(base) };
    return { name, cached: true, changedBlocks: changed(blockMap(base.data, work.data)), baseTime: base.savedAt, savedTime: work.savedAt };
  });
  const cached = files.filter((f): f is Extract<CacheFileStatus, { cached: true }> => f.cached);
  return { exists: cached.length > 0, edited: cached.some((f) => f.changedBlocks.length), conflicts: liveConflicts(c), files };
}

// The stored conflicts whose item still differs between the working copy and the gate, with both values in words.
function liveConflicts(c: Loaded): ConflictView[] {
  if (!c.conflicts.length || !hasAll(c.working) || !hasAll(c.base)) return [];
  const [mine, gate] = [itemsOf(decodeWorking(boardOf(c.working))), itemsOf(decodeWorking(boardOf(c.base)))];
  return c.conflicts.flatMap((x) => {
    const [m, g] = [mine[x.kind].get(x.key) ?? null, gate[x.kind].get(x.key) ?? null];
    return sameItem(x.kind, m, g) ? [] : [{ ...x, ...describeConflict(x.kind, g, m) }];
  });
}
// Per file: whether it is cached and the changed blocks; whether anything is unsent; the conflicts to decide.
export async function cacheStatus(store: Store, phone: unknown): Promise<CacheStatus> {
  return statusOf(await loadCopies(store, phone));
}

// The gate's files as stored (the latest residents pull), or null when one is missing.
export async function readBaseFiles(store: Store, phone: unknown): Promise<BoardBuffers | null> {
  const c = await loadFiles(store, phone, CACHE_FILES);
  return hasAll(c.base) ? boardOf(c.base) : null;
}

// Makes files the base and the working copy their values (no unsent changes, no conflicts). A missing file drops the
// working copy. When the files fail the round-trip check, editing stays locked (baseOk false).
async function setBase(tx: Store, phone: unknown, files: Map<string, StoredFile>): Promise<void> {
  for (const name of CACHE_FILES) {
    const f = files.get(name);
    if (f) await putFile(tx, phone, 'base', name, f.data, f.savedAt);
    else await run(tx, "DELETE FROM gate_files WHERE phone = $1 AND copy = 'base' AND name = $2", [phoneDigits(phone), name]);
  }
  await run(tx, "DELETE FROM gate_files WHERE phone = $1 AND copy IN ('pulled', 'working')", [phoneDigits(phone)]);
  if (!hasAll(files)) { await deleteWorkingState(tx, phone); return; }
  const board = boardOf(files);
  await saveWorkingState(tx, phone, decodeWorking(board), { baseOk: checkRoundTrip(board).ok });
  await setConflicts(tx, phone, []);
}
const fileMap = (files: Record<string, Buffer>, at: Date) => new Map(Object.entries(files)
  .filter(([n]) => CACHE_FILES.includes(n.toLowerCase())).map(([n, data]) => [n.toLowerCase(), { data, savedAt: at }]));

// Makes pulled files the base and the working copy (unsent changes are dropped), as after a send the gate confirmed.
export async function replaceBase(store: Store, phone: unknown, files: Record<string, Buffer>, at: Date = new Date()): Promise<CacheStatus> {
  await transaction(store, (tx) => setBase(tx, phone, fileMap(files, at)));
  return cacheStatus(store, phone);
}

// Reset to gate: drops the unsent changes and conflicts; the working copy becomes the gate's files again.
export async function resetCache(store: Store, phone: unknown): Promise<CacheStatus> {
  await transaction(store, async (tx) => {
    const c = await loadFiles(tx, phone, CACHE_FILES);
    if (!c.base.size) throw statusError('No resident files yet. Pull residents from the gate.', 404);
    await setBase(tx, phone, c.base);
  });
  return cacheStatus(store, phone);
}

// What a residents pull did to the working copy. outcome: new (no working copy before), unchanged (the gate holds
// the same files), refreshed (no unsent changes: the working copy is the pull), rebased (unsent changes put back on
// top of the pull), dropped (unsent changes dropped: reason). kept: changes put back; fromGate: items the gate changed
// that the working copy now shows; conflicts: items both changed differently (the working copy's value kept);
// notKept: changes that couldn't be put back (the gate's value kept), with why.
export interface PullResult {
  outcome: 'new' | 'unchanged' | 'refreshed' | 'rebased' | 'dropped';
  kept: number; fromGate: number; conflicts: Conflict[];
  notKept: { kind: ConflictKind; key: string; label: string; error: string }[];
  dropped?: { count: number; reason: string };
}

// Builds the working copy for a rebase: every change at once, else one at a time, leaving out those the files can't
// take (for example an entry code the gate now gives to someone else). The middle-entry pointer is worked out again
// when the directory differs from the pull's.
function buildRebase(base: BoardBuffers, plan: RebasePlan, masterCode?: string): { state: WorkingState; notKept: PullResult['notKept'] } {
  const start = namesLayout(base.names).directoryOffset;
  const attempt = (w: WorkingState): WorkingState | string => {
    try {
      const built = buildFiles(base, w, { masterCode });
      if (!built.names.subarray(start).equals(base.names.subarray(start))) updateMiddlePointer(built.names);
      const state = decodeWorking(built);
      const diff = fileDifferences(built, buildFiles(base, state, { masterCode }));
      return diff.length ? `rebuilding gives different bytes (${diff.map((d) => d.file).join(', ')})` : state;
    } catch (e) { return (e as Error).message; }
  };
  const put = (w: WorkingState, c: ItemChange) => withItem(w, c.kind, c.key, c.value);
  const all = attempt(plan.changes.reduce(put, plan.gate));
  if (typeof all !== 'string') return { state: all, notKept: [] };
  const notKept: PullResult['notKept'] = [];
  let w = plan.gate;
  for (const c of plan.changes) {
    const next = put(w, c);
    const r = attempt(next);
    if (typeof r === 'string') notKept.push({ kind: c.kind, key: c.key, label: c.label, error: r }); else w = next;
  }
  const state = attempt(w);
  if (typeof state === 'string') throw new Error(`The pull can't be built into a working copy: ${state}`);
  return { state, notKept };
}

// How many items a values patch changes.
const patchSize = (w0: WorkingState, w1: WorkingState): number => {
  const p = diffStates(w0, w1);
  return p ? ['residents', 'cards', 'settings'].reduce((n, k) => n + Object.keys((p as Record<string, object>)[k] || {}).length, 0) : 0;
};

// A residents pull: its files become the base (what the gate holds) at once, and the working copy follows. Unsent
// changes are put back on top of the pull (see rebasePlan); when the gate's or the working copy's directory code
// digits or area-code mode changed, or the pull can't be edited (round-trip check), the gate's version is taken
// and the changes are dropped. Other files (rcv_out.bin) are ignored. Run it while no edit is being saved.
export async function applyPull(store: Store, phone: unknown, files: Record<string, Buffer>, at: Date = new Date()):
  Promise<PullResult & { status: CacheStatus }> {
  const pulled = fileMap(files, at);
  const none = { kept: 0, fromGate: 0, conflicts: [], notKept: [] };
  const result = await transaction(store, async (tx): Promise<PullResult> => {
    const c = await loadCopies(tx, phone);
    if (!hasAll(pulled) || !hasAll(c.base) || !hasAll(c.working)) { await setBase(tx, phone, pulled); return { outcome: 'new', ...none }; }
    if (CACHE_FILES.every((n) => pulled.get(n)!.data.equals(c.base.get(n)!.data))) {
      for (const n of CACHE_FILES) await putFile(tx, phone, 'base', n, pulled.get(n)!.data, at);
      return { outcome: 'unchanged', ...none };
    }
    if (!statusOf(c).edited) { await setBase(tx, phone, pulled); return { outcome: 'refreshed', ...none }; }
    const board = boardOf(pulled);
    const mine = (await loadWorkingState(tx, phone))!;
    const oldBase = decodeWorking(boardOf(c.base));
    const plan = rebasePlan(oldBase, mine.state, decodeWorking(board), mine.conflicts);
    const locked = !checkRoundTrip(board).ok;
    if (plan.layoutChanged || locked) {
      const count = patchSize(oldBase, mine.state);
      await setBase(tx, phone, pulled);
      return { outcome: 'dropped', ...none, dropped: { count, reason: locked
        ? 'the new pull can\'t be edited (its round-trip check failed)'
        : 'the directory code digits or the area-code mode changed, at the gate or in the working copy' } };
    }
    const built = buildRebase(board, plan, c.masterCode);
    for (const n of CACHE_FILES) await putFile(tx, phone, 'base', n, pulled.get(n)!.data, at);
    await saveWorkingState(tx, phone, built.state, { baseOk: true, savedAt: mine.savedAt });
    const conflicts = plan.conflicts.filter((x) => !built.notKept.some((n) => n.kind === x.kind && n.key === x.key));
    await setConflicts(tx, phone, conflicts);
    return { outcome: 'rebased', kept: plan.changes.length - built.notKept.length, fromGate: plan.fromGate, conflicts, notKept: built.notKept };
  });
  return { ...result, status: await cacheStatus(store, phone) };
}

// Decides a conflict: mine keeps the working copy's value; gate takes the gate's (saved like any edit). Returns the
// status.
export async function resolveConflict(store: Store, phone: unknown, kind: unknown, key: unknown, choice: unknown): Promise<CacheStatus> {
  if (choice !== 'mine' && choice !== 'gate') throw statusError('choice must be "mine" or "gate"', 400);
  const c = await loadCopies(store, phone);
  const conflict = c.conflicts.find((x) => x.kind === kind && x.key === String(key));
  if (!conflict) throw statusError('There is no such conflict', 404);
  if (choice === 'gate' && hasAll(c.working)) {
    const gateValue = itemsOf(decodeWorking(boardOf(c.base)))[conflict.kind].get(conflict.key) ?? null;
    const work = boardOf(c.working);
    let built: BoardBuffers;
    try {
      built = buildFiles(boardOf(c.base), withItem(decodeWorking(work), conflict.kind, conflict.key, gateValue), { masterCode: c.masterCode });
    } catch (e) { throw statusError(`Can't take the gate's value: ${(e as Error).message}`, 409); }
    const start = namesLayout(built.names).directoryOffset;
    if (!built.names.subarray(start).equals(work.names.subarray(start))) updateMiddlePointer(built.names);
    await writeCacheFiles(store, phone, { 'names.bin': built.names, 'phone.bin': built.phone, 'cards.bin': built.cards });
  }
  await setConflicts(store, phone, c.conflicts.filter((x) => x !== conflict));
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
  try { rebuilt = buildFiles(boardOf(c.base), state, { masterCode: c.masterCode }); } catch (e) {
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

// Once per gate: a newer pull kept in the `pulled` copy (until 2026-11-13) is applied like a residents pull now
// (applyPull), then the copy is deleted. Returns { phone, outcome }.
export async function migratePulledCopies(store: Store): Promise<{ phone: string; outcome: PullResult['outcome'] | 'removed' }[]> {
  const out: { phone: string; outcome: PullResult['outcome'] | 'removed' }[] = [];
  for (const { phone } of await all<{ phone: string }>(store, "SELECT DISTINCT phone FROM gate_files WHERE copy = 'pulled' ORDER BY phone")) {
    const { pulled } = await loadFiles(store, phone, CACHE_FILES);
    let outcome: PullResult['outcome'] | 'removed' = 'removed';
    if (hasAll(pulled)) {
      const at = new Date(Math.max(...[...pulled.values()].map((f) => f.savedAt.getTime())));
      outcome = (await applyPull(store, phone, Object.fromEntries([...pulled].map(([n, f]) => [n, f.data])), at)).outcome;
    }
    await run(store, "DELETE FROM gate_files WHERE phone = $1 AND copy = 'pulled'", [phone]);
    out.push({ phone, outcome });
  }
  return out;
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
  if (status.conflicts.length) {
    fail(`Decide the ${status.conflicts.length} conflict(s) with the gate first (Keep mine or Take the gate's).`);
  }
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
