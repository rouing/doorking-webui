// Gates managed by this server (table managed_gates) and who may use them (table gate_access), see db.ts. A gate
// is added once, after a successful connection with its DKS login and master code (the server checks that before
// calling registerGate), by a user who becomes its first admin. Its DKS login and master code are encrypted.
// Roles: 'admin' (everything, including the gate's users and login) and 'readonly' (view, pull, cameras). A gate
// always keeps at least one admin.
import { all, encrypt, decrypt, getMeta, one, run, setMeta, transaction } from './db.ts';
import type { Store } from './db.ts';
import { userKey } from './users.ts';
import type { GateRole, GateUser } from './types.ts';

export type { GateRole, GateUser };
export const GATE_ROLES: GateRole[] = ['admin', 'readonly'];

export interface GateRecord {
  phoneNumber: string; masterCode: string; dksUser: string; dksPassword: string; addedBy: string; addedAt: string;
}

interface GateRow { phone: string; master_code: string; dks_user: string; dks_password: string; added_by: string; added_at: string }

const phoneDigits = (phone: unknown): string => String(phone || '').replace(/\D/g, '');
const err = (msg: string, status = 400) => Object.assign(new Error(msg), { status });
export const ALREADY_ADDED = 'This gate is already managed here. Ask one of its gate admins to add you to it.';
const LAST_ADMIN = 'A gate must keep at least one admin. Make someone else an admin first.';

export function checkPhone(phone: unknown): string {
  const p = phoneDigits(phone);
  if (!/^\d{4,15}$/.test(p)) throw err('Gate phone number must be 4-15 digits');
  return p;
}
export function checkMasterCode(code: unknown): string {
  const c = String(code ?? '').trim();
  if (!/^\d{4}$/.test(c)) throw err('Master code must be 4 digits');
  return c;
}
export function checkRole(role: unknown): GateRole {
  if (!GATE_ROLES.includes(role as GateRole)) throw err('Role must be admin or readonly');
  return role as GateRole;
}
const checkDksLogin = (user: unknown, password: unknown) => {
  const u = String(user ?? '').trim();
  const pw = String(password ?? '');
  if (!u || !pw) throw err('The gate\'s DKS user and password are required');
  return { u, pw };
};

const fromRow = (store: Store, r: GateRow): GateRecord => ({
  phoneNumber: r.phone, masterCode: decrypt(store, r.master_code), dksUser: r.dks_user,
  dksPassword: r.dks_password ? decrypt(store, r.dks_password) : '', addedBy: r.added_by, addedAt: r.added_at,
});

export async function getGate(store: Store, phone: unknown): Promise<GateRecord | null> {
  const r = await one<GateRow>(store, 'SELECT * FROM managed_gates WHERE phone = $1', [phoneDigits(phone)]);
  return r ? fromRow(store, r) : null;
}

export async function gateExists(store: Store, phone: unknown): Promise<boolean> {
  return Boolean(await one(store, 'SELECT 1 AS x FROM managed_gates WHERE phone = $1', [phoneDigits(phone)]));
}

// Adds a gate with `admin` as its first admin. Throws 409 ALREADY_ADDED when it is managed here already.
export async function registerGate(store: Store, g: { phoneNumber: unknown; masterCode: unknown; dksUser: unknown; dksPassword: unknown },
  admin: string): Promise<GateRecord> {
  const p = checkPhone(g.phoneNumber);
  const code = checkMasterCode(g.masterCode);
  const { u, pw } = checkDksLogin(g.dksUser, g.dksPassword);
  const now = new Date().toISOString();
  await transaction(store, async (tx) => {
    const added = await run(tx, `INSERT INTO managed_gates (phone, master_code, dks_user, dks_password, added_by, added_at)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (phone) DO NOTHING`, [p, encrypt(tx, code), u, encrypt(tx, pw), userKey(admin), now]);
    if (!added) throw err(ALREADY_ADDED, 409);
    await run(tx, `INSERT INTO gate_access (phone, username, role, granted_by, granted_at) VALUES ($1, $2, 'admin', $2, $3)`,
      [p, userKey(admin), now]);
  });
  return (await getGate(store, p))!;
}

// Changes the gate's master code and/or DKS login (only the values given; a blank password keeps the saved one).
export async function updateGateLogin(store: Store, phone: unknown, { masterCode, dksUser, dksPassword }:
  { masterCode?: unknown; dksUser?: unknown; dksPassword?: unknown }): Promise<GateRecord> {
  const g = await getGate(store, phone);
  if (!g) throw err('Gate not found', 404);
  const code = masterCode !== undefined && masterCode !== '' ? checkMasterCode(masterCode) : g.masterCode;
  const user = dksUser !== undefined ? String(dksUser).trim() : g.dksUser;
  const pw = dksPassword ? String(dksPassword) : g.dksPassword;
  checkDksLogin(user, pw);
  await run(store, 'UPDATE managed_gates SET master_code = $2, dks_user = $3, dks_password = $4 WHERE phone = $1',
    [g.phoneNumber, encrypt(store, code), user, encrypt(store, pw)]);
  return (await getGate(store, g.phoneNumber))!;
}

// The user's role on the gate, or null.
export async function accessOf(store: Store, phone: unknown, username: unknown): Promise<GateRole | null> {
  const r = await one<{ role: GateRole }>(store, 'SELECT role FROM gate_access WHERE phone = $1 AND username = $2',
    [phoneDigits(phone), userKey(username)]);
  return r ? r.role : null;
}

// The gates the user may open, oldest first: [{ phoneNumber, role, addedAt }].
export async function userGates(store: Store, username: unknown): Promise<{ phoneNumber: string; role: GateRole; addedAt: string }[]> {
  return (await all<{ phone: string; role: GateRole; added_at: string }>(store, `SELECT a.phone, a.role, g.added_at FROM gate_access a
    JOIN managed_gates g ON g.phone = a.phone WHERE a.username = $1 ORDER BY g.added_at, a.phone`, [userKey(username)]))
    .map((r) => ({ phoneNumber: r.phone, role: r.role, addedAt: r.added_at }));
}

export async function isAnyGateAdmin(store: Store, username: unknown): Promise<boolean> {
  return Boolean(await one(store, "SELECT 1 AS x FROM gate_access WHERE username = $1 AND role = 'admin'", [userKey(username)]));
}

// Everyone with access to the gate, admins first.
export async function gateUsers(store: Store, phone: unknown): Promise<GateUser[]> {
  return (await all<{ username: string; email: string | null; role: GateRole; granted_by: string; granted_at: string; last_sign_in: string | null }>(store,
    `SELECT a.username, u.email, a.role, a.granted_by, a.granted_at, u.last_sign_in FROM gate_access a
      JOIN users u ON u.username = a.username WHERE a.phone = $1 ORDER BY a.role, a.username`, [phoneDigits(phone)]))
    .map((r) => ({ username: r.username, email: r.email || '', role: r.role, grantedBy: r.granted_by, grantedAt: r.granted_at, lastSignIn: r.last_sign_in }));
}

// Shares the gate with an existing user. 404 when there is no such user, 409 when they already have access.
export async function grantAccess(store: Store, phone: unknown, username: unknown, role: unknown, by: string): Promise<void> {
  const p = phoneDigits(phone);
  const name = userKey(username);
  const r = checkRole(role);
  if (!await one(store, 'SELECT 1 AS x FROM users WHERE username = $1', [name])) throw err(`There is no user "${name}"`, 404);
  const added = await run(store, `INSERT INTO gate_access (phone, username, role, granted_by, granted_at) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (phone, username) DO NOTHING`, [p, name, r, userKey(by), new Date().toISOString()]);
  if (!added) throw err(`"${name}" already has access to this gate (${(await accessOf(store, p, name)) === 'admin' ? 'admin' : 'read only'})`, 409);
}

// Admins of the gate, locked until the transaction ends so two changes can't remove the last two admins at once.
const lockedAdmins = async (tx: Store, p: string) => {
  await one(tx, 'SELECT 1 AS x FROM managed_gates WHERE phone = $1 FOR UPDATE', [p]);
  return (await all<{ username: string }>(tx, "SELECT username FROM gate_access WHERE phone = $1 AND role = 'admin'", [p])).map((r) => r.username);
};

export async function setRole(store: Store, phone: unknown, username: unknown, role: unknown): Promise<void> {
  const p = phoneDigits(phone);
  const name = userKey(username);
  const r = checkRole(role);
  await transaction(store, async (tx) => {
    const admins = await lockedAdmins(tx, p);
    if (r !== 'admin' && admins.length === 1 && admins[0] === name) throw err(LAST_ADMIN, 409);
    if (!await run(tx, 'UPDATE gate_access SET role = $3 WHERE phone = $1 AND username = $2', [p, name, r])) {
      throw err(`"${name}" has no access to this gate`, 404);
    }
  });
}

// Takes the user off the gate (also how a user leaves a gate).
export async function revokeAccess(store: Store, phone: unknown, username: unknown): Promise<void> {
  const p = phoneDigits(phone);
  const name = userKey(username);
  await transaction(store, async (tx) => {
    const admins = await lockedAdmins(tx, p);
    if (admins.length === 1 && admins[0] === name) throw err(LAST_ADMIN, 409);
    if (!await run(tx, 'DELETE FROM gate_access WHERE phone = $1 AND username = $2', [p, name])) {
      throw err(`"${name}" has no access to this gate`, 404);
    }
  });
}

// Makes the user admin of every gate that has no admin (the first account, and the CLI's create-admin). Returns
// the phone numbers.
export async function adoptAdminlessGates(store: Store, username: unknown): Promise<string[]> {
  const name = userKey(username);
  const phones = (await all<{ phone: string }>(store, `SELECT phone FROM managed_gates g WHERE NOT EXISTS
    (SELECT 1 FROM gate_access a WHERE a.phone = g.phone AND a.role = 'admin') ORDER BY phone`)).map((r) => r.phone);
  const now = new Date().toISOString();
  for (const p of phones) {
    await run(store, `INSERT INTO gate_access (phone, username, role, granted_by, granted_at) VALUES ($1, $2, 'admin', $2, $3)
      ON CONFLICT (phone, username) DO UPDATE SET role = 'admin'`, [p, name, now]);
  }
  return phones;
}

// One-time move from DKS sign-in (2026-11-13): each gate some DKS user had connected to (table gates) becomes a
// managed gate, with that user's master code and, when they saved a password for schedules (table credentials),
// that DKS login. Gates without a saved password get an empty DKS login, to be set in System Settings. Nobody has
// access yet: the first local account adopts them (adoptAdminlessGates). Returns the phones added (and those
// without a login), or null when it already ran.
export async function migrateToLocalAccounts(store: Store): Promise<{ gates: string[]; noLogin: string[] } | null> {
  if (await getMeta(store, 'localAccountsMigrated')) return null;
  const out = { gates: [] as string[], noLogin: [] as string[] };
  await transaction(store, async (tx) => {
    const rows = await all<{ username: string; phone: string; master_code: string; added_at: string; login: string | null; password: string | null }>(tx,
      `SELECT g.username, g.phone, g.master_code, g.added_at, c.login, c.password FROM gates g
        LEFT JOIN credentials c ON c.username = g.username WHERE g.verified_at IS NOT NULL
        ORDER BY (c.password IS NULL), g.verified_at DESC`);
    for (const r of rows) {
      if (out.gates.includes(r.phone)) continue;
      await run(tx, `INSERT INTO managed_gates (phone, master_code, dks_user, dks_password, added_by, added_at)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (phone) DO NOTHING`,
      [r.phone, r.master_code, r.login || '', r.password || '', r.username, r.added_at]);
      out.gates.push(r.phone);
      if (!r.password) out.noLogin.push(r.phone);
    }
    await setMeta(tx, 'localAccountsMigrated', new Date().toISOString());
  });
  return out;
}

// Tables with rows about one gate, keyed by its phone number (see db.ts). gates is the pre-2026-11-13 per-user list.
const GATE_TABLES = ['gate_access', 'api_keys', 'managed_gates', 'gates', 'prefs', 'history', 'schedules', 'cameras', 'snapshots', 'notes',
  'tx_history', 'gate_files', 'gate_residents', 'gate_cards', 'gate_settings', 'gate_state', 'gate_working'];

// Deletes every row about the gate, in one transaction: the gate itself, everyone's access to it and its API keys, prefs,
// history, schedules, camera settings, snapshot log, notes, transaction history, board files and the tables decoded
// from them; sessions that had it open close it. Returns the rows removed per table.
export async function deleteGateData(store: Store, phoneNumber: unknown): Promise<Record<string, number>> {
  const p = phoneDigits(phoneNumber);
  if (!p) throw err('Gate phone number required');
  const removed: Record<string, number> = {};
  await transaction(store, async (tx) => {
    for (const t of GATE_TABLES) removed[t] = await run(tx, `DELETE FROM ${t} WHERE phone = $1`, [p]);
    await run(tx, 'UPDATE sessions SET gate = NULL WHERE gate = $1', [p]);
  });
  return removed;
}
