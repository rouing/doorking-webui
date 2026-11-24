/**
 * @module web/ui/nav/quickJumpSearch
 *
 * Pure search and ranking helper for the Cmd/Ctrl+K Quick-Jump dialog across residents, vendors, cards, entry codes,
 * phone numbers, notes, recent transactions, and navigation pages.
 */
import type { ResidentRow, TransactionRow } from '../types.ts';
import { isEmptySlot, phoneFull } from '../format.ts';
import { NAV, pageShown, PINNED_NAV, type NavKey } from './pages.ts';

export type QuickJumpHit =
  | { kind: 'resident'; id: string; title: string; subtitle: string; score: number; resident: ResidentRow }
  | { kind: 'transaction'; id: string; title: string; subtitle: string; score: number; transaction: TransactionRow }
  | { kind: 'page'; id: string; title: string; subtitle: string; score: number; page: NavKey };

const MAX_RESULTS = 20;

/**
 * Searches residents, recent transactions, and navigation pages for `query` and returns up to 20 hits ordered by relevance.
 * Exact matches on card number, entry code, or directory code rank highest.
 *
 * @param query - Raw user search string.
 * @param options - Data sources available in the open gate.
 * @param options.residents - Working-copy resident and vendor rows.
 * @param options.transactions - Loaded transaction rows (newest first).
 * @param options.elevators - Whether elevator pages are shown for this gate.
 * @returns Ranked list of `QuickJumpHit` results.
 */
export function searchGate(
  query: string,
  { residents, transactions, elevators }: { residents: ResidentRow[]; transactions: TransactionRow[]; elevators: boolean },
): QuickJumpHit[] {
  const trimmed = query.trim().toLowerCase();
  const digits = trimmed.replace(/\D/g, '');
  const hits: QuickJumpHit[] = [];

  const navPages: { key: NavKey; label: string }[] = [...NAV, ...PINNED_NAV]
    .flatMap((item) => ('key' in item && pageShown(item.key, elevators) ? [{ key: item.key, label: item.label }] : []));
  if (!trimmed) {
    return navPages.slice(0, 10).map((item) => ({
      kind: 'page', id: `page-${item.key}`, title: item.label, subtitle: 'Page', score: 10, page: item.key,
    }));
  }

  for (const item of navPages) {
    const label = item.label.toLowerCase();
    if (label === trimmed || label.startsWith(trimmed) || label.includes(trimmed)) {
      hits.push({
        kind: 'page', id: `page-${item.key}`, title: item.label, subtitle: 'Page',
        score: label === trimmed ? 85 : label.startsWith(trimmed) ? 65 : 40,
        page: item.key,
      });
    }
  }

  for (const resident of residents) {
    if (isEmptySlot(resident)) continue;
    const code = resident.directoryCode.toLowerCase();
    const codeNoZero = code.replace(/^0+/, '') || '0';
    const entry = resident.entryCode.toLowerCase();
    const cards = resident.cards.map((card) => card.toLowerCase());
    const name = resident.name.toLowerCase();
    const phoneDigits = `${resident.areaCode}${resident.phone}`.replace(/\D/g, '');
    const note = (resident.note || '').toLowerCase();

    let score = 0;
    if (digits && (cards.some((card) => card === digits || card.replace(/^0+/, '') === digits) || entry === digits)) score = 100;
    else if (digits && (code === digits || codeNoZero === digits)) score = 95;
    else if (name.startsWith(trimmed)) score = 80;
    else if (name.includes(trimmed)) score = 70;
    else if (digits && digits.length >= 3 && (phoneDigits.includes(digits) || cards.some((card) => card.includes(digits)) || entry.includes(digits))) score = 60;
    else if (note.includes(trimmed)) score = 50;

    if (!score) continue;
    const details = [
      resident.type,
      `Code ${resident.directoryCode}`,
      resident.entryCode && `Entry ${resident.entryCode}`,
      phoneFull(resident),
      resident.cards.length && `Cards ${resident.cards.slice(0, 3).join(', ')}${resident.cards.length > 3 ? '…' : ''}`,
    ].filter(Boolean).join(' · ');
    hits.push({
      kind: 'resident', id: `res-${resident.directoryCode}`, title: resident.name || `Directory code ${resident.directoryCode}`,
      subtitle: details, score, resident,
    });
  }

  let txAdded = 0;
  for (let index = 0; index < transactions.length && txAdded < 6; index++) {
    const tx = transactions[index];
    const hay = `${tx.date} ${tx.time} ${tx.eventType} ${tx.number || ''} ${tx.name} ${tx.access} ${tx.directoryCode}`.toLowerCase();
    if (!hay.includes(trimmed)) continue;
    txAdded++;
    hits.push({
      kind: 'transaction',
      id: `tx-${tx.raw}-${index}`,
      title: `${tx.name || tx.eventType}${tx.number ? ` (${tx.number})` : ''}`,
      subtitle: `Transaction · ${tx.date} ${tx.time} · ${tx.access || tx.eventType}`,
      score: 35,
      transaction: tx,
    });
  }

  return hits.sort((first, second) => second.score - first.score || first.title.localeCompare(second.title)).slice(0, MAX_RESULTS);
}
