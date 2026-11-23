/**
 * @module src/portal
 *
 * Resident Self-Service Portal & "Buzz Me In" backend logic:
 * - Per-unit email + portal toggle lifecycle (`syncResidentPortal`) with existing-user binding and zero-residue
 *   turnover wipe (clearing sessions, passkeys, push subscriptions, email tokens, and password when no access remains)
 * - Synthetic "Portal Open" events (`portal_events`) merged on read without altering hardware `tx_history`
 * - Daily-capped entry-code rerolls (`resident_code_rerolls`) + next scheduled send ETA
 * - Resident self-service change requests (`resident_requests`) and suspicious-activity reports (`suspicious_reports`)
 * - Admin login audit log (`login_audit`)
 */
import { all, one, phoneDigits, run, transaction, type Store } from './db.ts';
import { httpError } from './errors.ts';
import { minuteKey } from './camera-log.ts';
import { noteKey } from './notes.ts';
import { listSchedules } from './schedules.ts';
import { DEFAULT_RESIDENT_PORTAL_PREFS } from './shared.ts';
import { checkEmail, createUser, deleteUserCompletely, findUserForPortalBind, uniqueUsernameForEmail, userKey } from './users.ts';
import type {
  LoginAuditEntry,
  PortalEvent,
  ResidentPortalPrefs,
  ResidentRequest,
  SuspiciousReport,
  TransactionRow,
} from './types.ts';

export { DEFAULT_RESIDENT_PORTAL_PREFS };

export interface ResidentPortalRecord {
  phone: string;
  code: string;
  email: string;
  enabled: boolean;
  username: string | null;
  invited: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface SyncResidentPortalParams {
  phone: string;
  code: string;
  email?: unknown;
  enabled?: boolean;
  actor: string;
  remove?: boolean;
}

export interface SyncResidentPortalResult {
  record: ResidentPortalRecord | null;
  action: 'none' | 'saved' | 'invited' | 'bound' | 'revoked' | 'replaced';
  inviteUsername?: string;
  boundUsername?: string;
  wipedPrevious: boolean;
}

export interface RecordPortalEventParams {
  phone: string;
  directoryCode: string;
  username: string;
  relay: number;
  result: string;
  error?: string;
  ts?: Date;
}

export interface CreateResidentRequestParams {
  phone: string;
  directoryCode: string;
  username: string;
  kind: unknown;
  payload?: unknown;
  note?: unknown;
}

export interface ReportSuspiciousParams {
  phone: string;
  directoryCode: string;
  username: string;
  txSource: 'gate' | 'portal';
  txKey: string;
  txTs: string;
  txSummary: string;
  note?: string;
}

export interface RecordLoginAuditParams {
  username?: string | null;
  identifier: string;
  role?: string | null;
  method: string;
  outcome: string;
  reason?: string | null;
  ip: string;
  userAgent?: string;
}

interface PortalRow {
  phone: string;
  code: string;
  email: string;
  enabled: boolean;
  username: string | null;
  invited: boolean;
  updated_by: string;
  updated_at: string;
}

interface PortalEventRow {
  id: number;
  phone: string;
  directory_code: string;
  username: string;
  relay: number;
  event_type: string;
  access: string;
  ts: string;
  result: string;
  error: string | null;
}

interface ResidentRequestRow {
  id: number;
  phone: string;
  directory_code: string;
  username: string;
  kind: ResidentRequest['kind'];
  payload: Record<string, unknown>;
  note: string;
  status: ResidentRequest['status'];
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

interface SuspiciousReportRow {
  id: number;
  phone: string;
  directory_code: string;
  username: string;
  tx_source: 'gate' | 'portal';
  tx_key: string;
  tx_ts: string;
  tx_summary: string;
  note: string;
  status: 'open' | 'resolved';
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

interface LoginAuditRow {
  id: number;
  username: string | null;
  identifier: string;
  role: string | null;
  method: string;
  outcome: string;
  reason: string | null;
  ip: string;
  user_agent: string;
  created_at: string;
}

const fromPortalRow = (row: PortalRow): ResidentPortalRecord => ({
  phone: row.phone,
  code: row.code,
  email: row.email || '',
  enabled: row.enabled,
  username: row.username,
  invited: Boolean(row.invited),
  updatedBy: row.updated_by || '',
  updatedAt: row.updated_at,
});

const fromPortalEventRow = (row: PortalEventRow): PortalEvent => ({
  id: Number(row.id),
  phone: row.phone,
  directoryCode: row.directory_code,
  username: row.username,
  relay: row.relay,
  eventType: row.event_type,
  access: row.access,
  ts: row.ts,
  result: row.result,
  error: row.error,
});

const fromRequestRow = (row: ResidentRequestRow): ResidentRequest => ({
  id: Number(row.id),
  phone: row.phone,
  directoryCode: row.directory_code,
  username: row.username,
  kind: row.kind,
  payload: row.payload || {},
  note: row.note || '',
  status: row.status,
  createdAt: row.created_at,
  reviewedBy: row.reviewed_by,
  reviewedAt: row.reviewed_at,
  reviewNote: row.review_note,
});

const fromReportRow = (row: SuspiciousReportRow): SuspiciousReport => ({
  id: Number(row.id),
  phone: row.phone,
  directoryCode: row.directory_code,
  username: row.username,
  txSource: row.tx_source,
  txKey: row.tx_key,
  txTs: row.tx_ts,
  txSummary: row.tx_summary,
  note: row.note || '',
  status: row.status,
  createdAt: row.created_at,
  reviewedBy: row.reviewed_by,
  reviewedAt: row.reviewed_at,
  reviewNote: row.review_note,
});

const fromLoginAuditRow = (row: LoginAuditRow): LoginAuditEntry => ({
  id: Number(row.id),
  username: row.username,
  identifier: row.identifier,
  role: row.role,
  method: row.method,
  outcome: row.outcome,
  reason: row.reason,
  ip: row.ip,
  userAgent: row.user_agent || '',
  createdAt: row.created_at,
});

/** Normalizes gate `residentPortal` preferences with safe bounds. */
export function normalizeResidentPortalPrefs(raw: unknown): ResidentPortalPrefs {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const relays = Array.isArray(input.buzzRelays)
    ? [...new Set(input.buzzRelays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 18))].sort((a, b) => a - b)
    : DEFAULT_RESIDENT_PORTAL_PREFS.buzzRelays;
  const pulse = Number(input.pulseSeconds);
  const rerolls = Number(input.maxRerollsPerDay);
  return {
    enabled: input.enabled === true,
    buzzEnabled: input.buzzEnabled === true,
    buzzRelays: relays.length ? relays : [0],
    pulseSeconds: Number.isFinite(pulse) ? Math.min(15, Math.max(2, Math.round(pulse))) : DEFAULT_RESIDENT_PORTAL_PREFS.pulseSeconds,
    maxRerollsPerDay: Number.isFinite(rerolls) ? Math.min(10, Math.max(0, Math.round(rerolls))) : DEFAULT_RESIDENT_PORTAL_PREFS.maxRerollsPerDay,
    autoSendReroll: input.autoSendReroll === true,
    showSnapshots: input.showSnapshots === true,
    allowRequests: input.allowRequests !== false,
    requirePasskeyForBuzz: input.requirePasskeyForBuzz === true,
  };
}

/** Loads all resident portal bindings for `phone`, keyed by `noteKey(code)`. */
export async function getResidentPortals(store: Store, phone: string): Promise<Record<string, ResidentPortalRecord>> {
  const rows = await all<PortalRow>(store, `
    SELECT p.phone, p.code, p.email, p.enabled, p.username, (u.password_hash = '!') AS invited, p.updated_by, p.updated_at
    FROM resident_portal p
    LEFT JOIN users u ON u.username = p.username
    WHERE p.phone = $1`, [phoneDigits(phone)]);
  return Object.fromEntries(rows.map((row) => [row.code, fromPortalRow(row)]));
}

/** Loads one resident portal record for `(phone, code)` or `null`. */
export async function getResidentPortal(store: Store, phone: string, code: string): Promise<ResidentPortalRecord | null> {
  const row = await one<PortalRow>(store, `
    SELECT p.phone, p.code, p.email, p.enabled, p.username, (u.password_hash = '!') AS invited, p.updated_by, p.updated_at
    FROM resident_portal p
    LEFT JOIN users u ON u.username = p.username
    WHERE p.phone = $1 AND p.code = $2`, [phoneDigits(phone), noteKey(code)]);
  return row ? fromPortalRow(row) : null;
}

/** Returns every enabled directory code (`noteKey`) bound to `username` on `phone`. */
export async function ownedPortalUnits(store: Store, phone: string, username: string): Promise<string[]> {
  const rows = await all<{ code: string }>(store,
    'SELECT code FROM resident_portal WHERE phone = $1 AND username = $2 AND enabled = TRUE ORDER BY code',
    [phoneDigits(phone), userKey(username)]);
  return rows.map((row) => row.code);
}

/** Returns every `(phone, code)` resident portal unit enabled for `username` across all gates. */
export async function ownedPortalUnitsAllGates(store: Store, username: string): Promise<Array<{ phone: string; code: string }>> {
  return all<{ phone: string; code: string }>(store,
    'SELECT phone, code FROM resident_portal WHERE username = $1 AND enabled = TRUE ORDER BY phone, code',
    [userKey(username)]);
}

/**
 * Revokes `oldUsername`'s resident link on `(phone, code)` and wipes their entire account if no gate/unit access remains.
 */
async function revokeOldResident(tx: Store, phoneKey: string, codeKey: string, oldUsername: string): Promise<{ wiped: boolean }> {
  const name = userKey(oldUsername);
  const otherUnitsOnGate = await one(tx,
    'SELECT 1 AS x FROM resident_portal WHERE phone = $1 AND username = $2 AND enabled = TRUE AND code <> $3 LIMIT 1',
    [phoneKey, name, codeKey]);
  if (!otherUnitsOnGate) {
    await run(tx, "DELETE FROM gate_access WHERE phone = $1 AND username = $2 AND role = 'resident'", [phoneKey, name]);
    await run(tx, 'UPDATE sessions SET gate = NULL WHERE username = $1 AND gate = $2', [name, phoneKey]);
  }
  const anyAccess = await one(tx, 'SELECT 1 AS x FROM gate_access WHERE username = $1 LIMIT 1', [name]);
  const anyUnit = await one(tx,
    'SELECT 1 AS x FROM resident_portal WHERE username = $1 AND enabled = TRUE AND NOT (phone = $2 AND code = $3) LIMIT 1',
    [name, phoneKey, codeKey]);
  if (!anyAccess && !anyUnit) {
    await deleteUserCompletely(tx, name);
    return { wiped: true };
  }
  return { wiped: false };
}

/** Binds an existing confirmed/invited account or creates a new invited account and ensures `'resident'` `gate_access`. */
async function resolveOrCreateResidentUser(
  tx: Store,
  { phoneKey, email, actor, now, replaced }: { phoneKey: string; email: string; actor: string; now: string; replaced: boolean },
): Promise<{ username: string; action: SyncResidentPortalResult['action']; inviteUsername?: string; boundUsername?: string }> {
  const matched = await findUserForPortalBind(tx, email);
  let username: string;
  let inviteUsername: string | undefined;
  let boundUsername: string | undefined;
  let action: SyncResidentPortalResult['action'];
  if (matched) {
    username = matched.username;
    boundUsername = matched.username;
    action = replaced ? 'replaced' : 'bound';
  } else {
    const unique = await uniqueUsernameForEmail(tx, email);
    const created = await createUser(tx, { username: unique, email, createdBy: actor, invite: true });
    username = created.username;
    inviteUsername = created.username;
    action = replaced ? 'replaced' : 'invited';
  }
  await run(tx, `INSERT INTO gate_access (phone, username, role, granted_by, granted_at)
    VALUES ($1, $2, 'resident', $3, $4) ON CONFLICT (phone, username) DO NOTHING`,
  [phoneKey, username, actor, now]);
  return { username, action, inviteUsername, boundUsername };
}

/**
 * Synchronizes a resident's email and Resident Portal access in one atomic transaction.
 */
export async function syncResidentPortal(store: Store, options: SyncResidentPortalParams): Promise<SyncResidentPortalResult> {
  const phoneKey = phoneDigits(options.phone);
  const codeKey = noteKey(options.code);
  if (!codeKey) throw httpError('Directory code is required');
  const actor = userKey(options.actor);
  const now = new Date().toISOString();

  return transaction(store, async (tx) => {
    const existing = await one<{ email: string; enabled: boolean; username: string | null }>(tx,
      'SELECT email, enabled, username FROM resident_portal WHERE phone = $1 AND code = $2 FOR UPDATE', [phoneKey, codeKey]);

    if (options.remove) {
      await run(tx, 'DELETE FROM resident_portal WHERE phone = $1 AND code = $2', [phoneKey, codeKey]);
      if (!existing?.username) return { record: null, action: 'none', wipedPrevious: false };
      const { wiped } = await revokeOldResident(tx, phoneKey, codeKey, existing.username);
      return { record: null, action: 'revoked', wipedPrevious: wiped };
    }

    const nextEmail = options.email !== undefined ? checkEmail(options.email) : (existing?.email || '');
    const wantsEnabled = !nextEmail ? false : options.enabled !== undefined ? Boolean(options.enabled) : Boolean(existing?.enabled);
    const oldUsername = existing?.username || null;
    const emailChanged = Boolean(existing?.email && nextEmail && existing.email !== nextEmail);

    let wipedPrevious = false;
    let action: SyncResidentPortalResult['action'] = 'none';
    if (oldUsername && (!wantsEnabled || emailChanged)) {
      await run(tx, 'UPDATE resident_portal SET enabled = FALSE, username = NULL, updated_by = $3, updated_at = $4 WHERE phone = $1 AND code = $2',
        [phoneKey, codeKey, actor, now]);
      wipedPrevious = (await revokeOldResident(tx, phoneKey, codeKey, oldUsername)).wiped;
      if (!wantsEnabled) action = 'revoked';
    }

    let nextUsername: string | null = wantsEnabled && !emailChanged ? oldUsername : null;
    let inviteUsername: string | undefined;
    let boundUsername: string | undefined;
    if (wantsEnabled && !nextUsername) {
      const resolved = await resolveOrCreateResidentUser(tx, {
        phoneKey, email: nextEmail, actor, now, replaced: Boolean(emailChanged && oldUsername),
      });
      nextUsername = resolved.username;
      action = resolved.action;
      inviteUsername = resolved.inviteUsername;
      boundUsername = resolved.boundUsername;
    }

    if (!nextEmail && !wantsEnabled) {
      await run(tx, 'DELETE FROM resident_portal WHERE phone = $1 AND code = $2', [phoneKey, codeKey]);
      return { record: null, action: action === 'none' && existing ? 'saved' : action, wipedPrevious };
    }

    await run(tx, `INSERT INTO resident_portal (phone, code, email, enabled, username, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (phone, code) DO UPDATE SET email = excluded.email, enabled = excluded.enabled,
      username = excluded.username, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [phoneKey, codeKey, nextEmail, wantsEnabled, nextUsername, actor, now]);

    if (action === 'none' && (existing?.email !== nextEmail || existing?.enabled !== wantsEnabled)) action = 'saved';
    return { record: await getResidentPortal(tx, phoneKey, codeKey), action, inviteUsername, boundUsername, wipedPrevious };
  });
}

/** Records a synthetic "Portal Open" transaction in `portal_events` without disturbing hardware `tx_history`. */
export async function recordPortalEvent(store: Store, entry: RecordPortalEventParams): Promise<PortalEvent> {
  const ts = (entry.ts || new Date()).toISOString();
  const row = (await one<PortalEventRow>(store, `INSERT INTO portal_events (phone, directory_code, username, relay, event_type, access, ts, result, error)
    VALUES ($1, $2, $3, $4, 'Portal Open', $5, $6, $7, $8) RETURNING *`,
  [phoneDigits(entry.phone), entry.directoryCode, userKey(entry.username), entry.relay,
    entry.result === 'done' ? 'Admit' : 'Denied', ts, entry.result, entry.error || null]))!;
  return fromPortalEventRow(row);
}

/** Lists recorded portal open events for a gate, newest first. */
export async function listPortalEvents(
  store: Store,
  phone: string,
  { codes, limit = 500 }: { codes?: string[]; limit?: number } = {},
): Promise<PortalEvent[]> {
  const phoneKey = phoneDigits(phone);
  const rows = codes && codes.length
    ? await all<PortalEventRow>(store, 'SELECT * FROM portal_events WHERE phone = $1 AND directory_code = ANY($2::text[]) ORDER BY ts DESC LIMIT $3',
      [phoneKey, codes, limit])
    : await all<PortalEventRow>(store, 'SELECT * FROM portal_events WHERE phone = $1 ORDER BY ts DESC LIMIT $2', [phoneKey, limit]);
  return rows.map(fromPortalEventRow);
}

/**
 * Converts a `PortalEvent` into a `TransactionRow` matching hardware `tx_history` date (`YYYY-MM-DD`) and time (`H:MM AM/PM`) formats.
 */
export function portalEventToTxRow(
  ev: PortalEvent,
  nameByCode: Map<string, string>,
  relayLabels: Partial<Record<string, string>> = {},
): TransactionRow {
  const date = new Date(ev.ts);
  const ts = date.getTime();
  const hh = date.getHours();
  const h12 = hh % 12 || 12;
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const relayLabel = relayLabels[String(ev.relay)] || `Relay ${ev.relay}`;
  return {
    ts,
    minute: minuteKey(date),
    date: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    time: `${h12}:${pad2(date.getMinutes())} ${ampm}`,
    eventType: ev.eventType,
    number: ev.directoryCode,
    lookup: 'directory',
    name: nameByCode.get(noteKey(ev.directoryCode)) || ev.username,
    access: ev.access,
    relay: relayLabel,
    apb: '',
    directoryCode: ev.directoryCode,
    camera: true,
    raw: '',
    source: 'portal',
    txKey: `portal:${ev.id}`,
  };
}

/** Counts how many entry-code rerolls this unit performed in the last 24 hours. */
export async function countRerollsToday(store: Store, phone: string, directoryCode: string): Promise<number> {
  const since = new Date(Date.now() - 86400000).toISOString();
  const row = await one<{ count: string }>(store,
    'SELECT COUNT(*)::text AS count FROM resident_code_rerolls WHERE phone = $1 AND directory_code = $2 AND created_at >= $3',
    [phoneDigits(phone), noteKey(directoryCode), since]);
  return Number(row?.count || 0);
}

/** Records an entry-code reroll by a resident. */
export async function recordCodeReroll(
  store: Store,
  entry: { phone: string; directoryCode: string; username: string; oldCode: string; newCode: string },
): Promise<void> {
  await run(store, `INSERT INTO resident_code_rerolls (phone, directory_code, username, old_code, new_code, created_at)
    VALUES ($1, $2, $3, $4, $5, $6)`,
  [phoneDigits(entry.phone), noteKey(entry.directoryCode), userKey(entry.username), entry.oldCode, entry.newCode, new Date().toISOString()]);
}

/** Marks any pending rerolls for `phone` as synced once a gate Send completes. */
export async function markRerollsSynced(store: Store, phone: string): Promise<void> {
  await run(store, 'UPDATE resident_code_rerolls SET synced_at = $2 WHERE phone = $1 AND synced_at IS NULL',
    [phoneDigits(phone), new Date().toISOString()]);
}

/** True if this unit has an entry-code reroll saved in the working copy waiting for a Send to gate. */
export async function hasPendingReroll(store: Store, phone: string, directoryCode: string): Promise<boolean> {
  return Boolean(await one(store,
    'SELECT 1 AS x FROM resident_code_rerolls WHERE phone = $1 AND directory_code = $2 AND synced_at IS NULL LIMIT 1',
    [phoneDigits(phone), noteKey(directoryCode)]));
}

/** Returns the earliest upcoming scheduled `send` timestamp (ISO string) for `phone`, or `null` when none is scheduled. */
export async function nextScheduledSend(store: Store, phone: string): Promise<string | null> {
  const schedules = await listSchedules(store, phone);
  const times = schedules
    .filter((schedule) => schedule.enabled && schedule.actions.includes('send') && schedule.nextRun)
    .map((schedule) => schedule.nextRun!)
    .sort();
  return times[0] || null;
}

/** Creates a self-service resident change request. */
export async function createResidentRequest(store: Store, entry: CreateResidentRequestParams): Promise<ResidentRequest> {
  const kind = String(entry.kind || '');
  if (!['phone', 'hidden', 'cardIssue', 'other'].includes(kind)) {
    throw httpError('Request kind must be phone, hidden, cardIssue, or other');
  }
  const payload = entry.payload && typeof entry.payload === 'object' && !Array.isArray(entry.payload)
    ? entry.payload as Record<string, unknown> : {};
  const note = String(entry.note ?? '').trim().slice(0, 500);
  const row = (await one<ResidentRequestRow>(store, `INSERT INTO resident_requests (phone, directory_code, username, kind, payload, note, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7) RETURNING *`,
  [phoneDigits(entry.phone), entry.directoryCode, userKey(entry.username), kind, JSON.stringify(payload), note, new Date().toISOString()]))!;
  return fromRequestRow(row);
}

/** Lists resident change requests for a gate (optionally filtered by username). */
export async function listResidentRequests(
  store: Store,
  phone: string,
  { username, limit = 100 }: { username?: string; limit?: number } = {},
): Promise<ResidentRequest[]> {
  const phoneKey = phoneDigits(phone);
  const rows = username
    ? await all<ResidentRequestRow>(store,
      'SELECT * FROM resident_requests WHERE phone = $1 AND username = $2 ORDER BY created_at DESC LIMIT $3',
      [phoneKey, userKey(username), limit])
    : await all<ResidentRequestRow>(store,
      "SELECT * FROM resident_requests WHERE phone = $1 ORDER BY (status = 'pending') DESC, created_at DESC LIMIT $2",
      [phoneKey, limit]);
  return rows.map(fromRequestRow);
}

/** Marks a resident change request approved or rejected. */
export async function reviewResidentRequest(
  store: Store,
  phone: string,
  id: number,
  decision: 'approved' | 'rejected',
  reviewer: string,
  reviewNote = '',
): Promise<ResidentRequest> {
  const row = await one<ResidentRequestRow>(store, `
    UPDATE resident_requests SET status = $3, reviewed_by = $4, reviewed_at = $5, review_note = $6
    WHERE phone = $1 AND id = $2 AND status = 'pending' RETURNING *`,
  [phoneDigits(phone), id, decision, userKey(reviewer), new Date().toISOString(), String(reviewNote).trim().slice(0, 300)]);
  if (!row) throw httpError('Pending request not found', 404);
  return fromRequestRow(row);
}

/** Files a suspicious-activity report for one of a resident's own transactions. */
export async function reportSuspiciousActivity(
  store: Store,
  entry: ReportSuspiciousParams,
): Promise<{ report: SuspiciousReport; created: boolean }> {
  const phoneKey = phoneDigits(entry.phone);
  const code = entry.directoryCode;
  const txKey = String(entry.txKey || '').trim().slice(0, 120);
  if (!txKey) throw httpError('Transaction key is required');
  const txSource = entry.txSource === 'portal' ? 'portal' : 'gate';
  const note = String(entry.note ?? '').trim().slice(0, 500);
  const summary = String(entry.txSummary ?? '').trim().slice(0, 240);
  const ts = new Date(entry.txTs);
  if (Number.isNaN(ts.getTime())) throw httpError('Invalid transaction timestamp');
  const inserted = await one<SuspiciousReportRow>(store, `
    INSERT INTO suspicious_reports (phone, directory_code, username, tx_source, tx_key, tx_ts, tx_summary, note, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9)
    ON CONFLICT (phone, directory_code, tx_source, tx_key) DO NOTHING RETURNING *`,
  [phoneKey, code, userKey(entry.username), txSource, txKey, ts.toISOString(), summary, note, new Date().toISOString()]);
  if (inserted) return { report: fromReportRow(inserted), created: true };
  const existing = (await one<SuspiciousReportRow>(store,
    'SELECT * FROM suspicious_reports WHERE phone = $1 AND directory_code = $2 AND tx_source = $3 AND tx_key = $4',
    [phoneKey, code, txSource, txKey]))!;
  return { report: fromReportRow(existing), created: false };
}

/** Lists suspicious-activity reports for a gate (optionally filtered to a resident's directory codes). */
export async function listSuspiciousReports(
  store: Store,
  phone: string,
  { codes, limit = 100 }: { codes?: string[]; limit?: number } = {},
): Promise<SuspiciousReport[]> {
  const phoneKey = phoneDigits(phone);
  const rows = codes && codes.length
    ? await all<SuspiciousReportRow>(store,
      'SELECT * FROM suspicious_reports WHERE phone = $1 AND directory_code = ANY($2::text[]) ORDER BY created_at DESC LIMIT $3',
      [phoneKey, codes, limit])
    : await all<SuspiciousReportRow>(store,
      "SELECT * FROM suspicious_reports WHERE phone = $1 ORDER BY (status = 'open') DESC, created_at DESC LIMIT $2",
      [phoneKey, limit]);
  return rows.map(fromReportRow);
}

/** Resolves a suspicious-activity report. */
export async function resolveSuspiciousReport(
  store: Store,
  phone: string,
  id: number,
  reviewer: string,
  reviewNote = '',
): Promise<SuspiciousReport> {
  const row = await one<SuspiciousReportRow>(store, `
    UPDATE suspicious_reports SET status = 'resolved', reviewed_by = $3, reviewed_at = $4, review_note = $5
    WHERE phone = $1 AND id = $2 RETURNING *`,
  [phoneDigits(phone), id, userKey(reviewer), new Date().toISOString(), String(reviewNote).trim().slice(0, 300)]);
  if (!row) throw httpError('Suspicious report not found', 404);
  return fromReportRow(row);
}

/** Records a login audit event (password, passkey, SSO, invite) without ever storing passwords or tokens. */
export async function recordLoginAudit(store: Store, entry: RecordLoginAuditParams): Promise<void> {
  await run(store, `INSERT INTO login_audit (username, identifier, role, method, outcome, reason, ip, user_agent, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [entry.username ? userKey(entry.username) : null, String(entry.identifier || '').slice(0, 120), entry.role || null,
    entry.method, entry.outcome, entry.reason ? String(entry.reason).slice(0, 200) : null,
    String(entry.ip || '').slice(0, 64), String(entry.userAgent || '').slice(0, 240), new Date().toISOString()]);
}

/** Lists login audit entries relevant to `phone`. */
export async function listLoginAudit(
  store: Store,
  phone: string,
  { limit = 100, outcome = '' }: { limit?: number; outcome?: string } = {},
): Promise<LoginAuditEntry[]> {
  const phoneKey = phoneDigits(phone);
  const clamped = Math.min(500, Math.max(1, Number(limit) || 100));
  const rows = await all<LoginAuditRow>(store, `
    SELECT l.* FROM login_audit l
    WHERE (
      l.username IN (SELECT username FROM gate_access WHERE phone = $1)
      OR l.username IN (SELECT username FROM resident_portal WHERE phone = $1 AND username IS NOT NULL)
      OR l.identifier IN (SELECT LOWER(email) FROM resident_portal WHERE phone = $1 AND email <> '')
      OR l.username IS NULL
    )
    ${outcome === 'failed' ? "AND l.outcome <> 'success'" : ''}
    ORDER BY l.created_at DESC
    LIMIT $2`, [phoneKey, clamped]);
  return rows.map(fromLoginAuditRow);
}

/** Prunes login audit entries older than `keepDays` (default 180). */
export async function pruneLoginAudit(store: Store, keepDays = 180): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString();
  return run(store, 'DELETE FROM login_audit WHERE created_at < $1', [cutoff]);
}

/** Returns the resident's linked username and confirmed email when their portal is enabled (for Push + Email alerts). */
export async function residentNotifyTarget(store: Store, phone: string, code: string): Promise<{ username: string; email: string } | null> {
  const row = await one<{ username: string; email: string | null }>(store, `
    SELECT p.username, u.email FROM resident_portal p
    JOIN users u ON u.username = p.username
    WHERE p.phone = $1 AND p.code = $2 AND p.enabled = TRUE AND p.username IS NOT NULL`,
  [phoneDigits(phone), noteKey(code)]);
  return row ? { username: row.username, email: row.email || '' } : null;
}
