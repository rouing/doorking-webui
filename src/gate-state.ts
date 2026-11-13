// The gate's working copy as plain values, and the board files built from them.
//
// Tables (all keyed by the gate's phone number; the values are the text the app shows):
//   gate_residents  one row per directory code (name, type, hidden, phone, entry code, security level, …)
//   gate_cards      one row per used card slot (card number, directory code)
//   gate_settings   one row per names.bin setting (the master code left out)
//   gate_working    the directory code digits, area-code layout and table, the directory's middle-entry pointer, and
//                   whether the base passed the round-trip check
//   gate_state      the round-trip check of the latest pull
// The board files to show, compare or send are built from the base copy (gate_files, what the gate holds) and these
// values: buildFiles. Bytes nothing decodes come from the base copy.
//
// Round-trip check: the decoded values are written back into a copy of the pulled files whose decoded bytes were
// first overwritten, and the copy must come out byte for byte the same as the pull. That shows the files can be
// built from these values.
import { namesDirDigits, namesLayout, parseNamesBin, residentRows } from './board-files.ts';
import { all, one, run, transaction, type Store } from './db.ts';
import { GATE_SETTING_FIELDS, applyGateSettings, decodeGateSettings } from './gate-settings.ts';
import {
  addEntry, applyResidentEdit, convertAreaCodeMode, convertDirDigits, encodeBcd, removeDirectoryCode,
  type BoardBuffers, type EditOptions,
} from './residents-edit.ts';
import type { ResidentRow } from './types.ts';

const CARD_SIZE = 4;
const SCRAMBLE = 0xaa;
const MAX_OFFSETS = 10;
const MIDDLE_POINTER = 0xf8;
const DIR_ENTRY_SIZE = 20;
const DIRECTORY_REGION = 0xc00; // where the area-code table and directory start (in either layout)
const phoneDigits = (phone: unknown): string => String(phone || '').replace(/\D/g, '');
const fail = (msg: string, status: number) => Object.assign(new Error(msg), { status });

// rawCode: the record's bytes 2-3 as hex when they aren't a directory code (e.g. a mass-enabled AB record).
export interface GateCard { slot: number; cardNumber: string; directoryCode: string | null; rawCode?: string }
export interface RoundTripProblem { file: string; bytes: number; offsets: string[]; settings?: string[]; error?: string }
export interface RoundTrip { ok: boolean; problems: RoundTripProblem[]; carried: string[] }
export type ResidentValues = Pick<ResidentRow, 'directoryCode' | 'name' | 'type' | 'hidden' | 'areaCode' | 'phone' | 'entryCode'
  | 'securityLevel' | 'floor' | 'elevatorRef'> & Partial<Pick<ResidentRow, 'entryOffset' | 'recordOffset'>>;
// The working copy as values.
// areaCodes: the area-code table, one entry per slot (null = free); middlePointer: names.bin 0xF8-0xFA as hex.
export interface WorkingState {
  dirDigits: number;
  areaCodeMode: number;
  areaCodes: (string | null)[];
  middlePointer: string;
  residents: ResidentValues[];
  cards: GateCard[];
  settings: Record<string, string>;
}

const VALUE_FIELDS = ['name', 'type', 'hidden', 'areaCode', 'phone', 'entryCode', 'securityLevel', 'floor', 'elevatorRef'] as const;
const editable = GATE_SETTING_FIELDS.filter((f) => f.editable && !f.secret);

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

// The board files of a working copy: the base files with the values written over them. Steps, in this order:
// directory code digits; the area-code table (when the layout is unchanged); directory codes removed, resident
// values that differ, codes added; the area-code layout and then its table (when the layout changed); settings that
// differ; the directory order and middle-entry pointer; cards.bin from its slots.
export function buildFiles(base: BoardBuffers, w: WorkingState, opts: EditOptions = {}): BoardBuffers {
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
  for (const r of w.residents) if (!have.has(r.directoryCode)) bufs = addEntry(bufs, editOf(r), opts);
  if (!sameLayout) {
    bufs = convertAreaCodeMode(bufs, w.areaCodeMode);
    writeAreaCodes(bufs.names, w.areaCodes);
  }
  const names = Buffer.from(bufs.names);
  for (const f of editable) {
    const v = w.settings[f.key];
    if (v === undefined || v === f.type.decode(names.subarray(f.offset, f.offset + f.type.size))) continue;
    try { f.type.encode!(v).copy(names, f.offset); } catch (e) { throw fail(`${f.name}: ${(e as Error).message}`, 400); }
  }
  orderDirectory(names, w.residents);
  Buffer.from(w.middlePointer, 'hex').copy(names, MIDDLE_POINTER);
  return { names, phone: bufs.phone, cards: buildCards(base.cards.length, w.cards) };
}

// A change to a working copy as values, for History and Revert: per resident (directory code), card slot, setting
// and layout value, [before, after] (null = absent). Only what changed is listed.
export interface ValuesPatch {
  residents?: Record<string, [ResidentValues | null, ResidentValues | null]>;
  cards?: Record<string, [GateCard | null, GateCard | null]>;
  settings?: Record<string, [string | null, string | null]>;
  layout?: Partial<Record<'dirDigits' | 'areaCodeMode' | 'areaCodes' | 'middlePointer', [unknown, unknown]>>;
}
const LAYOUT_KEYS = ['dirDigits', 'areaCodeMode', 'areaCodes', 'middlePointer'] as const;

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

  // Settings: editable, non-secret fields.
  const values = new Map(decodeGateSettings(pulled.names).map((s) => [s.key, s.value]));
  for (const f of editable) names.fill(SCRAMBLE, f.offset, f.offset + f.type.size);
  for (const f of editable) {
    try { names = applyGateSettings(names, { [f.key]: values.get(f.key) }).buffer; } catch (e) {
      problems.push({ file: 'names.bin', bytes: f.type.size, offsets: [hex(f.offset)], settings: [f.key], error: (e as Error).message });
    }
  }

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
  for (const p of fileDifferences(pulled, out)) {
    const covering = p.file === 'names.bin'
      ? [...new Set(differences(pulled.names, out.names).offsets
        .flatMap((o) => GATE_SETTING_FIELDS.filter((f) => o >= f.offset && o < f.offset + f.type.size).map((f) => f.key)))]
      : [];
    problems.push({ ...p, ...(covering.length && { settings: covering.slice(0, MAX_OFFSETS) }) });
  }
  const carried = GATE_SETTING_FIELDS.filter((f) => !f.editable || f.secret).map((f) => f.key);
  return { ok: !problems.length, problems, carried };
}

// Records the round-trip check of a pull in gate_state. Returns the check.
export async function checkPull(store: Store, phone: unknown, pulled: BoardBuffers, pulledAt: Date, opts: EditOptions = {}): Promise<RoundTrip> {
  const check = checkRoundTrip(pulled, opts);
  await run(store, `INSERT INTO gate_state (phone, pulled_at, checked_at, round_trip_ok, problems) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone) DO UPDATE SET pulled_at = excluded.pulled_at, checked_at = excluded.checked_at,
    round_trip_ok = excluded.round_trip_ok, problems = excluded.problems`,
  [phoneDigits(phone), pulledAt.toISOString(), new Date().toISOString(), check.ok, JSON.stringify(check.problems)]);
  return check;
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
    const names = new Map(GATE_SETTING_FIELDS.map((f) => [f.key, f]));
    await run(tx, `INSERT INTO gate_settings (phone, key, grp, name, value)
      SELECT $1, key, grp, name, value FROM jsonb_to_recordset($2) AS t(key text, grp text, name text, value text)`,
    [p, JSON.stringify(Object.entries(w.settings).map(([key, value]) => ({ key, grp: names.get(key)!.group, name: names.get(key)!.name, value })))]);
    await run(tx, `INSERT INTO gate_working (phone, dir_digits, area_code_mode, area_codes, middle_pointer, base_ok, saved_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (phone) DO UPDATE SET dir_digits = excluded.dir_digits, area_code_mode = excluded.area_code_mode,
      area_codes = excluded.area_codes, middle_pointer = excluded.middle_pointer, base_ok = excluded.base_ok, saved_at = excluded.saved_at`,
    [p, w.dirDigits, w.areaCodeMode, JSON.stringify(w.areaCodes), w.middlePointer, baseOk, savedAt.toISOString()]);
  });
}

interface ResidentDbRow {
  directory_code: string; type: 'Resident' | 'Vendor'; name: string; hidden: boolean; area_code: string; phone_number: string;
  entry_code: string; security_level: number | null; floor: number | null; elevator_ref: number | null;
  entry_offset: number | null; record_offset: number | null;
}

// The working copy's values, { baseOk, savedAt }, or null when there is none.
export async function loadWorkingState(store: Store, phone: unknown):
  Promise<{ state: WorkingState; baseOk: boolean; savedAt: Date } | null> {
  const p = phoneDigits(phone);
  const head = await one<{ dir_digits: number; area_code_mode: number; area_codes: (string | null)[]; middle_pointer: string;
    base_ok: boolean; saved_at: string }>(store,
    'SELECT dir_digits, area_code_mode, area_codes, middle_pointer, base_ok, saved_at FROM gate_working WHERE phone = $1', [p]);
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
    },
  };
}

// Removes the working copy's values.
export async function deleteWorkingState(store: Store, phone: unknown): Promise<void> {
  const p = phoneDigits(phone);
  await transaction(store, async (tx) => {
    for (const t of ['gate_residents', 'gate_cards', 'gate_settings', 'gate_working']) await run(tx, `DELETE FROM ${t} WHERE phone = $1`, [p]);
  });
}

export interface GateState { pulledAt: string; checkedAt: string; roundTripOk: boolean; problems: RoundTripProblem[] }

// The round-trip check of the gate's latest pull, or null.
export async function getGateState(store: Store, phone: unknown): Promise<GateState | null> {
  const r = await one<{ pulled_at: string; checked_at: string; round_trip_ok: boolean; problems: RoundTripProblem[] }>(store,
    'SELECT pulled_at, checked_at, round_trip_ok, problems FROM gate_state WHERE phone = $1', [phoneDigits(phone)]);
  return r ? { pulledAt: r.pulled_at, checkedAt: r.checked_at, roundTripOk: r.round_trip_ok, problems: r.problems } : null;
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
