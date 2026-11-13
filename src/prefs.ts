// Local, gate-scoped preferences — things the DoorKing app keeps in its own ACCOUNT.DAT (never on the gate),
// such as relay labels. Keyed by the gate's system phone number so every account that manages the same
// physical gate shares the same labels. Stored in the database's prefs table (see db.ts), one JSON row per gate.
import { one, transaction, type Store } from './db.ts';
import type { DeviceRange, GatePrefs } from './types.ts';

// Normalise a phone number to digits so "214-555-0100" and "2145550100" share preferences.
const key = (phone: unknown): string => String(phone || '').replace(/\D/g, '');

export async function getPrefs(store: Store, phone: unknown): Promise<GatePrefs> {
  const row = await one<{ data: GatePrefs }>(store, 'SELECT data FROM prefs WHERE phone = $1', [key(phone)]);
  return row ? row.data : {};
}

// Merge `prefs` into the gate's stored preferences (shallow) and return the merged result.
// Keys set to undefined are removed.
export async function setPrefs(store: Store, phone: unknown, prefs: Record<string, unknown>): Promise<GatePrefs> {
  return transaction(store, async (tx) => {
    const old = await one<{ data: GatePrefs }>(tx, 'SELECT data FROM prefs WHERE phone = $1 FOR UPDATE', [key(phone)]);
    const merged: GatePrefs = JSON.parse(JSON.stringify({ ...(old ? old.data : {}), ...prefs }));
    await one(tx, 'INSERT INTO prefs (phone, data) VALUES ($1, $2) ON CONFLICT (phone) DO UPDATE SET data = excluded.data',
      [key(phone), JSON.stringify(merged)]);
    return merged;
  });
}

// Device Association (DoorKing32's "Dev Enable" window, kept only in ACCOUNT.DAT as CDeviceRecord): up to 10
// named card-number ranges. Names up to 12 characters, device codes 00001-65407 (DoorKing manual 3.7.2), ranges
// may not overlap.
export const DEVICE_MIN = 1;
export const DEVICE_MAX = 65407;
const DEVICE_NAME_MAX = 12;
export const DEFAULT_DEVICE_ASSOCIATION: DeviceRange[] = [{ name: 'Cards', from: '00001', to: '65407' }];

// Returns { rows } with 5-digit numbers and blank rows dropped, or { error }.
export function normalizeDeviceAssociation(list: unknown): { rows: DeviceRange[]; error?: undefined } | { error: string } {
  if (!Array.isArray(list)) return { error: 'Device association must be a list' };
  if (list.length > 10) return { error: 'Device association has at most 10 rows' };
  const rows: (DeviceRange & { n: number })[] = [];
  for (const [i, r] of (list as (Partial<Record<keyof DeviceRange, unknown>> | null)[]).entries()) {
    const name = String((r && r.name) ?? '').trim();
    const from = String((r && r.from) ?? '').trim();
    const to = String((r && r.to) ?? '').trim();
    if (!name && !from && !to) continue;
    const n = i + 1;
    if (!name) return { error: `Row ${n}: enter a device name` };
    if (name.length > DEVICE_NAME_MAX) return { error: `Row ${n}: device name is at most ${DEVICE_NAME_MAX} characters` };
    if (!/^\d{1,5}$/.test(from) || !/^\d{1,5}$/.test(to)) return { error: `Row ${n}: From and To must be numbers` };
    if ([from, to].some((v) => Number(v) < DEVICE_MIN || Number(v) > DEVICE_MAX)) {
      return { error: `Row ${n}: device codes are 00001-${DEVICE_MAX}` };
    }
    if (Number(from) > Number(to)) return { error: `Row ${n}: From is greater than To` };
    rows.push({ name, from: from.padStart(5, '0'), to: to.padStart(5, '0'), n });
  }
  const sorted = [...rows].sort((a, b) => Number(a.from) - Number(b.from));
  for (let i = 1; i < sorted.length; i++) {
    if (Number(sorted[i].from) <= Number(sorted[i - 1].to)) {
      return { error: `Rows ${sorted[i - 1].n} and ${sorted[i].n} overlap` };
    }
  }
  return { rows: rows.map(({ name, from, to }) => ({ name, from, to })) };
}

// Device name for a card number, as DoorKing32 shows it in a card transaction's Event Type: the first row whose
// From-To range holds the number, else '' (DoorKing32 shows a blank).
export function deviceNameFor(rows: DeviceRange[] | null | undefined, card: number | string): string {
  const n = Number(card);
  const d = (rows || []).find((r) => n >= Number(r.from) && n <= Number(r.to));
  return d ? d.name : '';
}
