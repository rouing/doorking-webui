// Local list of the gates each DKS Cloud user manages (DKS Cloud has no call that lists them; DoorKing32
// keeps its accounts locally too). Stored in the database's gates table (see db.ts), keyed by user (lower case)
// and phone number; the master code is encrypted there.
import { all, encrypt, decrypt, getMeta, one, run, setMeta, transaction } from './db.ts';
import type { Store } from './db.ts';

export interface GateEntry { phoneNumber: string; masterCode: string; addedAt: string; verifiedAt: string | null }

interface GateRow { phone: string; master_code: string; added_at: string; verified_at: string | null }

const userKey = (user: unknown): string => String(user || '').trim().toLowerCase();
const phoneDigits = (phone: unknown): string => String(phone || '').replace(/\D/g, '');

const err = (msg: string, status = 400) => Object.assign(new Error(msg), { status });

// [{ phoneNumber, masterCode, addedAt, verifiedAt }], oldest first. verifiedAt: when this user's last
// successful gate connection (pull or send) with the saved master code finished, or null.
export async function listGates(store: Store, user: unknown): Promise<GateEntry[]> {
  const rows = await all<GateRow>(store,
    'SELECT phone, master_code, added_at, verified_at FROM gates WHERE username = $1 ORDER BY added_at, phone', [userKey(user)]);
  return rows.map((r) => ({ phoneNumber: r.phone, masterCode: decrypt(store, r.master_code), addedAt: r.added_at, verifiedAt: r.verified_at || null }));
}

export async function findGate(store: Store, user: unknown, phoneNumber: unknown): Promise<GateEntry | null> {
  const p = phoneDigits(phoneNumber);
  return (await listGates(store, user)).find((g) => g.phoneNumber === p) || null;
}

// Adds a gate, or updates the master code of one already in the list. A changed master code clears verifiedAt.
export async function addGate(store: Store, user: unknown, { phoneNumber, masterCode }: { phoneNumber?: unknown; masterCode?: unknown }): Promise<GateEntry[]> {
  const p = phoneDigits(phoneNumber);
  const code = String(masterCode || '').trim();
  if (!/^\d{4,15}$/.test(p)) throw err('Gate phone number must be 4-15 digits');
  if (!/^\d{4}$/.test(code)) throw err('Master code must be 4 digits');
  await transaction(store, async (tx) => {
    const old = await findGate(tx, user, p);
    await run(tx, `INSERT INTO gates (username, phone, master_code, added_at, verified_at) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (username, phone) DO UPDATE SET master_code = excluded.master_code, verified_at = excluded.verified_at`,
    [userKey(user), p, encrypt(tx, code), old ? old.addedAt : new Date().toISOString(),
      old && old.masterCode === code ? old.verifiedAt : null]);
  });
  return listGates(store, user);
}

// Records a successful gate connection by `user` with the master code in their list.
export async function markGateVerified(store: Store, user: unknown, phoneNumber: unknown, at: string = new Date().toISOString()): Promise<void> {
  await run(store, 'UPDATE gates SET verified_at = $1 WHERE username = $2 AND phone = $3', [at, userKey(user), phoneDigits(phoneNumber)]);
}

// True when any account has connected to the gate successfully.
export async function gateClaimed(store: Store, phoneNumber: unknown): Promise<boolean> {
  return Boolean(await one(store, 'SELECT 1 AS x FROM gates WHERE phone = $1 AND verified_at IS NOT NULL', [phoneDigits(phoneNumber)]));
}

// One-time: marks gates added before verifiedAt existed as verified for users whose history shows a successful
// pull or send of that gate. Returns the number marked, or null when it already ran.
export async function backfillGateVerified(store: Store): Promise<number | null> {
  if (await getMeta(store, 'gatesVerifiedBackfill')) return null;
  let n = 0;
  const rows = await all<{ phone: string; data: { user?: string; result?: string; action?: string; time?: string } | null }>(store,
    'SELECT phone, data FROM history ORDER BY seq');
  for (const { phone, data: e } of rows) {
    if (!e || !e.user || e.result !== 'done' || !['pull', 'send'].includes(e.action || '')) continue;
    n += await run(store, 'UPDATE gates SET verified_at = $1 WHERE username = $2 AND phone = $3 AND verified_at IS NULL',
      [String(e.time || new Date().toISOString()), userKey(e.user), phone]);
  }
  await setMeta(store, 'gatesVerifiedBackfill', new Date().toISOString());
  return n;
}

// Tables with rows about one gate, keyed by its phone number (see db.ts).
const GATE_TABLES = ['gates', 'prefs', 'history', 'schedules', 'cameras', 'snapshots', 'notes', 'tx_history',
  'gate_files', 'gate_residents', 'gate_cards', 'gate_settings', 'gate_state', 'gate_working'];

// Deletes every row about the gate, in one transaction: every user's gate-list entry, prefs, history, schedules,
// camera settings, snapshot log, notes, transaction history, board files and the tables decoded from them. Returns the rows removed per table.
export async function deleteGateData(store: Store, phoneNumber: unknown): Promise<Record<string, number>> {
  const p = phoneDigits(phoneNumber);
  if (!p) throw err('Gate phone number required');
  const removed: Record<string, number> = {};
  await transaction(store, async (tx) => {
    for (const t of GATE_TABLES) removed[t] = await run(tx, `DELETE FROM ${t} WHERE phone = $1`, [p]);
  });
  return removed;
}

export async function removeGate(store: Store, user: unknown, phoneNumber: unknown): Promise<GateEntry[]> {
  const changes = await run(store, 'DELETE FROM gates WHERE username = $1 AND phone = $2', [userKey(user), phoneDigits(phoneNumber)]);
  if (!changes) throw err('Gate not in your list', 404);
  return listGates(store, user);
}
