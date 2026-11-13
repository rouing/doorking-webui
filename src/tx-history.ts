// Transaction history: every event ever pulled from a gate, oldest first, in the database's tx_history table.
// A transactions pull reads the gate's whole ring buffer (rcv_out.bin), which drops its oldest events as new ones
// arrive. Like DoorKing32's TRANS files, the history keeps them: each pull is matched against the saved tail and
// only the events after the overlap are added. Records keep the year inferred when they were first saved (the
// board stores no year).
import { all, one, run, transaction, type Store } from './db.ts';
import { orderRcvOut, parseRcvOut, type RcvRecord } from './board-files.ts';

export interface TxMerge { added: number; kept: number; gap: boolean }

const phoneDigits = (phone: unknown): string => String(phone || '').replace(/\D/g, '');
const valid = (t: RcvRecord) => t.month >= 1 && t.month <= 12 && t.day >= 1 && t.day <= 31;

export async function txHistoryCount(store: Store, phone: unknown): Promise<number> {
  const row = await one<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM tx_history WHERE phone = $1', [phoneDigits(phone)]);
  return row!.n;
}

// Adds a pulled rcv_out.bin to the gate's history. The pull starts with the oldest events still on the gate, so
// the longest run at the end of the saved history that equals the start of the pull is the overlap (kept); the
// rest is added. gap: nothing overlapped although history existed, so events may be missing between the two
// (the buffer wrapped past the last pull) or the gate's buffer was cleared.
export async function mergeTransactions(store: Store, phone: unknown, buf: Buffer, pulledAt: Date = new Date()): Promise<TxMerge> {
  const p = phoneDigits(phone);
  const pulled = orderRcvOut(buf, pulledAt).filter(valid);
  return transaction(store, async (tx) => {
    // One merge per gate at a time: the lock is held until the transaction ends.
    await one(tx, 'SELECT pg_advisory_xact_lock(hashtext($1))', [`tx_history:${p}`]);
    const tail = (await all<{ raw: string }>(tx, 'SELECT raw FROM tx_history WHERE phone = $1 ORDER BY seq DESC LIMIT $2',
      [p, pulled.length])).map((r) => r.raw).reverse();
    let kept = 0;
    for (let i = 0; i < tail.length && !kept; i++) {
      const n = tail.length - i;
      let j = 0;
      while (j < n && tail[i + j] === pulled[j].raw) j++;
      if (j === n) kept = n;
    }
    const fresh = pulled.slice(kept);
    const last = await one<{ seq: number | null }>(tx, 'SELECT MAX(seq) AS seq FROM tx_history WHERE phone = $1', [p]);
    const at = new Date().toISOString();
    const first = (last!.seq ?? 0) + 1;
    for (let i = 0; i < fresh.length; i += 1000) {
      const part = fresh.slice(i, i + 1000);
      await run(tx, `INSERT INTO tx_history (phone, seq, raw, year, added_at)
        SELECT $1::text, s, r, y, $2::timestamptz FROM unnest($3::int[], $4::text[], $5::int[]) AS t(s, r, y)`,
      [p, at, part.map((_, j) => first + i + j), part.map((t) => t.raw), part.map((t) => t.year as number)]);
    }
    return { added: fresh.length, kept, gap: tail.length > 0 && kept === 0 && pulled.length > 0 };
  });
}

// The gate's saved transactions, oldest first, as rcv_out.bin records with their year.
export async function readTransactions(store: Store, phone: unknown): Promise<RcvRecord[]> {
  return (await all<{ raw: string; year: number }>(store, 'SELECT raw, year FROM tx_history WHERE phone = $1 ORDER BY seq', [phoneDigits(phone)]))
    .map((r) => ({ ...parseRcvOut(Buffer.from(r.raw, 'hex'))[0], year: r.year }));
}
