import { useMemo, useState } from 'react';
import { Button, Flex, Heading, Link, Progress, Select, Table, Text, TextField } from '@radix-ui/themes';
import type { ResidentRow, TransactionRow } from '../../../src/types.ts';
import { cell, downloadCsv, fmtTime, residentFinder, txTone } from '../format.ts';
import { MAX_ROWS, nextSort, SortHead, sortRows, type Column, type Sort } from '../table.tsx';
import { SnapCell } from '../camera/SnapViews.tsx';
import type { Snaps } from '../camera/snapshots.ts';

export const TX_COLUMNS: Column[] = [['Date', 'date'], ['Time', 'time'], ['Event Type', 'eventType'], ['Number', 'number'],
  ['Name', 'name'], ['Access', 'access'], ['Relay', 'relay'], ['APB', 'apb'], ['Directory Code', 'directoryCode']];

const txValue = (col: string) => (col === 'time'
  ? (t: TransactionRow) => { const d = new Date(t.ts); return d.getHours() * 60 + d.getMinutes(); }
  : (t: TransactionRow) => (t as unknown as Record<string, unknown>)[col]);

// The gate's transaction log (rcv_out.bin), newest first. Names and numbers link to the resident/vendor; with
// camera settings saved, a Camera column shows each transaction's pictures (or videos).
export function Transactions({ tx, residents, onOpenResident, snaps, onOpenSnap }: {
  tx: { updated: string; rows: TransactionRow[] } | null;
  residents: ResidentRow[];
  onOpenResident: (r: ResidentRow) => void;
  snaps: Snaps;
  onOpenSnap: (t: TransactionRow) => void;
}) {
  const cols: Column[] = snaps.settings ? [...TX_COLUMNS, ['Camera', 'snap']] : TX_COLUMNS;
  const p = snaps.run && snaps.running ? snaps.run.progress : undefined;
  const [days, setDays] = useState('7');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);
  const who = useMemo(() => residentFinder(residents), [residents]);

  const rows = useMemo(() => {
    let out = tx ? tx.rows : [];
    const n = Number(days);
    if (n && out.length) {
      const since = out[0].ts - n * 86400000;
      out = out.filter((t) => t.ts >= since);
    }
    const q = filter.trim().toLowerCase();
    if (q) out = out.filter((t) => Object.values(t).join(' ').toLowerCase().includes(q));
    return sortRows(out, sort, txValue);
  }, [tx, days, filter, sort]);

  const link = (text: string, r: ResidentRow) => (
    <Link href="#" title={`Open ${r.name || `directory code ${r.directoryCode}`} (code ${r.directoryCode})`}
      onClick={(e) => { e.preventDefault(); onOpenResident(r); }}>{text}</Link>
  );

  const csv = () => downloadCsv('transactions.csv', TX_COLUMNS.map((c) => c[0]),
    rows.map((t) => TX_COLUMNS.map(([, k]) => cell((t as unknown as Record<string, unknown>)[k]))));

  return (
    <Flex direction="column" gap="3">
      <Heading>Transactions</Heading>
      <Flex gap="3" align="center" wrap="wrap">
        <Select.Root value={days} onValueChange={setDays}>
          <Select.Trigger />
          <Select.Content>
            <Select.Item value="1">Last 24 hours</Select.Item>
            <Select.Item value="7">Last 7 days</Select.Item>
            <Select.Item value="30">Last 30 days</Select.Item>
            <Select.Item value="0">All</Select.Item>
          </Select.Content>
        </Select.Root>
        <TextField.Root type="search" placeholder="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button variant="soft" onClick={csv} disabled={!rows.length}>Download CSV</Button>
        {snaps.settings && (
          <Button variant="soft" disabled={snaps.running} onClick={snaps.runAll}>
            {snaps.video ? 'Get camera videos' : 'Get camera snapshots'}
          </Button>
        )}
        {snaps.settings && snaps.running && (
          <Button variant="soft" color="gray" disabled={Boolean(snaps.run?.stopping)} onClick={snaps.stop}>
            {snaps.video ? 'Stop videos' : 'Stop snapshots'}
          </Button>
        )}
        {snaps.settings && snaps.running && (
          <Progress value={p && p.frames ? (p.framesDone / p.frames) * 100 : undefined} style={{ width: 120 }} />
        )}
        <Text size="2" color="gray">
          {!tx ? 'No transactions yet. Pull transactions from the gate.'
            : `${rows.length} transactions${rows.length > MAX_ROWS ? ` (first ${MAX_ROWS} shown)` : ''} · downloaded ${fmtTime(tx.updated)}`}
        </Text>
      </Flex>
      {snaps.settings && snaps.info && <Text size="2" color="gray">{snaps.info}</Text>}
      <Table.Root size="1" variant="surface">
        <SortHead cols={cols} sort={sort} onSort={(k) => { if (k !== 'snap') setSort(nextSort(sort, k, true)); }}
          title={(k) => (k === 'time' ? 'Click to sort. After sorting by Date, sorts the times within each date.' : 'Click to sort')} />
        <Table.Body>
          {rows.slice(0, MAX_ROWS).map((t, i) => {
            const r = who(t);
            const tone = txTone(t);
            return (
              <Table.Row key={`${t.raw}-${i}`} style={tone ? { background: `var(--${tone}-a3)` } : undefined}>
                {cols.map(([, k]) => (
                  <Table.Cell key={k}>
                    {k === 'snap' ? <SnapCell t={t} snaps={snaps} onOpen={onOpenSnap} />
                      : r && k === 'name' && t.name && t.directoryCode ? link(t.name, r)
                      : r && k === 'number' && t.number ? link(t.number, r)
                        : cell((t as unknown as Record<string, unknown>)[k])}
                  </Table.Cell>
                ))}
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Flex>
  );
}
