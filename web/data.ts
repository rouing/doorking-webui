import { decodeRcvEvent, residentRows, type RcvRecord, type ResidentsData } from '../src/board-files.ts';
import { DEFAULT_DEVICE_ASSOCIATION, deviceNameFor } from '../src/prefs.ts';
import { minuteKey } from '../src/cameras.ts';
import type { DeviceRange, TransactionRow } from '../src/types.ts';
import type { WorkingState } from '../src/gate-state.ts';

// A gate file's contents and when it was pulled (the latest pull, from gate_files).
export interface FileRead { data: Buffer; mtime: Date }
export type GateFiles = Partial<Record<'names.bin' | 'phone.bin' | 'cards.bin', FileRead>>;

// Residents from names.bin + phone.bin + cards.bin, joined on directory code.
export function residents(files: GateFiles): (ResidentsData & { updated: Date | undefined }) | null {
  const names = files['names.bin'] || null;
  const phones = files['phone.bin'] || null;
  const cards = files['cards.bin'] || null;
  if (!names && !phones && !cards) return null;
  const { rows, unassignedCards } = residentRows({ names: names && names.data, phone: phones && phones.data, cards: cards && cards.data });
  const updated = [names, phones, cards].filter((f) => f !== null).map((f) => f.mtime).sort().pop();
  return { updated, rows, unassignedCards };
}

// Transactions from the saved history (see tx-history.ts), with resident names looked up in the working copy's values
// (gate_residents, gate_cards) by directory code, entry code or card. Card events take their Event Type from the
// Device Association ranges, as DoorKing32 does. updated: the last transactions pull; null (no transactions yet)
// when the gate was never read.
function transactions(pulledAt: Date | null, values: WorkingState | null,
  devices: DeviceRange[] | null | undefined = DEFAULT_DEVICE_ASSOCIATION,
  history?: RcvRecord[] | null): { updated: Date; rows: TransactionRow[] } | null {
  if (!pulledAt) return null;
  type Who = { name: string; directoryCode: string };
  const by = { card: new Map<string | null, Who>(), entryCode: new Map<string | null, Who>(), directory: new Map<string | null, Who>() };
  for (const r of values ? values.residents : []) {
    if (r.entryCode) by.entryCode.set(r.entryCode, r);
    by.directory.set(r.directoryCode, r);
  }
  // A card assigned to a code with no directory entry still shows that code (with no name).
  for (const c of values ? values.cards : []) {
    if (c.directoryCode) by.card.set(c.cardNumber, by.directory.get(c.directoryCode) || { name: '', directoryCode: c.directoryCode });
  }
  const rows = (history || [])
    .filter((t) => t.month >= 1 && t.month <= 12 && t.day >= 1 && t.day <= 31)
    .reverse()
    .map((t) => {
      const ev = decodeRcvEvent(t);
      const who = ev.lookup ? by[ev.lookup].get(ev.number) : null;
      const hour24 = (t.hour % 12) + (t.pm ? 12 : 0);
      const ts = new Date(t.year as number, t.month - 1, t.day, hour24, t.minute).getTime();
      return {
        ts,
        minute: minuteKey(ts), // snapshot folder (see cameras.ts)
        date: `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`,
        time: `${t.hour}:${String(t.minute).padStart(2, '0')} ${t.pm ? 'PM' : 'AM'}`,
        eventType: ev.eventType === 'Cards' ? deviceNameFor(devices, ev.number as string) : ev.eventType,
        number: ev.number,
        lookup: ev.lookup,
        name: who ? who.name : ev.lookup === 'card' && values ? 'Unknown' : ev.name,
        access: ev.access,
        relay: ev.relay,
        apb: ev.apb,
        directoryCode: who ? who.directoryCode : '',
        raw: t.raw,
      };
    });
  return { updated: pulledAt, rows };
}

export { residentRows };

// pulledAt: the last transactions pull (txPulledAt); values: the working copy's values (loadWorkingState), or null;
// history: the saved transactions (readTransactions).
export function loadData(pulledAt: Date | null, values: WorkingState | null, devices?: DeviceRange[] | null, history?: RcvRecord[] | null) {
  return { transactions: transactions(pulledAt, values, devices, history) };
}
