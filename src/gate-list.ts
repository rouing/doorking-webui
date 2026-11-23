/**
 * @module src/gate-list
 *
 * Gates managed by this server (table managed_gates) and who may use them (table gate_access), see db.ts. A gate
 * is added once, after a successful connection with its DKS login and master code (the server checks that before
 * calling registerGate), by a user who becomes its first admin. Its DKS login and master code are encrypted.
 * Roles: 'admin' (everything, including the gate's users and login) and 'readonly' (view, pull, cameras). A gate
 * always keeps at least one admin.
 */
import { all, encrypt, decrypt, getMeta, one, run, setMeta, transaction, phoneDigits } from './db.ts';
import type { Store } from './db.ts';
import { userKey } from './users.ts';
import type { GateRole, GateUser } from './types.ts';
import { httpError } from './errors.ts';

export type { GateRole, GateUser };
export const GATE_ROLES: GateRole[] = ['admin', 'editor', 'readonly'];

export interface GateRecord {
  phoneNumber: string; masterCode: string; dksUser: string; dksPassword: string; addedBy: string; addedAt: string;
}

interface GateUserRow {
  username: string; email: string | null; pending_email: string | null; phone: string | null; invited: boolean; role: GateRole;
  granted_by: string; granted_at: string; last_sign_in: string | null;
}
/** A gate from before local accounts, with the DKS login saved for its schedules (migrateToLocalAccounts). */
interface LegacyGateRow { username: string; phone: string; master_code: string; added_at: string; login: string | null; password: string | null }
interface GateRow { phone: string; master_code: string; dks_user: string; dks_password: string; added_by: string; added_at: string }

export const ALREADY_ADDED = 'This gate is already managed here. Ask one of its gate admins to add you to it.';
const LAST_ADMIN = 'A gate must keep at least one admin. Make someone else an admin first.';

/**
 * Check phone.
 *
 * @param phone - Gate system phone number (digits or formatted).
 * @returns `string` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function checkPhone(phone: unknown): string {
  const phoneKey = phoneDigits(phone);
  if (!/^\d{4,15}$/.test(phoneKey)) throw httpError('Gate phone number must be 4-15 digits');
  return phoneKey;
}
/**
 * Check master code.
 *
 * @param code - Directory code, HTTP status code, or verification code.
 * @returns `string` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function checkMasterCode(code: unknown): string {
  const trimmed = String(code ?? '').trim();
  if (!/^\d{4}$/.test(trimmed)) throw httpError('Master code must be 4 digits');
  return trimmed;
}
/**
 * Check role.
 *
 * @param role - Gate access role (`admin` or `readonly`).
 * @returns `GateRole` result.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export function checkRole(role: unknown): GateRole {
  if (!GATE_ROLES.includes(role as GateRole)) throw httpError('Role must be admin, editor or readonly');
  return role as GateRole;
}
const checkDksLogin = (user: unknown, password: unknown) => {
  const name = String(user ?? '').trim();
  const secret = String(password ?? '');
  if (!name || !secret) throw httpError('The gate\'s DKS user and password are required');
  return { u: name, pw: secret };
};

const fromRow = (store: Store, row: GateRow): GateRecord => ({
  phoneNumber: row.phone, masterCode: decrypt(store, row.master_code), dksUser: row.dks_user,
  dksPassword: row.dks_password ? decrypt(store, row.dks_password) : '', addedBy: row.added_by, addedAt: row.added_at,
});

/**
 * Get gate.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `GateRecord | null`.
 */
export async function getGate(store: Store, phone: string): Promise<GateRecord | null> {
  const row = await one<GateRow>(store, 'SELECT * FROM managed_gates WHERE phone = $1', [phoneDigits(phone)]);
  return row ? fromRow(store, row) : null;
}

/**
 * Gate exists.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `true` when the condition holds.
 */
export async function gateExists(store: Store, phone: string): Promise<boolean> {
  return Boolean(await one(store, 'SELECT 1 AS x FROM managed_gates WHERE phone = $1', [phoneDigits(phone)]));
}

/**
 * Adds a gate with `admin` as its first admin. Throws 409 ALREADY_ADDED when it is managed here already.
 *
 * @param store - Database store handle.
 * @param gate - Resolved managed gate record with role and DKS credentials.
 * @param admin - PostgreSQL admin connection config.
 * @returns Promise resolving to `GateRecord`.
 */
export async function registerGate(store: Store, gate: { phoneNumber: unknown; masterCode: unknown; dksUser: unknown; dksPassword: unknown },
  admin: string): Promise<GateRecord> {
  const phone = checkPhone(gate.phoneNumber);
  const code = checkMasterCode(gate.masterCode);
  const { u: user, pw: password } = checkDksLogin(gate.dksUser, gate.dksPassword);
  const now = new Date().toISOString();
  await transaction(store, async (tx) => {
    const added = await run(tx, `INSERT INTO managed_gates (phone, master_code, dks_user, dks_password, added_by, added_at)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (phone) DO NOTHING`, [phone, encrypt(tx, code), user, encrypt(tx, password), userKey(admin), now]);
    if (!added) throw httpError(ALREADY_ADDED, 409);
    await run(tx, `INSERT INTO gate_access (phone, username, role, granted_by, granted_at) VALUES ($1, $2, 'admin', $2, $3)`,
      [phone, userKey(admin), now]);
  });
  return (await getGate(store, phone))!;
}

/**
 * Changes the gate's master code and/or DKS login (only the values given; a blank password keeps the saved one).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param options - Options object.
 * @param options.masterCode - 4-digit gate master code.
 * @param options.dksUser - DKS Cloud account username.
 * @param options.dksPassword - DKS Cloud account password.
 * @returns Promise resolving to `GateRecord`.
 * @throws HTTP 404 error on invalid input or conflict.
 */
export async function updateGateLogin(store: Store, phone: string, { masterCode, dksUser, dksPassword }:
  { masterCode?: unknown; dksUser?: unknown; dksPassword?: unknown }): Promise<GateRecord> {
  const gate = await getGate(store, phone);
  if (!gate) throw httpError('Gate not found', 404);
  const code = masterCode !== undefined && masterCode !== '' ? checkMasterCode(masterCode) : gate.masterCode;
  const user = dksUser !== undefined ? String(dksUser).trim() : gate.dksUser;
  const password = dksPassword ? String(dksPassword) : gate.dksPassword;
  checkDksLogin(user, password);
  await run(store, 'UPDATE managed_gates SET master_code = $2, dks_user = $3, dks_password = $4 WHERE phone = $1',
    [gate.phoneNumber, encrypt(store, code), user, encrypt(store, password)]);
  return (await getGate(store, gate.phoneNumber))!;
}

/**
 * The user's role on the gate, or null.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param username - Local account username.
 * @returns Promise resolving to `GateRole | null`.
 */
export async function accessOf(store: Store, phone: string, username: string): Promise<GateRole | null> {
  const row = await one<{ role: GateRole }>(store, 'SELECT role FROM gate_access WHERE phone = $1 AND username = $2',
    [phoneDigits(phone), userKey(username)]);
  return row ? row.role : null;
}

/**
 * The gates the user may open, oldest first: [{ phoneNumber, role, addedAt }].
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @returns Promise resolving to `{ phoneNumber: string; role: GateRole; addedAt: string }[]`.
 */
export async function userGates(store: Store, username: string): Promise<{ phoneNumber: string; role: GateRole; addedAt: string }[]> {
  return (await all<{ phone: string; role: GateRole; added_at: string }>(store, `SELECT a.phone, a.role, g.added_at FROM gate_access a
    JOIN managed_gates g ON g.phone = a.phone WHERE a.username = $1 ORDER BY g.added_at, a.phone`, [userKey(username)]))
    .map((row) => ({ phoneNumber: row.phone, role: row.role, addedAt: row.added_at }));
}

/**
 * Everyone with access to the gate, admins first.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `GateUser[]`.
 */
export async function gateUsers(store: Store, phone: string): Promise<GateUser[]> {
  const rows = await all<GateUserRow>(store,
    `SELECT a.username, u.email, u.pending_email, u.phone, u.password_hash = '!' AS invited, a.role, a.granted_by, a.granted_at, u.last_sign_in
      FROM gate_access a JOIN users u ON u.username = a.username WHERE a.phone = $1 ORDER BY a.role, a.username`, [phoneDigits(phone)]);
  const usernames = rows.map((row) => row.username);
  const ssoByUser = new Map<string, string[]>();
  if (usernames.length) {
    const ids = await all<{ username: string; provider: string }>(store,
      'SELECT username, provider FROM user_identities WHERE username = ANY($1::text[]) ORDER BY provider', [usernames]);
    for (const id of ids) {
      const list = ssoByUser.get(id.username) || [];
      if (!list.includes(id.provider)) list.push(id.provider);
      ssoByUser.set(id.username, list);
    }
  }
  return rows.map((row) => ({
    username: row.username, email: row.email || '', pendingEmail: row.pending_email || '', phone: row.phone || '', invited: row.invited, role: row.role,
    grantedBy: row.granted_by, grantedAt: row.granted_at, lastSignIn: row.last_sign_in, ssoProviders: ssoByUser.get(row.username) || [],
  }));
}

/**
 * Gate admins who should receive Web Push gate alerts (`notify_alerts = true` and at least one push subscription).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to admin usernames.
 */
export async function pushAlertRecipients(store: Store, phone: string): Promise<string[]> {
  const rows = await all<{ username: string }>(store,
    `SELECT DISTINCT a.username FROM gate_access a
      JOIN users u ON u.username = a.username
      JOIN push_subscriptions p ON p.username = a.username
      WHERE a.phone = $1 AND a.role = 'admin' AND u.notify_alerts`, [phoneDigits(phone)]);
  return rows.map((row) => row.username);
}

/**
 * Shares the gate with an existing user. 404 when there is no such user, 409 when they already have access.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param username - Local account username.
 * @param role - Gate access role (`admin` or `readonly`).
 * @param by - Username of the user performing the action.
 * @throws HTTP 400/404 error on invalid input or conflict.
 */
export async function grantAccess(store: Store, phone: string, username: string, role: unknown, by: string): Promise<void> {
  const phoneKey = phoneDigits(phone);
  const name = userKey(username);
  const checkedRole = checkRole(role);
  if (!await one(store, 'SELECT 1 AS x FROM users WHERE username = $1', [name])) throw httpError(`There is no user "${name}"`, 404);
  const added = await run(store, `INSERT INTO gate_access (phone, username, role, granted_by, granted_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone, username) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_at = excluded.granted_at
    WHERE gate_access.role = 'resident'`, [phoneKey, name, checkedRole, userKey(by), new Date().toISOString()]);
  if (!added) {
    const existing = await accessOf(store, phoneKey, name);
    throw httpError(`"${name}" already has access to this gate (${existing === 'admin' ? 'admin' : existing === 'editor' ? 'editor' : 'read only'})`, 409);
  }
}

/**
 * Admins of the gate, locked until the transaction ends so two changes can't remove the last two admins at once.
 *
 * @param tx - Active database transaction store.
 * @param phone - Gate system phone number (digits or formatted).
 * @returns Promise resolving to the operation result.
 */
const lockedAdmins = async (tx: Store, phone: string) => {
  await one(tx, 'SELECT 1 AS x FROM managed_gates WHERE phone = $1 FOR UPDATE', [phone]);
  return (await all<{ username: string }>(tx, "SELECT username FROM gate_access WHERE phone = $1 AND role = 'admin'", [phone])).map((row) => row.username);
};

/**
 * Set role.
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param username - Local account username.
 * @param role - Gate access role (`admin` or `readonly`).
 */
export async function setRole(store: Store, phone: string, username: string, role: unknown): Promise<void> {
  const phoneKey = phoneDigits(phone);
  const name = userKey(username);
  const checkedRole = checkRole(role);
  await transaction(store, async (tx) => {
    const admins = await lockedAdmins(tx, phoneKey);
    if (checkedRole !== 'admin' && admins.length === 1 && admins[0] === name) throw httpError(LAST_ADMIN, 409);
    if (!await run(tx, 'UPDATE gate_access SET role = $3 WHERE phone = $1 AND username = $2', [phoneKey, name, checkedRole])) {
      throw httpError(`"${name}" has no access to this gate`, 404);
    }
  });
}

/**
 * Takes the user off the gate (also how a user leaves a gate).
 *
 * @param store - Database store handle.
 * @param phone - Gate system phone number (digits or formatted).
 * @param username - Local account username.
 */
export async function revokeAccess(store: Store, phone: string, username: string): Promise<void> {
  const phoneKey = phoneDigits(phone);
  const name = userKey(username);
  await transaction(store, async (tx) => {
    const admins = await lockedAdmins(tx, phoneKey);
    if (admins.length === 1 && admins[0] === name) throw httpError(LAST_ADMIN, 409);
    if (!await run(tx, 'DELETE FROM gate_access WHERE phone = $1 AND username = $2', [phoneKey, name])) {
      throw httpError(`"${name}" has no access to this gate`, 404);
    }
  });
}

/**
 * Makes the user admin of every gate that has no admin (the first account, and the CLI's create-admin). Returns
 * the phone numbers.
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @returns Promise resolving to `string[]`.
 */
export async function adoptAdminlessGates(store: Store, username: string): Promise<string[]> {
  const name = userKey(username);
  const phones = (await all<{ phone: string }>(store, `SELECT phone FROM managed_gates g WHERE NOT EXISTS
    (SELECT 1 FROM gate_access a WHERE a.phone = g.phone AND a.role = 'admin') ORDER BY phone`)).map((row) => row.phone);
  const now = new Date().toISOString();
  for (const phone of phones) {
    await run(store, `INSERT INTO gate_access (phone, username, role, granted_by, granted_at) VALUES ($1, $2, 'admin', $2, $3)
      ON CONFLICT (phone, username) DO UPDATE SET role = 'admin'`, [phone, name, now]);
  }
  return phones;
}

/**
 * One-time move from DKS sign-in (2026-11-13): each gate some DKS user had connected to (table gates) becomes a
 * managed gate, with that user's master code and, when they saved a password for schedules (table credentials),
 * that DKS login. Gates without a saved password get an empty DKS login, to be set in System Settings. Nobody has
 * access yet: the first local account adopts them (adoptAdminlessGates). Returns the phones added (and those
 * without a login), or null when it already ran.
 *
 * @param store - Database store handle.
 * @returns Promise resolving to `{ gates: string[]; noLogin: string[] } | null`.
 */
export async function migrateToLocalAccounts(store: Store): Promise<{ gates: string[]; noLogin: string[] } | null> {
  if (await getMeta(store, 'localAccountsMigrated')) return null;
  const out = { gates: [] as string[], noLogin: [] as string[] };
  await transaction(store, async (tx) => {
    const rows = await all<LegacyGateRow>(tx,
      `SELECT g.username, g.phone, g.master_code, g.added_at, c.login, c.password FROM gates g
        LEFT JOIN credentials c ON c.username = g.username WHERE g.verified_at IS NOT NULL
        ORDER BY (c.password IS NULL), g.verified_at DESC`);
    for (const row of rows) {
      if (out.gates.includes(row.phone)) continue;
      await run(tx, `INSERT INTO managed_gates (phone, master_code, dks_user, dks_password, added_by, added_at)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (phone) DO NOTHING`,
      [row.phone, row.master_code, row.login || '', row.password || '', row.username, row.added_at]);
      out.gates.push(row.phone);
      if (!row.password) out.noLogin.push(row.phone);
    }
    await setMeta(tx, 'localAccountsMigrated', new Date().toISOString());
  });
  return out;
}

/**
 * True when the user has no staff role (`admin`, `editor`, or `readonly`) on any gate (i.e., resident-only account).
 *
 * @param store - Database store handle.
 * @param username - Local account username.
 * @returns Promise resolving to `boolean`.
 */
export async function isResidentOnlyUser(store: Store, username: string): Promise<boolean> {
  const name = userKey(username);
  const staff = await one(store, "SELECT 1 AS x FROM gate_access WHERE username = $1 AND role IN ('admin', 'editor', 'readonly') LIMIT 1", [name]);
  if (staff) return false;
  const res = await one(store, "SELECT 1 AS x FROM gate_access WHERE username = $1 AND role = 'resident' LIMIT 1", [name]);
  return Boolean(res);
}

/**
 * Tables with rows about one gate, keyed by its phone number (see db.ts). gates is the pre-2026-11-13 per-user list.
 */
const GATE_TABLES = ['gate_access', 'api_keys', 'managed_gates', 'gates', 'prefs', 'history', 'schedules', 'cameras', 'snapshots', 'notes',
  'tx_history', 'tx_pulls', 'gate_files', 'gate_residents', 'gate_cards', 'gate_settings', 'gate_state', 'gate_working',
  'relay_timers', 'gate_pull_archive', 'webhook_deliveries', 'webhooks',
  'resident_portal', 'portal_events', 'resident_code_rerolls', 'resident_requests', 'suspicious_reports'];

/**
 * Deletes every row about the gate, in one transaction: the gate itself, everyone's access to it and its API keys, prefs,
 * history, schedules, camera settings, snapshot log, notes, transaction history, board files and the tables decoded
 * from them; sessions that had it open close it. Returns the rows removed per table.
 *
 * @param store - Database store handle.
 * @param phoneNumber - Gate system phone number (digits or formatted).
 * @returns Promise resolving to `Record<string, number>`.
 * @throws HTTP 400 error on invalid input or conflict.
 */
export async function deleteGateData(store: Store, phoneNumber: string): Promise<Record<string, number>> {
  const phoneKey = phoneDigits(phoneNumber);
  if (!phoneKey) throw httpError('Gate phone number required');
  const removed: Record<string, number> = {};
  await transaction(store, async (tx) => {
    for (const table of GATE_TABLES) removed[table] = await run(tx, `DELETE FROM ${table} WHERE phone = $1`, [phoneKey]);
    await run(tx, 'UPDATE sessions SET gate = NULL WHERE gate = $1', [phoneKey]);
  });
  return removed;
}
