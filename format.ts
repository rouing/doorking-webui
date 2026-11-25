/**
 * @module web/ui/format
 *
 * Display helpers shared by the tables.
 */
import type { GateFeatures, GatePrefs, GateTracker, Job, ResidentRow, TransactionRow } from './types.ts';
import { fmtIntlPhone, fmtPhone, formatPhoneDigits } from './lib/shared.ts';
export { fmtIntlPhone, formatPhoneDigits };
import { NO_FOOTAGE_EVENTS } from './lib/shared.ts';

export { doorKingCsv, downloadCsv, downloadText } from './csv.ts';

/**
 * A row's value for a column key (a field of the row; undefined when it has none).
 *
 * @param row - `object` value.
 * @param key - Lookup key, API key, or setting key.
 * @returns `unknown` result.
 */
export const fieldOf = (row: object, key: string): unknown => (row as { [field: string]: unknown })[key];

/**
 * Cell.
 *
 * @param value - Input value.
 * @returns `string` result.
 */
export const cell = (value: unknown): string => (Array.isArray(value) ? value.join(' ') : value == null ? '' : String(value));

/**
 * Compares two cell values: numeric when both look numeric, else case-insensitive with numbers in order.
 *
 * @param a - First value to compare.
 * @param b - Second value to compare.
 * @returns `number` result.
 */
export function cmpCells(a: unknown, b: unknown): number {
  const textA = cell(a);
  const textB = cell(b);
  const numberA = Number(textA);
  const numberB = Number(textB);
  if (textA !== '' && textB !== '' && !Number.isNaN(numberA) && !Number.isNaN(numberB)) return numberA - numberB;
  return textA.localeCompare(textB, undefined, { numeric: true });
}

/**
 * An unused directory slot: no name, phone, entry code or cards (the gate keeps the slot's code, flag 0x00).
 *
 * @param resident - Resident/vendor row.
 * @returns Computed result.
 */
export const isEmptySlot = (resident: ResidentRow) => !resident.name && !resident.phone && !resident.entryCode && !(resident.cards && resident.cards.length);

/**
 * The phone as one value; the gate stores the area code (3 digits, or 4 as 1 + area code for long distance) and
 * the 7-digit number separately.
 *
 * @param resident - Resident/vendor row.
 * @returns `string` result.
 */
export function phoneFull(resident: ResidentRow): string {
  const local = (resident.phone || '').replace(/\D/g, '');
  if (!local) return '';
  const full = (resident.areaCode || '') + local;
  return fmtPhone(full);
}

/**
 * The gate's Tracker switches; Tracker 1/2 count only while Tracker is on.
 *
 * @param prefs - Gate-scoped preferences object.
 * @returns `GateTracker` result.
 */
export const trackerOf = (prefs: GatePrefs): GateTracker => {
  const enabled = prefs.tracker?.enabled === true;
  return { enabled, tracker1: enabled && prefs.tracker?.tracker1 === true, tracker2: enabled && prefs.tracker?.tracker2 === true };
};

/**
 * Relays 0-2, plus 3-10 with Tracker 2 and 11-18 with Tracker 1.
 *
 * @param tracker - `GateTracker` value.
 * @returns `number[]` result.
 */
export const trackerRelays = (tracker: GateTracker): number[] => [0, 1, 2,
  ...(tracker.tracker2 ? Array.from({ length: 8 }, (_, i) => 3 + i) : []), ...(tracker.tracker1 ? Array.from({ length: 8 }, (_, i) => 11 + i) : [])];

/**
 * The gate's Floors/Elevators switches (System Settings > Gate configuration); shown unless turned off.
 *
 * @param prefs - Gate-scoped preferences object.
 * @returns `GateFeatures` result.
 */
export const featuresOf = (prefs: GatePrefs): GateFeatures => ({
  floors: prefs.features?.floors !== false, elevators: prefs.features?.elevators !== false,
});

/**
 * Security level as shown: 0 = Disabled, 1 = Enabled (always valid), else the level number. The gate stores the number.
 *
 * @param level - `unknown` value.
 * @returns `string` result.
 */
export const securityText = (level: unknown): string => {
  const text = cell(level);
  return text === '0' ? 'Disabled' : text === '1' ? 'Enabled' : text;
};

/**
 * Text of a directory column (hidden flag, combined phone, security level, blank floor/elevator).
 *
 * @param resident - Resident/vendor row.
 * @param key - Lookup key, API key, or setting key.
 * @returns `string` result.
 */
export function dirCell(resident: ResidentRow, key: string): string {
  if (key === 'hidden') return resident.hidden ? 'Hidden' : '';
  if (key === 'phoneFull') return phoneFull(resident);
  if (key === 'securityLevel') return securityText(resident.securityLevel);
  return cell(fieldOf(resident, key));
}

/** Transaction event types that are gate/system actions: the ones that never get camera footage, and System. */
const TX_SYSTEM = new Set([...NO_FOOTAGE_EVENTS, 'System']);

/**
 * Row colour of a transaction: denied red, system actions amber, admitted green.
 *
 * @param transaction - Transaction record or row.
 * @returns `'red' | 'amber' | 'green' | null` result.
 */
export function txTone(transaction: TransactionRow): 'red' | 'amber' | 'green' | null {
  if (transaction.access === 'Deny') return 'red';
  if (TX_SYSTEM.has(transaction.eventType) || (!transaction.eventType && !transaction.lookup && transaction.name)) return 'amber';
  if (transaction.access === 'Admit') return 'green';
  return null;
}

/**
 * Finds the resident/vendor a transaction refers to: by its resolved directory code, else by its Number,
 * matched as the transaction's lookup says (directory code, entry code or card).
 *
 * @param rows - List of data rows.
 * @returns `(transaction: TransactionRow) => ResidentRow | null` result.
 */
export function residentFinder(rows: ResidentRow[]): (transaction: TransactionRow) => ResidentRow | null {
  const by = { directory: new Map<unknown, ResidentRow>(), entryCode: new Map<unknown, ResidentRow>(), card: new Map<unknown, ResidentRow>() };
  for (const resident of rows) {
    if (isEmptySlot(resident)) continue;
    by.directory.set(resident.directoryCode, resident);
    if (resident.entryCode) by.entryCode.set(resident.entryCode, resident);
    for (const card of resident.cards) by.card.set(Number(card), resident);
  }
  return (transaction) => {
    if (transaction.directoryCode && by.directory.has(transaction.directoryCode)) return by.directory.get(transaction.directoryCode)!;
    if (!transaction.lookup || !transaction.number) return null;
    return by[transaction.lookup].get(transaction.lookup === 'card' ? Number(transaction.number) : transaction.number) || null;
  };
}

export const fmtTime = (time: string | number | undefined | null) => (time ? new Date(time).toLocaleString('en-US') : '');

/** Concise status pill label for a gate connection job (never overflows compact mobile/sidebar chips). */
export function jobLabel(job: Job | null): string {
  if (!job || job.state === 'idle') return '';
  if (job.state === 'running') return 'Running';
  if (job.state === 'done') return 'Done';
  if (job.state === 'failed') return 'Failed';
  return '';
}

const PORTAL_HOLD_MATCH_WINDOW_MS = 90_000;

function isPortalOpenRow(tx: TransactionRow): boolean {
  return tx.source === 'portal' || tx.eventType?.toLowerCase() === 'portal open';
}

function relaysCompatible(a?: string, b?: string): boolean {
  const na = (a || '').trim().toLowerCase();
  const nb = (b || '').trim().toLowerCase();
  return !na || !nb || na === nb;
}

function withinPortalWindow(portal: TransactionRow, candidate: TransactionRow): boolean {
  if (!relaysCompatible(portal.relay, candidate.relay)) return false;
  if (portal.ts > 0 && candidate.ts > 0) return Math.abs(portal.ts - candidate.ts) <= PORTAL_HOLD_MATCH_WINDOW_MS;
  return Boolean(portal.minute && portal.minute === candidate.minute);
}

/**
 * Hides Hold Begin + Hold End pairs generated by a Portal Open momentary buzz when BOTH match the Portal Open's
 * time window and relay (matching native Android `hidePortalHoldNoise`).
 */
export function hidePortalHoldNoise(rows: TransactionRow[]): TransactionRow[] {
  const portalIndices: number[] = [];
  rows.forEach((r, idx) => { if (isPortalOpenRow(r)) portalIndices.push(idx); });
  if (!portalIndices.length) return rows;

  const hidden = new Set<number>();
  for (const pIdx of portalIndices) {
    const portal = rows[pIdx];
    const beginIdx = rows.findIndex((r, i) => !hidden.has(i) && r.eventType?.toLowerCase() === 'hold begin' && withinPortalWindow(portal, r));
    if (beginIdx < 0) continue;
    const endIdx = rows.findIndex((r, i) => !hidden.has(i) && r.eventType?.toLowerCase() === 'hold end' && withinPortalWindow(portal, r)
      && (rows[beginIdx].ts <= 0 || r.ts <= 0 || Math.abs(r.ts - rows[beginIdx].ts) <= PORTAL_HOLD_MATCH_WINDOW_MS));
    if (endIdx < 0) continue;
    hidden.add(beginIdx);
    hidden.add(endIdx);
  }
  return hidden.size ? rows.filter((_, i) => !hidden.has(i)) : rows;
}
