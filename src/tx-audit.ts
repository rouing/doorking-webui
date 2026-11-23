/**
 * @module src/tx-audit
 *
 * Access hygiene and operational analytics over `tx_history`, `gate_residents`, `gate_cards`, and `snapshots`:
 * dormant credentials, active unassigned/unknown cards, high-frequency/possibly leaked entry codes, and traffic stats.
 */
import { decodeRcvEvent, hasValidDate, type RcvRecord } from './board-files.ts';
import { minuteKey, listSnapshots } from './camera-log.ts';
import { loadWorkingState, type WorkingState } from './gate-state.ts';
import { readTransactionPage } from './tx-history.ts';
import type { Store } from './db.ts';
import type { AccessAuditReply, DormantEntry, EntryCodeUsage, SnapshotMinute, UnknownCardActivity } from './types.ts';

const DAY_MS = 86400000;

type ResidentState = WorkingState['residents'][number];
type CardState = WorkingState['cards'][number];

interface WorkingIndex {
  residents: ResidentState[];
  residentByCode: Map<string, ResidentState>;
  cardsByCode: Map<string, string[]>;
  ownerByCard: Map<string, string>;
  ownerByEntry: Map<string, string>;
}

interface CollectedStats {
  residentLastSeen: Map<string, { lastSeen: number; totalEvents: number }>;
  unknownCards: Map<string, { uses: number; admits: number; denies: number; lastSeen: number; lastMinute: string }>;
  entryStats: Map<string, { uses: number; days: Set<string>; offHours: number; lastSeen: number }>;
  byHour: number[];
  byDayMap: Map<string, { admits: number; denies: number }>;
  totalEvents: number;
  admits: number;
  denies: number;
  holds: number;
  openCycles: number;
}

function indexWorkingCopy(residents: ResidentState[], cards: CardState[]): WorkingIndex {
  const cardsByCode = new Map<string, string[]>();
  const ownerByCard = new Map<string, string>();
  for (const card of cards) {
    if (!card.directoryCode) continue;
    ownerByCard.set(card.cardNumber, card.directoryCode);
    const list = cardsByCode.get(card.directoryCode) || [];
    list.push(card.cardNumber);
    cardsByCode.set(card.directoryCode, list);
  }
  const residentByCode = new Map(residents.map((res) => [res.directoryCode, res]));
  const ownerByEntry = new Map<string, string>();
  for (const res of residents) {
    if (res.entryCode) ownerByEntry.set(res.entryCode, res.directoryCode);
  }
  return { residents, residentByCode, cardsByCode, ownerByCard, ownerByEntry };
}

function collectTransactionStats(records: RcvRecord[], index: WorkingIndex, cutoff: number, trafficCutoff: number): CollectedStats {
  const stats: CollectedStats = {
    residentLastSeen: new Map(),
    unknownCards: new Map(),
    entryStats: new Map(),
    byHour: Array.from({ length: 24 }, () => 0),
    byDayMap: new Map(),
    totalEvents: 0,
    admits: 0,
    denies: 0,
    holds: 0,
    openCycles: 0,
  };

  for (const rec of records) {
    if (!hasValidDate(rec) || !rec.year) continue;
    const hour24 = (rec.hour % 12) + (rec.pm ? 12 : 0);
    const ts = new Date(rec.year, rec.month - 1, rec.day, hour24, rec.minute).getTime();
    const dateKey = `${rec.year}-${String(rec.month).padStart(2, '0')}-${String(rec.day).padStart(2, '0')}`;
    const event = decodeRcvEvent(rec);

    const dirCode = event.lookup === 'directory' && event.number ? event.number
      : event.lookup === 'entryCode' && event.number ? (index.ownerByEntry.get(event.number) || '')
      : event.lookup === 'card' && event.number ? (index.ownerByCard.get(event.number) || '')
      : '';

    if (dirCode) {
      const prev = stats.residentLastSeen.get(dirCode);
      stats.residentLastSeen.set(dirCode, {
        lastSeen: prev ? Math.max(prev.lastSeen, ts) : ts,
        totalEvents: (prev?.totalEvents || 0) + 1,
      });
    }

    if (ts < cutoff) continue;

    stats.totalEvents++;
    stats.byHour[hour24]++;
    const isAdmit = event.access === 'Admit' || event.access === 'Open';
    const isDeny = event.access === 'Deny';
    if (isAdmit) { stats.admits++; stats.openCycles++; }
    else if (isDeny) stats.denies++;
    if (event.eventType === 'Hold Begin') stats.holds++;
    if (event.eventType === 'Open Request') stats.openCycles++;

    if (ts >= trafficCutoff) {
      const dayBucket = stats.byDayMap.get(dateKey) || { admits: 0, denies: 0 };
      if (isAdmit) dayBucket.admits++;
      else if (isDeny) dayBucket.denies++;
      stats.byDayMap.set(dateKey, dayBucket);
    }

    if (event.lookup === 'card' && event.number && !index.ownerByCard.has(event.number)) {
      const cur = stats.unknownCards.get(event.number) || { uses: 0, admits: 0, denies: 0, lastSeen: 0, lastMinute: '' };
      cur.uses++;
      if (isAdmit) cur.admits++;
      else if (isDeny) cur.denies++;
      if (ts >= cur.lastSeen) { cur.lastSeen = ts; cur.lastMinute = minuteKey(ts); }
      stats.unknownCards.set(event.number, cur);
    }

    if (event.lookup === 'entryCode' && event.number && event.access === 'Admit') {
      const cur = stats.entryStats.get(event.number) || { uses: 0, days: new Set<string>(), offHours: 0, lastSeen: 0 };
      cur.uses++;
      cur.days.add(dateKey);
      if (hour24 >= 23 || hour24 < 5) cur.offHours++;
      if (ts > cur.lastSeen) cur.lastSeen = ts;
      stats.entryStats.set(event.number, cur);
    }
  }
  return stats;
}

function findDormantEntries(index: WorkingIndex, stats: CollectedStats, cutoff: number): DormantEntry[] {
  const dormant: DormantEntry[] = [];
  for (const res of index.residents) {
    if (!res.name.trim()) continue;
    const resCards = index.cardsByCode.get(res.directoryCode) || [];
    if (!res.entryCode && !resCards.length) continue;
    const activity = stats.residentLastSeen.get(res.directoryCode);
    if (activity && activity.lastSeen >= cutoff) continue;
    dormant.push({
      directoryCode: res.directoryCode,
      name: res.name,
      type: res.type,
      entryCode: res.entryCode,
      cards: resCards,
      lastSeen: activity ? new Date(activity.lastSeen).toISOString() : null,
      totalEvents: activity?.totalEvents || 0,
    });
  }
  return dormant.sort((a, b) =>
    (a.lastSeen ? new Date(a.lastSeen).getTime() : 0) - (b.lastSeen ? new Date(b.lastSeen).getTime() : 0)
    || a.directoryCode.localeCompare(b.directoryCode));
}

function summarizeUnknownCards(stats: CollectedStats, snapshots: Record<string, SnapshotMinute>): UnknownCardActivity[] {
  return [...stats.unknownCards.entries()]
    .map(([cardNumber, info]) => ({
      cardNumber,
      uses: info.uses,
      admits: info.admits,
      denies: info.denies,
      lastSeen: new Date(info.lastSeen).toISOString(),
      lastMinute: info.lastMinute,
      hasSnapshot: Boolean(snapshots[info.lastMinute]?.files?.length),
    }))
    .sort((a, b) => b.uses - a.uses || b.lastSeen.localeCompare(a.lastSeen));
}

function summarizeEntryCodes(index: WorkingIndex, stats: CollectedStats): EntryCodeUsage[] {
  return [...stats.entryStats.entries()]
    .map(([entryCode, info]) => {
      const ownerCode = index.ownerByEntry.get(entryCode) || '';
      const owner = ownerCode ? index.residentByCode.get(ownerCode) : undefined;
      return {
        entryCode,
        directoryCode: ownerCode,
        name: owner?.name || '',
        type: owner?.type || '',
        uses: info.uses,
        distinctDays: info.days.size,
        offHoursUses: info.offHours,
        lastSeen: new Date(info.lastSeen).toISOString(),
        flagged: (info.uses >= 30 && info.days.size >= 10) || info.offHours >= 10,
      };
    })
    .sort((a, b) => b.uses - a.uses);
}

/** Builds the access hygiene and traffic audit report for a gate over the trailing `days` window. */
export async function buildAccessAudit(
  store: Store,
  phone: string,
  { days = 90, now = Date.now() }: { days?: number; now?: number } = {},
): Promise<AccessAuditReply> {
  const [{ records }, working, snapshots] = await Promise.all([
    readTransactionPage(store, phone),
    loadWorkingState(store, phone),
    listSnapshots(store, phone),
  ]);
  const index = indexWorkingCopy(working?.state.residents || [], working?.state.cards || []);
  const cutoff = now - days * DAY_MS;
  const stats = collectTransactionStats(records, index, cutoff, now - 30 * DAY_MS);
  const byDay = [...stats.byDayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));

  return {
    days,
    dormant: findDormantEntries(index, stats, cutoff),
    unknownCards: summarizeUnknownCards(stats, snapshots),
    entryCodes: summarizeEntryCodes(index, stats),
    traffic: {
      totalEvents: stats.totalEvents,
      admits: stats.admits,
      denies: stats.denies,
      holds: stats.holds,
      openCycles: stats.openCycles,
      byHour: stats.byHour,
      byDay,
    },
  };
}
