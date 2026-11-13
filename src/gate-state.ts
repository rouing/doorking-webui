// The gate's working copy as plain values, and the board files built from them.
//
// Tables (all keyed by the gate's phone number; the values are the text the app shows):
//   gate_residents  one row per directory code (name, type, hidden, phone, entry code, security level, …)
//   gate_cards      one row per used card slot (card number, directory code)
//   gate_settings   one row per names.bin setting (the master code left out)
//   gate_working    the directory code digits, area-code layout and table, the directory's middle-entry pointer, the
//                   undecoded non-blank bytes (extra), the file sizes, and whether the base passed the round-trip check
//   gate_state      the round-trip and rebuild checks of the latest pull
// The board files to show, compare or send are built from the base copy (gate_files, what the gate holds) and these
// values: buildFiles, with the master code saved with the gate's login (managed_gates; kept out of these tables). The
// base also gives the blocks a send uploads (those that differ from it).
//
// Round-trip check: the decoded values are written back into a copy of the pulled files whose decoded bytes were
// first overwritten, and the copy must come out byte for byte the same as the pull. That shows the files can be
// built from these values. Rebuild check: the files are built from blank ones with the values alone (and the master
// code from managed_gates) and must match the pull too, so no byte is known only from a stored file.
import { namesDirDigits, namesLayout, parseNamesBin, residentRows } from './board-files.ts';
import { all, one, run, transaction, type Store } from './db.ts';
import { GATE_SETTING_FIELDS, WRITTEN_FIELDS, decodeGateSettings } from './gate-settings.ts';
import {
  addEntry, addStoredEntry, applyResidentEdit, convertAreaCodeMode, convertDirDigits, encodeBcd, removeDirectoryCode,
  type BoardBuffers, type EditOptions,
} from './residents-edit.ts';
import type { ResidentRow } from './types.ts';

const CARD_SIZE = 4;
const SCRAMBLE = 0xaa;
const MAX_OFFSETS = 10;
const MIDDLE_POINTER = 0xf8;
const DIR_ENTRY_SIZE = 20;
const DIRECTORY_REGION = 0xc00; // where the area-code table and directory start (in either layout)
const PHONE_RECORD = 10;
const DIR_DIGITS = 0x40;
// names.bin ranges DoorKing32 fills with spaces on every send ([from, to)); the other undecoded bytes it fills with 0xFF.
const BLANK_SPACES: [number, number][] = [[0x100, 0x114], [0x144, 0x145], [0x179, 0x18d]];
const phoneDigits = (phone: unknown): string => String(phone || '').replace(/\D/g, '');
const fail = (msg: string, status: number) => Object.assign(new Error(msg), { status });

// rawCode: the record's bytes 2-3 as hex when they aren't a directory code (e.g. a mass-enabled AB record).
export interface GateCard { slot: number; cardNumber: string; directoryCode: string | null; rawCode?: string }
export interface RoundTripProblem { file: string; bytes: number; offsets: string[]; settings?: string[]; error?: string }
export interface RoundTrip { ok: boolean; problems: RoundTripProblem[]; carried: string[] }
export interface RebuildCheck { ok: boolean; problems: RoundTripProblem[] }
export type BuildOptions = EditOptions & { masterCode?: string };
export type ResidentValues = Pick<ResidentRow, 'directoryCode' | 'name' | 'type' | 'hidden' | 'areaCode' | 'phone' | 'entryCode'
  | 'securityLevel' | 'floor' | 'elevatorRef'> & Partial<Pick<ResidentRow, 'entryOffset' | 'recordOffset'>>;
// The working copy as values.
// areaCodes: the area-code table, one entry per slot (null = free); middlePointer: names.bin 0xF8-0xFA as hex.
// extra: the names.bin bytes before the directory that nothing decodes and that aren't blank (0xFF, or a space in
// BLANK_SPACES), as { "037": "01" } (hex offset: hex bytes); sizes: the files' lengths. Both are missing in rows
// saved before 2026-11-13 until addMissingValues (gate-cache.ts) fills them.
export interface WorkingState {
  dirDigits: number;
  areaCodeMode: number;
  areaCodes: (string | null)[];
  middlePointer: string;
  residents: ResidentValues[];
  cards: GateCard[];
  settings: Record<string, string>;
  extra?: Record<string, string>;
  sizes?: { names: number; phone: number; cards: number };
}

const VALUE_FIELDS = ['name', 'type', 'hidden', 'areaCode', 'phone', 'entryCode', 'securityLevel', 'floor', 'elevatorRef'] as const;
const written = WRITTEN_FIELDS;

// Which names.bin bytes before the directory the values cover: every setting (the master code too), the directory
// code digits, the middle-entry pointer and the area-code table.
function coveredHeader(names: Buffer): Uint8Array {
  const { areaCodeOffset, areaCodeSlots, directoryOffset } = namesLayout(names);
  const covered = new Uint8Array(Math.min(directoryOffset, names.length));
  const mark = (from: number, to: number) => covered.fill(1, from, Math.min(to, covered.length));
  for (const f of GATE_SETTING_FIELDS) mark(f.offset, f.offset + f.type.size);
  mark(DIR_DIGITS, DIR_DIGITS + 1);
  mark(MIDDLE_POINTER, MIDDLE_POINTER + 3);
  mark(areaCodeOffset, areaCodeOffset + areaCodeSlots * 2);
  return covered;
}
const blankByte = (o: number): number => (BLANK_SPACES.some(([a, b]) => o >= a && o < b) ? 0x20 : 0xff);

// The undecoded, non-blank names.bin bytes before the directory, as runs: { "037": "01" }.
export function extraBytes(names: Buffer): Record<string, string> {
  const covered = coveredHeader(names);
  const odd = (o: number) => !covered[o] && names[o] !== blankByte(o);
  const out: Record<string, string> = {};
  for (let o = 0; o < covered.length; o++) {
    if (!odd(o)) continue;
    let end = o + 1;
    while (end < covered.length && odd(end)) end++;
    out[o.toString(16).padStart(3, '0')] = names.toString('hex', o, end);
    o = end;
  }
  return out;
}

// Writes extra bytes back (only where nothing else is decoded).
function writeExtra(names: Buffer, extra: Record<string, string> = {}): void {
  const covered = coveredHeader(names);
  for (const [off, hex] of Object.entries(extra)) {
    const at = parseInt(off, 16);
    Buffer.from(hex, 'hex').forEach((b, i) => { if (at + i < covered.length && !covered[at + i]) names[at + i] = b; });
  }
}

// Every used card slot: card number (5 digits) and directory code ('' = none, null = not a directory code).
export function cardSlots(cards: Buffer): GateCard[] {
  const out: GateCard[] = [];
  for (let o = 0; o + CARD_SIZE <= cards.length; o += CARD_SIZE) {
    const rec = cards.subarray(o, o + CARD_SIZE);
    if (rec.every((b) => b === 0xff)) continue;
    let code: string | null = '';
    for (const b of rec.subarray(2, 4)) {
      for (const n of [b >> 4, b & 0x0f]) {
        if (n <= 9) code += n;
        else if (n !== 0x0f) code = null;
        if (code === null) break;
      }
      if (code === null) break;
    }
    out.push({ slot: o / CARD_SIZE, cardNumber: String(rec.readUInt16BE(0)).padStart(5, '0'), directoryCode: code,
      ...(code === null && { rawCode: rec.toString('hex', 2, 4) }) });
  }
  return out;
}

// cards.bin built from its slots (all other slots free).
export function buildCards(size: number, slots: GateCard[]): Buffer {
  const out = Buffer.alloc(size, 0xff);
  for (const c of slots) {
    out.writeUInt16BE(Number(c.cardNumber), c.slot * CARD_SIZE);
    if (c.directoryCode !== null) encodeBcd(c.directoryCode, 2).copy(out, c.slot * CARD_SIZE + 2);
    else if (c.rawCode) Buffer.from(c.rawCode, 'hex').copy(out, c.slot * CARD_SIZE + 2);
  }
  return out;
}

// The values in a set of board files.
export function decodeWorking(bufs: BoardBuffers): WorkingState {
  return {
    dirDigits: namesDirDigits(bufs.names),
    areaCodeMode: namesLayout(bufs.names).areaCodeMode,
    areaCodes: parseNamesBin(bufs.names).areaCodes,
    middlePointer: bufs.names.toString('hex', MIDDLE_POINTER, MIDDLE_POINTER + 3),
    residents: residentRows(bufs).rows.map((r) => ({
      ...Object.fromEntries(VALUE_FIELDS.map((k) => [k, r[k]])), directoryCode: r.directoryCode,
      entryOffset: r.entryOffset, recordOffset: r.recordOffset,
    }) as ResidentValues),
    cards: cardSlots(bufs.cards),
    settings: Object.fromEntries(decodeGateSettings(bufs.names).filter((s) => !s.secret).map((s) => [s.key, s.value])),
    extra: extraBytes(bufs.names),
    sizes: { names: bufs.names.length, phone: bufs.phone.length, cards: bufs.cards.length },
  };
}

const differs = (a: ResidentValues, b: ResidentValues): boolean => VALUE_FIELDS.some((k) => String(a[k]) !== String(b[k]));
const editOf = (r: ResidentValues) => ({
  directoryCode: r.directoryCode, name: r.name, vendor: r.type === 'Vendor', hidden: r.hidden, areaCode: r.areaCode,
  phone: r.phone, entryCode: r.entryCode, securityLevel: r.securityLevel, elevatorRef: r.elevatorRef, floor: r.floor,
});

// The area-code table written in names.bin's current layout.
function writeAreaCodes(names: Buffer, codes: (string | null)[]): void {
  const { areaCodeOffset, areaCodeSlots } = namesLayout(names);
  for (let i = 0; i < areaCodeSlots && areaCodeOffset + i * 2 + 2 <= names.length; i++) {
    (codes[i] ? encodeBcd(codes[i], 2) : Buffer.from([0xff, 0xff])).copy(names, areaCodeOffset + i * 2);
  }
}

// Puts the directory entries in the working copy's order (by each row's entryOffset). New codes are inserted in
// name order like any add, but where an entry ends up also depends on the names at the time it was added.
function orderDirectory(names: Buffer, residents: ResidentValues[]): void {
  const dir = parseNamesBin(names).directory;
  const byCode = new Map(dir.map((e) => [e.directoryCode, names.subarray(e.entryOffset, e.entryOffset + DIR_ENTRY_SIZE)]));
  const order = residents.filter((r) => r.entryOffset != null).sort((a, b) => a.entryOffset! - b.entryOffset!).map((r) => r.directoryCode);
  if (byCode.size !== dir.length || order.length !== dir.length || order.some((c) => !byCode.has(c))) return;
  const entries = order.map((c) => Buffer.from(byCode.get(c)!));
  const start = namesLayout(names).directoryOffset;
  entries.forEach((e, i) => e.copy(names, start + i * DIR_ENTRY_SIZE));
}

// Puts the phone records in the working copy's order (by each row's recordOffset), in the record slots the edits
// left in use, as orderDirectory does for the directory. They stay as they are unless every record has a distinct
// stored position.
function orderPhone(bufs: BoardBuffers, residents: ResidentValues[]): Buffer {
  const want = new Map(residents.filter((r) => r.recordOffset != null).map((r) => [r.directoryCode, r.recordOffset!]));
  const rows = residentRows(bufs).rows.filter((r) => r.recordOffset !== null);
  if (rows.length !== want.size || rows.some((r) => !want.has(r.directoryCode)) || new Set(want.values()).size !== want.size) return bufs.phone;
  const slots = rows.map((r) => r.recordOffset!).sort((a, b) => a - b);
  const order = [...rows].sort((a, b) => want.get(a.directoryCode)! - want.get(b.directoryCode)!);
  if (order.every((r, i) => r.recordOffset === slots[i])) return bufs.phone;
  const out = Buffer.from(bufs.phone);
  order.forEach((r, i) => bufs.phone.copy(out, slots[i], r.recordOffset!, r.recordOffset! + PHONE_RECORD));
  return out;
}

// The board files of a working copy: the base files with the values written over them. Steps, in this order:
// directory code digits; the area-code table (when the layout is unchanged); directory codes removed, resident
// values that differ, codes added (a blank name as the gate's empty slot); the area-code layout and then its table
// (when the layout changed); settings that differ (read-only ones too, from their stored values); the extra bytes;
// the directory order and middle-entry pointer; the master code, when given (from managed_gates; it isn't in the
// values tables; else the base's bytes stay); the phone records' positions; cards.bin from its slots.
export function buildFiles(base: BoardBuffers, w: WorkingState, { masterCode, ...opts }: BuildOptions = {}): BoardBuffers {
  let bufs: BoardBuffers = { names: Buffer.from(base.names), phone: Buffer.from(base.phone), cards: Buffer.from(base.cards) };
  if (w.dirDigits !== namesDirDigits(bufs.names)) bufs = convertDirDigits(bufs, w.dirDigits);
  const sameLayout = w.areaCodeMode === namesLayout(bufs.names).areaCodeMode;
  if (sameLayout) writeAreaCodes(bufs.names, w.areaCodes);
  const want = new Set(w.residents.map((r) => r.directoryCode));
  const have = new Map(residentRows(bufs).rows.map((r) => [r.directoryCode, r as ResidentValues]));
  for (const code of have.keys()) if (!want.has(code)) bufs = removeDirectoryCode(bufs, code);
  for (const r of w.residents) {
    if (have.has(r.directoryCode) && differs(have.get(r.directoryCode)!, r)) bufs = applyResidentEdit(bufs, editOf(r), opts);
  }
  for (const r of w.residents) {
    if (!have.has(r.directoryCode)) bufs = String(r.name ?? '').trim() ? addEntry(bufs, editOf(r), opts) : addStoredEntry(bufs, editOf(r), opts);
  }
  if (!sameLayout) {
    bufs = convertAreaCodeMode(bufs, w.areaCodeMode);
    writeAreaCodes(bufs.names, w.areaCodes);
  }
  const names = Buffer.from(bufs.names);
  for (const f of written) {
    const v = w.settings[f.key];
    if (v === undefined || v === f.type.decode(names.subarray(f.offset, f.offset + f.type.size))) continue;
    try { f.type.encode!(v).copy(names, f.offset); } catch (e) { throw fail(`${f.name}: ${(e as Error).message}`, 400); }
  }
  writeExtra(names, w.extra);
  orderDirectory(names, w.residents);
  Buffer.from(w.middlePointer, 'hex').copy(names, MIDDLE_POINTER);
  if (masterCode) writeMasterCode(names, masterCode);
  return { names, phone: orderPhone({ names, phone: bufs.phone, cards: bufs.cards }, w.residents), cards: buildCards(base.cards.length, w.cards) };
}

// The master code at 0x00-0x03, one digit per byte (0 = 0x00, as DoorKing32's send builders write it and its receive
// check expects).
function writeMasterCode(names: Buffer, code: string): void {
  if (!/^\d{4}$/.test(code)) throw fail('The master code must be 4 digits', 400);
  Buffer.from([...code].map(Number)).copy(names, 0);
}

// The board files from the values alone, with no stored file: blank files of the recorded sizes (0xFF, spaces where
// DoorKing32 writes them, the directory code digits), then buildFiles (with the master code, when given) and every
// written setting. Throws without sizes.
export function buildFromValues(w: WorkingState, opts: BuildOptions = {}): BoardBuffers {
  if (!w.sizes) throw new Error('The file sizes are not recorded for this working copy');
  const names = Buffer.alloc(w.sizes.names, 0xff);
  for (const [a, b] of BLANK_SPACES) names.fill(0x20, a, b);
  names[DIR_DIGITS] = w.dirDigits;
  const out = buildFiles({ names, phone: Buffer.alloc(w.sizes.phone, 0xff), cards: Buffer.alloc(w.sizes.cards, 0xff) }, w, opts);
  for (const f of written) {
    if (w.settings[f.key] === undefined) continue;
    try { f.type.encode!(w.settings[f.key]).copy(out.names, f.offset); } catch (e) { throw new Error(`${f.name}: ${(e as Error).message}`); }
  }
  return out;
}

// Builds files from their decoded values alone (buildFromValues) and compares them with the files: nothing must be
// known only from the stored files. masterCode: the gate's (else bytes 0-3 differ).
export function checkRebuild(files: BoardBuffers, opts: BuildOptions = {}): RebuildCheck {
  let out: BoardBuffers;
  try { out = buildFromValues(decodeWorking(files), opts); } catch (e) {
    return { ok: false, problems: [{ file: 'all', bytes: 0, offsets: [], error: (e as Error).message }] };
  }
  const problems = labelled(files, out);
  return { ok: !problems.length, problems };
}

// fileDifferences, with the settings that cover differing names.bin bytes.
function labelled(a: BoardBuffers, b: BoardBuffers): RoundTripProblem[] {
  return fileDifferences(a, b).map((p) => {
    const covering = p.file === 'names.bin'
      ? [...new Set(differences(a.names, b.names).offsets
        .flatMap((o) => GATE_SETTING_FIELDS.filter((f) => o >= f.offset && o < f.offset + f.type.size).map((f) => f.key)))]
      : [];
    return { ...p, ...(covering.length && { settings: covering.slice(0, MAX_OFFSETS) }) };
  });
}

// A change to a working copy as values, for History and Revert: per resident (directory code), card slot, setting
// and layout value, [before, after] (null = absent). Only what changed is listed.
export interface ValuesPatch {
  residents?: Record<string, [ResidentValues | null, ResidentValues | null]>;
  cards?: Record<string, [GateCard | null, GateCard | null]>;
  settings?: Record<string, [string | null, string | null]>;
  layout?: Partial<Record<typeof LAYOUT_KEYS[number], [unknown, unknown]>>;
}
const LAYOUT_KEYS = ['dirDigits', 'areaCodeMode', 'areaCodes', 'middlePointer', 'extra', 'sizes'] as const;

// JSON with sorted keys, so two values compare equal whatever order their keys were built in.
const canon = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const same = (a: unknown, b: unknown) => canon(a ?? null) === canon(b ?? null);

function diffMap<T>(before: Map<string, T>, after: Map<string, T>): Record<string, [T | null, T | null]> | undefined {
  const out: Record<string, [T | null, T | null]> = {};
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(k) ?? null;
    const b = after.get(k) ?? null;
    if (!same(a, b)) out[k] = [a, b];
  }
  return Object.keys(out).length ? out : undefined;
}
const residentMap = (w: WorkingState) => new Map(w.residents.map((r) => [r.directoryCode, r]));
const cardMap = (w: WorkingState) => new Map(w.cards.map((c) => [String(c.slot), c]));
const settingMap = (w: WorkingState) => new Map(Object.entries(w.settings));

// What changed from one working copy to another, or null when nothing did.
export function diffStates(before: WorkingState, after: WorkingState): ValuesPatch | null {
  const layout: ValuesPatch['layout'] = {};
  for (const k of LAYOUT_KEYS) if (!same(before[k], after[k])) layout[k] = [before[k], after[k]];
  const patch: ValuesPatch = {
    residents: diffMap(residentMap(before), residentMap(after)),
    cards: diffMap(cardMap(before), cardMap(after)),
    settings: diffMap(settingMap(before), settingMap(after)),
    ...(Object.keys(layout).length && { layout }),
  };
  for (const k of Object.keys(patch) as (keyof ValuesPatch)[]) if (patch[k] === undefined) delete patch[k];
  return Object.keys(patch).length ? patch : null;
}

// Undoes a patch on the current working copy. Every changed value must still hold its "after" value; otherwise a
// later change touched it and null is returned.
export function undoValues(current: WorkingState, patch: ValuesPatch): WorkingState | null {
  const undo = <T>(now: Map<string, T>, changes: Record<string, [T | null, T | null]> = {}): Map<string, T> | null => {
    const out = new Map(now);
    for (const [k, [before, after]] of Object.entries(changes)) {
      if (!same(now.get(k) ?? null, after)) return null;
      if (before === null) out.delete(k); else out.set(k, before);
    }
    return out;
  };
  const res = undo(residentMap(current), patch.residents);
  const cards = undo(cardMap(current), patch.cards);
  const settings = undo(settingMap(current), patch.settings);
  if (!res || !cards || !settings) return null;
  const out: WorkingState = {
    ...current,
    residents: [...res.values()].sort((a, b) => a.directoryCode.localeCompare(b.directoryCode)),
    cards: [...cards.values()].sort((a, b) => a.slot - b.slot),
    settings: Object.fromEntries(settings),
  };
  for (const [k, [before, after]] of Object.entries(patch.layout || {}) as [typeof LAYOUT_KEYS[number], [unknown, unknown]][]) {
    if (!same(current[k], after)) return null;
    (out as unknown as Record<string, unknown>)[k] = before;
  }
  return out;
}

// Rebasing unsent changes onto a newer pull. A conflict: an item both the gate and the working copy changed
// differently since the old base (resident by directory code, card by slot, setting by key). The working copy keeps
// its value until someone chooses Keep mine or Take the gate's.
export type ConflictKind = 'resident' | 'card' | 'setting';
export interface Conflict { kind: ConflictKind; key: string; label: string }
// One unsent change to put back: the item's value (null = removed).
export interface ItemChange { kind: ConflictKind; key: string; label: string; value: ResidentValues | GateCard | string | null }
export interface RebasePlan { gate: WorkingState; changes: ItemChange[]; conflicts: Conflict[]; fromGate: number; layoutChanged: boolean }

const residentKey = (r: ResidentValues | null) => r && Object.fromEntries([...VALUE_FIELDS, 'directoryCode'].map((k) => [k, (r as never)[k]]));
// Whether two values of an item are the same (residents compare values, not where they sit in the files).
export function sameItem(kind: ConflictKind, a: unknown, b: unknown): boolean {
  return kind === 'resident' ? same(residentKey(a as ResidentValues | null), residentKey(b as ResidentValues | null)) : same(a, b);
}
const EDITABLE = new Set(GATE_SETTING_FIELDS.filter((f) => f.editable && !f.secret).map((f) => f.key));

// The items of a working copy by kind and key (only editable settings: read-only ones always come from the gate).
export function itemsOf(w: WorkingState): Record<ConflictKind, Map<string, ResidentValues | GateCard | string>> {
  return {
    resident: residentMap(w),
    card: cardMap(w),
    setting: new Map(Object.entries(w.settings).filter(([k]) => EDITABLE.has(k))),
  };
}
function itemLabel(kind: ConflictKind, key: string, ...values: unknown[]): string {
  if (kind === 'card') return `Card slot ${key}`;
  if (kind === 'setting') return GATE_SETTING_FIELDS.find((f) => f.key === key)?.name || key;
  const name = values.map((v) => (v as ResidentValues | null)?.name).find((n) => n && n.trim());
  return `Directory code ${key}${name ? ` (${name})` : ''}`;
}

// Works out how to put the unsent changes (oldBase -> mine) on top of a newer pull (gate). Per item: unchanged in the
// working copy -> the gate's; changed only in the working copy, or both to the same -> the working copy's; changed
// differently on both -> a conflict, keeping the working copy's. Earlier conflicts stay while their item still
// differs from the gate. layoutChanged: the directory code digits or area-code mode changed on either side, so the
// changes can't be put back item by item (the caller takes the gate's version).
export function rebasePlan(oldBase: WorkingState, mine: WorkingState, gate: WorkingState, earlier: Conflict[] = []): RebasePlan {
  const layoutChanged = oldBase.dirDigits !== gate.dirDigits || oldBase.areaCodeMode !== gate.areaCodeMode
    || oldBase.dirDigits !== mine.dirDigits || oldBase.areaCodeMode !== mine.areaCodeMode;
  const plan: RebasePlan = { gate, changes: [], conflicts: [], fromGate: 0, layoutChanged };
  if (layoutChanged) return plan;
  const [b, m, g] = [itemsOf(oldBase), itemsOf(mine), itemsOf(gate)];
  for (const kind of ['resident', 'card', 'setting'] as const) {
    for (const key of new Set([...b[kind].keys(), ...m[kind].keys(), ...g[kind].keys()])) {
      const [vb, vm, vg] = [b[kind].get(key) ?? null, m[kind].get(key) ?? null, g[kind].get(key) ?? null];
      if (sameItem(kind, vm, vb)) {
        if (!sameItem(kind, vg, vb)) plan.fromGate++;
        continue;
      }
      if (sameItem(kind, vm, vg)) continue;
      const label = itemLabel(kind, key, vm, vg, vb);
      plan.changes.push({ kind, key, label, value: vm });
      const conflicted = !sameItem(kind, vg, vb) || earlier.some((c) => c.kind === kind && c.key === key);
      if (conflicted) plan.conflicts.push({ kind, key, label });
    }
  }
  return plan;
}

// A working copy with one item set (null removes it). A resident keeps the gate's place in the files when it has one.
export function withItem(w: WorkingState, kind: ConflictKind, key: string, value: ResidentValues | GateCard | string | null): WorkingState {
  if (kind === 'setting') return { ...w, settings: { ...w.settings, [key]: value as string } };
  if (kind === 'card') {
    const cards = w.cards.filter((c) => String(c.slot) !== key);
    return { ...w, cards: (value ? [...cards, value as GateCard] : cards).sort((a, c) => a.slot - c.slot) };
  }
  const at = w.residents.find((r) => r.directoryCode === key);
  const rest = w.residents.filter((r) => r.directoryCode !== key);
  if (!value) return { ...w, residents: rest };
  const r = { ...(value as ResidentValues), entryOffset: at?.entryOffset, recordOffset: at?.recordOffset };
  return { ...w, residents: [...rest, r].sort((a, c) => a.directoryCode.localeCompare(c.directoryCode)) };
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Name', type: 'Type', hidden: 'Hidden', areaCode: 'Area code', phone: 'Phone', entryCode: 'Entry code',
  securityLevel: 'Security level', floor: 'Floor', elevatorRef: 'Elevator', cardNumber: 'Card', directoryCode: 'Directory code',
};
// How the gate's and the working copy's values of a conflicted item differ, in words: { gate, mine }.
export function describeConflict(kind: ConflictKind, gate: unknown, mine: unknown): { gate: string; mine: string } {
  if (gate == null || mine == null) {
    const what = (v: unknown) => (kind === 'setting' ? `"${v}"` : kind === 'card' ? `card ${(v as GateCard).cardNumber}`
      : (v as ResidentValues).name || '(empty slot)');
    return { gate: gate == null ? 'removed' : what(gate), mine: mine == null ? 'removed' : what(mine) };
  }
  if (kind === 'setting') return { gate: `"${gate}"`, mine: `"${mine}"` };
  const fields = Object.keys(FIELD_LABELS).filter((k) => k in (gate as object) && !same((gate as never)[k], (mine as never)[k]));
  const text = (v: unknown) => fields.map((k) => `${FIELD_LABELS[k]} ${JSON.stringify((v as never)[k] ?? '')}`).join(', ');
  return { gate: text(gate), mine: text(mine) };
}

// Offsets (hex) where two buffers differ, and how many.
function differences(a: Buffer, b: Buffer): { bytes: number; offsets: number[] } {
  if (a.length !== b.length) return { bytes: Math.max(a.length, b.length), offsets: [] };
  const offsets: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) offsets.push(i);
  return { bytes: offsets.length, offsets };
}
const hex = (n: number) => `0x${n.toString(16)}`;

// Where two sets of files differ: [{ file, bytes, offsets }] (empty when they're the same).
export function fileDifferences(a: BoardBuffers, b: BoardBuffers): RoundTripProblem[] {
  return (['names', 'phone', 'cards'] as const).map((n) => ({ n, d: differences(a[n], b[n]) })).filter((x) => x.d.bytes)
    .map(({ n, d }) => ({ file: `${n}.bin`, bytes: d.bytes, offsets: d.offsets.slice(0, MAX_OFFSETS).map(hex) }));
}

// Writes every decoded value back over scrambled decoded bytes and compares the result with the pull.
// carried: settings the app only reads (kept as pulled).
export function checkRoundTrip(pulled: BoardBuffers, opts: EditOptions = {}): RoundTrip {
  const problems: RoundTripProblem[] = [];
  let names = Buffer.from(pulled.names);
  const phone = Buffer.from(pulled.phone);

  // Settings the files are built from (read-only ones too), then the extra bytes.
  const values = new Map(decodeGateSettings(pulled.names).map((s) => [s.key, s.value]));
  for (const f of written) names.fill(SCRAMBLE, f.offset, f.offset + f.type.size);
  for (const f of written) {
    try { f.type.encode!(values.get(f.key)!).copy(names, f.offset); } catch (e) {
      problems.push({ file: 'names.bin', bytes: f.type.size, offsets: [hex(f.offset)], settings: [f.key], error: (e as Error).message });
    }
  }
  const extra = extraBytes(pulled.names);
  for (const [off, h] of Object.entries(extra)) names.fill(SCRAMBLE, parseInt(off, 16), parseInt(off, 16) + h.length / 2);
  writeExtra(names, extra);

  // Residents: name and flag bits (vendor, shown) in names.bin, bytes 2-9 of each phone record.
  const { rows } = residentRows(pulled);
  const placed = rows.filter((r) => r.entryOffset !== null && r.recordOffset !== null);
  for (const r of placed) {
    names.fill(SCRAMBLE, r.entryOffset!, r.entryOffset! + 15);
    names[r.entryOffset! + 15] ^= 0x21;
    phone.fill(SCRAMBLE, r.recordOffset! + 2, r.recordOffset! + 10);
  }
  let bufs: BoardBuffers = { names, phone, cards: pulled.cards };
  for (const r of placed) {
    try { bufs = applyResidentEdit(bufs, editOf(r), opts); } catch (e) {
      problems.push({ file: 'phone.bin', bytes: 0, offsets: [hex(r.recordOffset!)], error: `Directory code ${r.directoryCode}: ${(e as Error).message}` });
    }
  }

  // The middle-entry pointer (0xF8-0xFA) follows the directory; edits only recompute it when the directory changes
  // (withPointer in residents-edit.ts), so with the area-code table and directory rebuilt exactly the pulled
  // pointer is kept.
  if (pulled.names.subarray(DIRECTORY_REGION).equals(bufs.names.subarray(DIRECTORY_REGION))) {
    pulled.names.copy(bufs.names, MIDDLE_POINTER, MIDDLE_POINTER, MIDDLE_POINTER + 3);
  }

  // Cards: built from their slots.
  const out: BoardBuffers = { names: bufs.names, phone: bufs.phone, cards: buildCards(pulled.cards.length, cardSlots(pulled.cards)) };
  problems.push(...labelled(pulled, out));
  const carried = GATE_SETTING_FIELDS.filter((f) => !written.includes(f)).map((f) => f.key);
  return { ok: !problems.length, problems, carried };
}

// Records the round-trip check and the rebuild-from-values check (checkRebuild; opts.masterCode: the gate's) of a
// pull in gate_state. Returns both.
export async function checkPull(store: Store, phone: unknown, pulled: BoardBuffers, pulledAt: Date, opts: BuildOptions = {}):
  Promise<RoundTrip & { rebuild: RebuildCheck }> {
  const { masterCode, ...editOpts } = opts;
  const check = checkRoundTrip(pulled, editOpts);
  const rebuild = checkRebuild(pulled, { ...editOpts, masterCode });
  await run(store, `INSERT INTO gate_state (phone, pulled_at, checked_at, round_trip_ok, problems, rebuild_ok, rebuild_problems)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (phone) DO UPDATE SET pulled_at = excluded.pulled_at, checked_at = excluded.checked_at,
    round_trip_ok = excluded.round_trip_ok, problems = excluded.problems, rebuild_ok = excluded.rebuild_ok,
    rebuild_problems = excluded.rebuild_problems`,
  [phoneDigits(phone), pulledAt.toISOString(), new Date().toISOString(), check.ok, JSON.stringify(check.problems), rebuild.ok,
    JSON.stringify(rebuild.problems)]);
  return { ...check, rebuild };
}

const FIELD_BY_KEY = new Map(GATE_SETTING_FIELDS.map((f) => [f.key, f]));
const settingRows = (settings: Record<string, string>): string => JSON.stringify(Object.entries(settings)
  .map(([key, value]) => ({ key, grp: FIELD_BY_KEY.get(key)!.group, name: FIELD_BY_KEY.get(key)!.name, value })));

// Adds setting rows the working copy doesn't have yet; existing rows stay. Returns how many were added.
export async function addSettingRows(store: Store, phone: unknown, settings: Record<string, string>): Promise<number> {
  return run(store, `INSERT INTO gate_settings (phone, key, grp, name, value)
    SELECT $1, key, grp, name, value FROM jsonb_to_recordset($2) AS t(key text, grp text, name text, value text)
    ON CONFLICT (phone, key) DO NOTHING`, [phoneDigits(phone), settingRows(settings)]);
}

// Saves the working copy's values (replacing the gate's earlier rows). baseOk: the base passed the round-trip check.
export async function saveWorkingState(store: Store, phone: unknown, w: WorkingState, { baseOk, savedAt = new Date() }:
  { baseOk: boolean; savedAt?: Date }): Promise<void> {
  const p = phoneDigits(phone);
  await transaction(store, async (tx) => {
    for (const t of ['gate_residents', 'gate_cards', 'gate_settings']) await run(tx, `DELETE FROM ${t} WHERE phone = $1`, [p]);
    await run(tx, `INSERT INTO gate_residents (phone, seq, directory_code, type, name, hidden, area_code, phone_number, entry_code,
      security_level, floor, elevator_ref, entry_offset, record_offset)
      SELECT $1, seq, directory_code, type, name, hidden, area_code, phone_number, entry_code, security_level, floor, elevator_ref,
        entry_offset, record_offset
      FROM jsonb_to_recordset($2) AS t(seq int, directory_code text, type text, name text, hidden boolean, area_code text,
        phone_number text, entry_code text, security_level int, floor int, elevator_ref int, entry_offset int, record_offset int)`,
    [p, JSON.stringify(w.residents.map((r, i) => ({
      seq: i + 1, directory_code: r.directoryCode, type: r.type, name: r.name, hidden: r.hidden, area_code: r.areaCode,
      phone_number: r.phone, entry_code: r.entryCode, security_level: r.securityLevel === '' ? null : r.securityLevel,
      floor: r.floor === '' ? null : r.floor, elevator_ref: r.elevatorRef === '' ? null : r.elevatorRef,
      entry_offset: r.entryOffset ?? null, record_offset: r.recordOffset ?? null,
    })))]);
    await run(tx, `INSERT INTO gate_cards (phone, slot, card_number, directory_code, raw_code)
      SELECT $1, slot, card_number, directory_code, raw_code
      FROM jsonb_to_recordset($2) AS t(slot int, card_number text, directory_code text, raw_code text)`,
    [p, JSON.stringify(w.cards.map((c) => ({ slot: c.slot, card_number: c.cardNumber, directory_code: c.directoryCode, raw_code: c.rawCode ?? null })))]);
    await run(tx, `INSERT INTO gate_settings (phone, key, grp, name, value)
      SELECT $1, key, grp, name, value FROM jsonb_to_recordset($2) AS t(key text, grp text, name text, value text)`,
    [p, settingRows(w.settings)]);
    await run(tx, `INSERT INTO gate_working (phone, dir_digits, area_code_mode, area_codes, middle_pointer, base_ok, saved_at, extra, sizes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (phone) DO UPDATE SET dir_digits = excluded.dir_digits, area_code_mode = excluded.area_code_mode,
      area_codes = excluded.area_codes, middle_pointer = excluded.middle_pointer, base_ok = excluded.base_ok, saved_at = excluded.saved_at,
      extra = excluded.extra, sizes = excluded.sizes`,
    [p, w.dirDigits, w.areaCodeMode, JSON.stringify(w.areaCodes), w.middlePointer, baseOk, savedAt.toISOString(),
      w.extra ? JSON.stringify(w.extra) : null, w.sizes ? JSON.stringify(w.sizes) : null]);
  });
}

interface ResidentDbRow {
  directory_code: string; type: 'Resident' | 'Vendor'; name: string; hidden: boolean; area_code: string; phone_number: string;
  entry_code: string; security_level: number | null; floor: number | null; elevator_ref: number | null;
  entry_offset: number | null; record_offset: number | null;
}

// The working copy's values, { baseOk, savedAt, conflicts }, or null when there is none.
export async function loadWorkingState(store: Store, phone: unknown):
  Promise<{ state: WorkingState; baseOk: boolean; savedAt: Date; conflicts: Conflict[] } | null> {
  const p = phoneDigits(phone);
  const head = await one<{ dir_digits: number; area_code_mode: number; area_codes: (string | null)[]; middle_pointer: string;
    base_ok: boolean; saved_at: string; extra: Record<string, string> | null; sizes: WorkingState['sizes'] | null; conflicts: Conflict[] }>(store,
    'SELECT dir_digits, area_code_mode, area_codes, middle_pointer, base_ok, saved_at, extra, sizes, conflicts FROM gate_working WHERE phone = $1', [p]);
  if (!head) return null;
  const [res, cards, settings] = await Promise.all([
    all<ResidentDbRow>(store, 'SELECT * FROM gate_residents WHERE phone = $1 ORDER BY seq', [p]),
    all<{ slot: number; card_number: string; directory_code: string | null; raw_code: string | null }>(store,
      'SELECT slot, card_number, directory_code, raw_code FROM gate_cards WHERE phone = $1 ORDER BY slot', [p]),
    all<{ key: string; value: string }>(store, 'SELECT key, value FROM gate_settings WHERE phone = $1', [p]),
  ]);
  return {
    baseOk: head.base_ok,
    savedAt: new Date(head.saved_at),
    conflicts: head.conflicts,
    state: {
      dirDigits: head.dir_digits,
      areaCodeMode: head.area_code_mode,
      areaCodes: head.area_codes,
      middlePointer: head.middle_pointer,
      residents: res.map((r) => ({
        directoryCode: r.directory_code, type: r.type, name: r.name, hidden: r.hidden, areaCode: r.area_code, phone: r.phone_number,
        entryCode: r.entry_code, securityLevel: r.security_level ?? '', floor: r.floor ?? '', elevatorRef: r.elevator_ref ?? '',
        entryOffset: r.entry_offset, recordOffset: r.record_offset,
      })),
      cards: cards.map((c) => ({ slot: c.slot, cardNumber: c.card_number, directoryCode: c.directory_code,
        ...(c.raw_code && { rawCode: c.raw_code }) })),
      settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
      ...(head.extra && { extra: head.extra }),
      ...(head.sizes && { sizes: head.sizes }),
    },
  };
}

// Replaces the working copy's list of conflicts (saving values leaves it as it is).
export async function setConflicts(store: Store, phone: unknown, conflicts: Conflict[]): Promise<void> {
  await run(store, 'UPDATE gate_working SET conflicts = $2 WHERE phone = $1', [phoneDigits(phone), JSON.stringify(conflicts)]);
}

// Removes the working copy's values.
export async function deleteWorkingState(store: Store, phone: unknown): Promise<void> {
  const p = phoneDigits(phone);
  await transaction(store, async (tx) => {
    for (const t of ['gate_residents', 'gate_cards', 'gate_settings', 'gate_working']) await run(tx, `DELETE FROM ${t} WHERE phone = $1`, [p]);
  });
}

// rebuildOk / rebuildProblems: null for pulls checked before 2026-11-13.
export interface GateState {
  pulledAt: string; checkedAt: string; roundTripOk: boolean; problems: RoundTripProblem[];
  rebuildOk: boolean | null; rebuildProblems: RoundTripProblem[] | null;
}

// The round-trip and rebuild checks of the gate's latest pull, or null.
export async function getGateState(store: Store, phone: unknown): Promise<GateState | null> {
  const r = await one<{ pulled_at: string; checked_at: string; round_trip_ok: boolean; problems: RoundTripProblem[];
    rebuild_ok: boolean | null; rebuild_problems: RoundTripProblem[] | null }>(store,
    'SELECT pulled_at, checked_at, round_trip_ok, problems, rebuild_ok, rebuild_problems FROM gate_state WHERE phone = $1', [phoneDigits(phone)]);
  return r ? { pulledAt: r.pulled_at, checkedAt: r.checked_at, roundTripOk: r.round_trip_ok, problems: r.problems,
    rebuildOk: r.rebuild_ok, rebuildProblems: r.rebuild_problems } : null;
}

// Counts of the gate's working-copy rows (residents, cards, settings).
export async function gateStateCounts(store: Store, phone: unknown): Promise<Record<string, number>> {
  const p = phoneDigits(phone);
  const out: Record<string, number> = {};
  for (const t of ['gate_residents', 'gate_cards', 'gate_settings']) {
    out[t] = (await all<{ n: number }>(store, `SELECT COUNT(*) AS n FROM ${t} WHERE phone = $1`, [p]))[0].n;
  }
  return out;
}
