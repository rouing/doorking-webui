// Display helpers shared by the tables.
import type { DeviceRange, GateFeatures, GatePrefs, GateTracker, ResidentRow, TransactionRow } from '../../src/types.ts';

export const cell = (v: unknown): string => (Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v));

// Compares two cell values: numeric when both look numeric, else case-insensitive with numbers in order.
export function cmpCells(a: unknown, b: unknown): number {
  const sa = cell(a);
  const sb = cell(b);
  const na = Number(sa);
  const nb = Number(sb);
  if (sa !== '' && sb !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return sa.localeCompare(sb, undefined, { numeric: true });
}

// An unused directory slot: no name, phone, entry code or cards (the gate keeps the slot's code, flag 0x00).
export const isEmptySlot = (r: ResidentRow) => !r.name && !r.phone && !r.entryCode && !(r.cards && r.cards.length);

// The phone as one value; the gate stores the area code (3 digits, or 4 as 1 + area code for long distance) and
// the 7-digit number separately.
export function phoneFull(r: ResidentRow): string {
  const local = (r.phone || '').replace(/\D/g, '');
  if (!local) return '';
  const full = (r.areaCode || '') + local;
  return full.length === 10 || full.length === 11 ? formatPhoneDigits(full)
    : local.length === 7 ? `${local.slice(0, 3)}-${local.slice(3)}` : full;
}

// Partial phone digits as typed: up to 7 as 555-1234, 8-10 as (918) 555-0142, 11 as 1 (918) 555-0142.
export const formatPhoneDigits = (d: string) => (d.length <= 7
  ? (d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d)
  : d.length === 11 ? `${d[0]} (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
    : `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`);

// Device Association name for a card number, or null when no range holds it.
export function deviceFor(devices: DeviceRange[], num: string | number): string | null {
  const n = Number(num);
  const d = devices.find((r) => n >= Number(r.from) && n <= Number(r.to));
  return d ? d.name : null;
}
export const DEFAULT_DEVICES: DeviceRange[] = [{ name: 'Cards', from: '00001', to: '65407' }];

// The gate's Tracker switches; Tracker 1/2 count only while Tracker is on.
export const trackerOf = (prefs: GatePrefs): GateTracker => {
  const enabled = prefs.tracker?.enabled === true;
  return { enabled, tracker1: enabled && prefs.tracker?.tracker1 === true, tracker2: enabled && prefs.tracker?.tracker2 === true };
};

// Relays 0-2, plus 3-10 with Tracker 2 and 11-18 with Tracker 1.
export const trackerRelays = (t: GateTracker): number[] => [0, 1, 2,
  ...(t.tracker2 ? Array.from({ length: 8 }, (_, i) => 3 + i) : []), ...(t.tracker1 ? Array.from({ length: 8 }, (_, i) => 11 + i) : [])];

// The gate's Floors/Elevators switches (System Settings > Gate configuration); shown unless turned off.
export const featuresOf = (prefs: GatePrefs): GateFeatures => ({
  floors: prefs.features?.floors !== false, elevators: prefs.features?.elevators !== false,
});

// Security level as shown: 0 = Disabled, 1 = Enabled (always valid), else the level number. The gate stores the number.
export const securityText = (level: unknown): string => {
  const s = cell(level);
  return s === '0' ? 'Disabled' : s === '1' ? 'Enabled' : s;
};

// Text of a directory column (hidden flag, combined phone, security level, blank floor/elevator).
export function dirCell(r: ResidentRow, key: string): string {
  if (key === 'hidden') return r.hidden ? 'Hidden' : '';
  if (key === 'phoneFull') return phoneFull(r);
  if (key === 'securityLevel') return securityText(r.securityLevel);
  return cell((r as unknown as Record<string, unknown>)[key]);
}

// Transaction event types that are gate/system actions (uploads, downloads, hold schedule, APB maintenance).
const TX_SYSTEM = new Set(['System', 'Hold Begin', 'Hold End', 'Modem-to-Modem', 'RS232', 'Modem', 'APB Re-Sync', 'APB Counter']);

// Row colour of a transaction: denied red, system actions amber, admitted green.
export function txTone(t: TransactionRow): 'red' | 'amber' | 'green' | null {
  if (t.access === 'Deny') return 'red';
  if (TX_SYSTEM.has(t.eventType) || (!t.eventType && !t.lookup && t.name)) return 'amber';
  if (t.access === 'Admit') return 'green';
  return null;
}

// Finds the resident/vendor a transaction refers to: by its resolved directory code, else by its Number,
// matched as the transaction's lookup says (directory code, entry code or card).
export function residentFinder(rows: ResidentRow[]): (t: TransactionRow) => ResidentRow | null {
  const by = { directory: new Map<unknown, ResidentRow>(), entryCode: new Map<unknown, ResidentRow>(), card: new Map<unknown, ResidentRow>() };
  for (const r of rows) {
    if (isEmptySlot(r)) continue;
    by.directory.set(r.directoryCode, r);
    if (r.entryCode) by.entryCode.set(r.entryCode, r);
    for (const c of r.cards) by.card.set(Number(c), r);
  }
  return (t) => {
    if (t.directoryCode && by.directory.has(t.directoryCode)) return by.directory.get(t.directoryCode)!;
    if (!t.lookup || !t.number) return null;
    return by[t.lookup].get(t.lookup === 'card' ? Number(t.number) : t.number) || null;
  };
}

// Downloads rows as a CSV file.
export function downloadCsv(name: string, header: string[], rows: string[][]) {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const text = [header, ...rows].map((l) => l.map(esc).join(',')).join('\r\n') + '\r\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// An account phone number (E.164) for display: +1 (214) 555-0100 for US/Canada, else as stored.
export const fmtIntlPhone = (e164: string) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164 || '';
};
export const fmtTime = (t: string | number | undefined | null) => (t ? new Date(t).toLocaleString('en-US') : '');
