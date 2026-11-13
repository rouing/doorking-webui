// History of who did what on a gate (database table history, one JSON event per row, append-only, keyed by
// the gate's phone number); see db.ts. Working-copy changes carry
// their change as values (gate-state.ts diffStates; before 2026-11-12, a byte patch per file) so they can be
// reverted; a revert is itself an event (revertOf = the id it undid).
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { all, run, type Store } from './db.ts';
import type { HistoryEvent } from './types.ts';

export type Patch =
  | { whole: true; before: string; after: string }
  | { whole?: undefined; runs: [number, string, string][] };

export interface FieldChange { field: string; from: string; to: string }
export interface RecordChange<L = string> { key: string; label: L; change: 'added' | 'removed' | 'changed'; fields: FieldChange[] }

// A stored event: what listHistory returns plus the revert data (values; files on events before 2026-11-12; prefs)
// and any other details.
export interface StoredEvent {
  id: string;
  time: string;
  revertOf?: string;
  values?: unknown;
  files?: unknown;
  prefs?: unknown;
  [k: string]: unknown;
}

const MAX_LIST = 500;
const phoneDigits = (phone: unknown): string => String(phone || '').replace(/\D/g, '');

const pack = (buf: Buffer): string => zlib.deflateRawSync(buf).toString('base64');
const unpack = (s: string): Buffer => zlib.inflateRawSync(Buffer.from(s, 'base64'));

// Patch from `before` to `after`: the changed byte runs as [offset, beforeHex, afterHex]. When the size
// differs (names.bin switching area-code layout), both whole files are kept, compressed.
export function diffBuffers(before: Buffer, after: Buffer): Patch {
  if (before.length !== after.length) return { whole: true, before: pack(before), after: pack(after) };
  const runs: [number, string, string][] = [];
  for (let i = 0; i < after.length; i++) {
    if (before[i] === after[i]) continue;
    let j = i + 1;
    while (j < after.length && before[j] !== after[j]) j++;
    runs.push([i, before.toString('hex', i, j), after.toString('hex', i, j)]);
    i = j;
  }
  return { runs };
}

// Undoes a patch on `current`. Every patched byte must still hold its `after` value; otherwise a later
// change touched the same bytes and null is returned.
export function undoPatch(current: Buffer, patch: Patch): Buffer | null {
  if (patch.whole) return current.equals(unpack(patch.after)) ? unpack(patch.before) : null;
  const out = Buffer.from(current);
  for (const [off, before, after] of patch.runs) {
    const want = Buffer.from(after, 'hex');
    if (off + want.length > current.length || !current.subarray(off, off + want.length).equals(want)) return null;
    Buffer.from(before, 'hex').copy(out, off);
  }
  return out;
}

const shown = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// Field changes between two record lists keyed by `key`:
// [{ key, label, change: 'added'|'removed'|'changed', fields: [{ field, from, to }] }].
export function diffRecords<R extends object, L = string>(
  before: R[], after: R[], key: string, fields: string[], label: (r: R) => L,
): RecordChange<L>[] {
  const get = (r: R, k: string): unknown => (r as Record<string, unknown>)[k];
  const was = new Map(before.map((r) => [get(r, key) as string, r]));
  const now = new Map(after.map((r) => [get(r, key) as string, r]));
  const out: RecordChange<L>[] = [];
  for (const k of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const a = was.get(k);
    const b = now.get(k);
    const list = fields
      .map((field) => ({ field, from: a ? shown(get(a, field)) : '', to: b ? shown(get(b, field)) : '' }))
      .filter((f) => f.from !== f.to);
    if (!list.length) continue;
    out.push({ key: k, label: label((b || a) as R), change: !a ? 'added' : !b ? 'removed' : 'changed', fields: list });
  }
  return out;
}

// The gate's events, oldest first.
export async function readHistory(store: Store, phone: unknown): Promise<StoredEvent[]> {
  return (await all<{ data: StoredEvent }>(store, 'SELECT data FROM history WHERE phone = $1 ORDER BY seq', [phoneDigits(phone)]))
    .map((r) => r.data);
}

export async function addEvent(store: Store, phone: unknown, event: Record<string, unknown>): Promise<StoredEvent> {
  const e: StoredEvent = { id: crypto.randomBytes(8).toString('hex'), time: new Date().toISOString(), ...event };
  await run(store, 'INSERT INTO history (id, phone, data) VALUES ($1, $2, $3)', [e.id, phoneDigits(phone), JSON.stringify(e)]);
  return e;
}

// Newest first, without the patch data. revertedBy names the revert that undid an event.
export async function listHistory(store: Store, phone: unknown, limit = MAX_LIST): Promise<HistoryEvent[]> {
  const events = await readHistory(store, phone);
  const reverts = new Map(events.filter((e) => e.revertOf).map((e) => [e.revertOf, e]));
  return events.reverse().slice(0, limit).map(({ values, files, prefs, ...e }) => {
    const by = reverts.get(e.id);
    return {
      ...e,
      revertible: Boolean(values || files || prefs) && !by,
      revertedBy: by ? { id: by.id, user: by.user as string, time: by.time } : null,
    } as unknown as HistoryEvent;
  });
}
