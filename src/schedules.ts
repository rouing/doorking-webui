// Scheduled transfers (DoorKing32's Scheduled Transfers, reworked): each gate has its own list of entries, each
// with days of the week, a time (server local time, 24-hour HH:MM) and the transfers to run. Entries run with the
// gate's DKS login (gate-list.ts); `user` is who last saved the entry. A time missed while the server was stopped
// runs once at the next check, like DoorKing32's past-due jobs.
import crypto from 'node:crypto';
import { all, one, run } from './db.ts';
import type { Store } from './db.ts';
import type { Schedule, ScheduleAction, ScheduleInput } from './types.ts';

// Transfers in the order they run: send first (it ends with a check pull of residents), then the pulls, then
// camera snapshots.
export const SCHEDULE_ACTIONS: ScheduleAction[] = ['send', 'residents', 'transactions', 'snapshots'];

interface ScheduleRow {
  id: string; phone: string; username: string; data: ScheduleInput; created_at: string;
  last_due: string | null; last_run: string | null; last_result: string | null; last_error: string | null;
}

type Timed = Pick<ScheduleInput, 'days' | 'time'>;
type RunFields = Partial<Record<'lastDue' | 'lastRun' | 'lastResult' | 'lastError', unknown>>;

const phoneDigits = (phone: unknown): string => String(phone || '').replace(/\D/g, '');
const fail = (msg: string, status: number) => Object.assign(new Error(msg), { status });

// Returns { schedule: { days, time, actions, enabled } } or { error }. days: 0-6 = Sun-Sat.
export function normalizeSchedule(body: unknown): { schedule: ScheduleInput; error?: undefined } | { schedule?: undefined; error: string } {
  const b = (body || {}) as { days?: unknown; time?: unknown; actions?: unknown; enabled?: unknown };
  const days = [...new Set((Array.isArray(b.days) ? b.days : []).map(Number))]
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  if (!days.length) return { error: 'Pick at least one day' };
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(b.time || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { error: 'Time must be HH:MM (24-hour)' };
  const actions = SCHEDULE_ACTIONS.filter((a) => Array.isArray(b.actions) && b.actions.includes(a));
  if (!actions.length) return { error: 'Pick at least one transfer' };
  const time = `${m[1].padStart(2, '0')}:${m[2]}`;
  return { schedule: { days, time, actions, enabled: b.enabled !== false } };
}

// The schedule's time on the day `offset` days from `now`'s date.
function at(s: Timed, now: Date, offset: number): Date {
  const [h, m] = s.time.split(':').map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, h, m, 0, 0);
}

// The latest time at or before `now` the schedule was due, or null.
export function lastDue(s: Timed, now: Date = new Date()): Date | null {
  for (let i = 0; i >= -7; i--) {
    const d = at(s, now, i);
    if (d <= now && s.days.includes(d.getDay())) return d;
  }
  return null;
}

// The next time after `now` the schedule is due, or null.
export function nextDue(s: Timed, now: Date = new Date()): Date | null {
  for (let i = 0; i <= 7; i++) {
    const d = at(s, now, i);
    if (d > now && s.days.includes(d.getDay())) return d;
  }
  return null;
}

// Due when enabled and its latest due time is after the one last handled (set to the save time on each save,
// so a new or edited entry waits for its next time).
export function scheduleIsDue(s: Timed & { enabled?: boolean; lastDue?: string | null }, now: Date = new Date()): boolean {
  if (!s.enabled) return false;
  const d = lastDue(s, now);
  return Boolean(d) && d! > new Date(s.lastDue || 0);
}

function fromRow(r: ScheduleRow, now: Date = new Date()): Schedule {
  const s = { id: r.id, phoneNumber: r.phone, user: r.username, ...r.data, createdAt: r.created_at,
    lastDue: r.last_due, lastRun: r.last_run, lastResult: r.last_result, lastError: r.last_error };
  const next = s.enabled ? nextDue(s, now) : null;
  return { ...s, nextRun: next ? next.toISOString() : null };
}

// All entries (phone omitted) or one gate's, ordered by time.
export async function listSchedules(store: Store, phone?: unknown): Promise<Schedule[]> {
  const rows = phone
    ? await all<ScheduleRow>(store, 'SELECT * FROM schedules WHERE phone = $1 ORDER BY created_at', [phoneDigits(phone)])
    : await all<ScheduleRow>(store, 'SELECT * FROM schedules ORDER BY created_at');
  return rows.map((r) => fromRow(r)).sort((a, b) => a.time.localeCompare(b.time));
}

export async function getSchedule(store: Store, phone: unknown, id: unknown): Promise<Schedule | null> {
  const r = await one<ScheduleRow>(store, 'SELECT * FROM schedules WHERE phone = $1 AND id = $2', [phoneDigits(phone), String(id)]);
  return r ? fromRow(r) : null;
}

// Creates (no id) or replaces an entry; `user` becomes its owner. Throws 400 on bad input, 404 on unknown id.
export async function saveSchedule(store: Store, phone: unknown, user: unknown, body: unknown, id: string | null = null): Promise<Schedule | null> {
  const { schedule, error } = normalizeSchedule(body);
  if (error !== undefined) throw fail(error, 400);
  const now = new Date().toISOString();
  const data = JSON.stringify(schedule);
  if (id) {
    const changes = await run(store, 'UPDATE schedules SET username = $1, data = $2, last_due = $3 WHERE phone = $4 AND id = $5',
      [String(user), data, now, phoneDigits(phone), String(id)]);
    if (!changes) throw fail('Schedule not found', 404);
  } else {
    id = crypto.randomBytes(8).toString('hex');
    await run(store, 'INSERT INTO schedules (id, phone, username, data, created_at, last_due) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, phoneDigits(phone), String(user), data, now, now]);
  }
  return getSchedule(store, phone, id);
}

export async function deleteSchedule(store: Store, phone: unknown, id: unknown): Promise<void> {
  const changes = await run(store, 'DELETE FROM schedules WHERE phone = $1 AND id = $2', [phoneDigits(phone), String(id)]);
  if (!changes) throw fail('Schedule not found', 404);
}

// Updates the run fields: lastDue, lastRun, lastResult, lastError (only those given).
export async function updateScheduleRun(store: Store, id: unknown, fields: RunFields): Promise<void> {
  const cols = { lastDue: 'last_due', lastRun: 'last_run', lastResult: 'last_result', lastError: 'last_error' } as const;
  const keys = (Object.keys(cols) as (keyof typeof cols)[]).filter((k) => k in fields);
  if (!keys.length) return;
  await run(store, `UPDATE schedules SET ${keys.map((k, i) => `${cols[k]} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`,
    [...keys.map((k) => (fields[k] == null ? null : String(fields[k]))), String(id)]);
}
