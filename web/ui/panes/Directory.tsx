import { Fragment, useEffect, useMemo, useState } from 'react';
import { Box, Button, Callout, Card, Flex, Heading, Table, Text, TextField } from '@radix-ui/themes';
import type { DeviceRange, GateFeatures, ResidentRow, ResidentsReply, TransactionRow } from '../../../src/types.ts';
import { dirCell, downloadCsv, fmtTime, isEmptySlot, txTone } from '../format.ts';
import { MAX_ROWS, nextSort, SortHead, sortRows, type Column, type Sort } from '../table.tsx';
import { CardList } from './fields.tsx';
import { SnapCell } from '../camera/SnapViews.tsx';
import type { Snaps } from '../camera/snapshots.ts';
import { ResidentForm } from './ResidentForm.tsx';
import { TX_COLUMNS } from './Transactions.tsx';
import { WorkingCopyBar } from './WorkingCopyBar.tsx';
import { useReadOnly, type GateApi } from '../api.ts';

const COLUMNS: Record<'residents' | 'vendors', Column[]> = {
  residents: [['Directory Code', 'directoryCode'], ['Name', 'name'], ['Hidden', 'hidden'], ['Phone', 'phoneFull'],
    ['Entry Code', 'entryCode'], ['Security', 'securityLevel'], ['Floor', 'floor'], ['Elevator', 'elevatorRef'], ['Cards', 'cards'],
    ['Notes', 'note']],
  vendors: [['Directory Code', 'directoryCode'], ['Name', 'name'], ['Entry Code', 'entryCode'], ['Security', 'securityLevel'],
    ['Cards', 'cards'], ['Notes', 'note']],
};
const HISTORY_COLUMNS = TX_COLUMNS.filter(([, k]) => k !== 'name' && k !== 'directoryCode');

// Residents or vendors in the working copy. Clicking a row shows its last 5 transactions and an Edit button;
// Add opens a form for a new entry.
export function Directory({ kind, list, tx, devices, features, snaps, onOpenSnap, highlight, gapi, onReload, onJobStarted }: {
  kind: 'residents' | 'vendors';
  list: ResidentsReply | null;
  tx: TransactionRow[] | null;
  devices: DeviceRange[];
  features: GateFeatures;
  snaps: Snaps;
  onOpenSnap: (t: TransactionRow) => void;
  highlight: string | null;
  gapi: GateApi;
  onReload: () => Promise<void>;
  onJobStarted: () => void;
}) {
  const cols = COLUMNS[kind].filter(([, k]) => (k !== 'floor' || features.floors) && (k !== 'elevatorRef' || features.elevators));
  const vendor = kind === 'vendors';
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);
  const [open, setOpen] = useState<string | null>(highlight);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const readOnly = useReadOnly();

  useEffect(() => {
    setOpen(highlight);
    setEditing(false);
    if (!highlight) return;
    setFilter('');
    requestAnimationFrame(() => document.querySelector(`[data-code="${highlight}"]`)?.scrollIntoView({ block: 'center' }));
  }, [highlight]);

  const rows = useMemo(() => {
    let out = (list ? list.rows : []).filter((r) => (r.type === 'Vendor') === (kind === 'vendors') && !isEmptySlot(r));
    const q = filter.trim().toLowerCase();
    if (q) out = out.filter((r) => [...Object.values(r), dirCell(r, 'securityLevel')].join(' ').toLowerCase().includes(q));
    return sortRows(out, sort, (col) => (r: ResidentRow) => dirCell(r, col));
  }, [list, kind, filter, sort]);
  // Values held by more than one entry (all kinds, so a clash between a resident and a vendor shows on both pages).
  const dups = useMemo(() => {
    const of = (kindOf: string) => new Set((list?.duplicates || []).filter((d) => d.kind === kindOf).map((d) => d.value));
    return { directoryCode: of('directoryCode'), entryCode: of('entryCode'), card: of('card') };
  }, [list]);
  const dupCell = (r: ResidentRow, k: string) => (k === 'directoryCode' && dups.directoryCode.has(r.directoryCode))
    || (k === 'entryCode' && Boolean(r.entryCode) && dups.entryCode.has(r.entryCode));

  const csv = () => downloadCsv(`${kind}.csv`, cols.map((c) => c[0]), rows.map((r) => cols.map(([, k]) => dirCell(r, k))));

  return (
    <Flex direction="column" gap="3">
      <Heading>{kind === 'vendors' ? 'Vendors' : 'Residents'}</Heading>
      <WorkingCopyBar cache={list ? list.cache : null} gapi={gapi} onReload={onReload} onJobStarted={onJobStarted} />
      {list && list.duplicates.length > 0 && (
        <Callout.Root color="red" role="alert">
          <Callout.Text>
            <strong>Duplicate {list.duplicates.length === 1 ? 'number' : 'numbers'}: two or more entries share a directory code, entry code or card.</strong>{' '}
            The gate can't tell them apart, so <strong>Send to gate is refused</strong> until each is changed or removed (marked red below).
          </Callout.Text>
          <Box asChild><ul style={{ margin: 0 }}>{list.duplicates.map((d) => <li key={`${d.kind}-${d.value}`}>{d.text}</li>)}</ul></Box>
        </Callout.Root>
      )}
      {adding && list && (
        <Card>
          <ResidentForm r={null} vendor={vendor} dirDigits={list.dirDigits} emptyCodes={list.emptyCodes} devices={devices}
            features={features} gapi={gapi} onDone={async () => { setAdding(false); await onReload(); }} onCancel={() => setAdding(false)} />
        </Card>
      )}
      <Flex gap="3" align="center" wrap="wrap">
        {!readOnly && <Button onClick={() => setAdding(!adding)} disabled={!list}>{vendor ? 'Add vendor' : 'Add resident'}</Button>}
        <TextField.Root type="search" placeholder="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Button variant="soft" onClick={csv} disabled={!rows.length}>Download CSV</Button>
        <Text size="2" color="gray">
          {!list ? 'No data yet. Pull residents from the gate.'
            : `${rows.length} ${kind}${rows.length > MAX_ROWS ? ` (first ${MAX_ROWS} shown)` : ''} · downloaded ${fmtTime(list.updated)}`
              + (kind === 'residents' && list.unassignedCards.length ? ` · ${list.unassignedCards.length} cards without a directory code` : '')}
        </Text>
      </Flex>
      <Table.Root size="1" variant="surface">
        <SortHead cols={cols} sort={sort} onSort={(k) => setSort(nextSort(sort, k))} />
        <Table.Body>
          {rows.slice(0, MAX_ROWS).map((r) => (
            <Fragment key={r.directoryCode}>
              <Table.Row data-code={r.directoryCode}
                onClick={() => { setOpen(open === r.directoryCode ? null : r.directoryCode); setEditing(false); }}
                style={{ cursor: 'pointer', background: r.directoryCode === highlight ? 'var(--accent-a4)' : undefined,
                  color: r.hidden && kind === 'residents' ? 'var(--gray-10)' : undefined }}>
                {cols.map(([, k]) => (
                  <Table.Cell key={k} style={dupCell(r, k) ? { background: 'var(--red-a5)', color: 'var(--red-11)', fontWeight: 600 } : undefined}
                    title={dupCell(r, k) ? 'Also used by another entry' : undefined}>
                    {k === 'cards' ? <CardList cards={r.cards} devices={devices} dups={dups.card} />
                      : k === 'note' ? <Text as="div" className="note-cell" title={r.note || undefined}>{r.note}</Text>
                        : dirCell(r, k)}
                  </Table.Cell>
                ))}
              </Table.Row>
              {open === r.directoryCode && (
                <Table.Row>
                  <Table.Cell colSpan={cols.length} style={{ background: 'var(--gray-a2)' }}>
                    {editing && list ? (
                      <ResidentForm r={r} vendor={vendor} dirDigits={list.dirDigits} emptyCodes={list.emptyCodes} devices={devices}
                        features={features} gapi={gapi} onDone={async () => { setEditing(false); await onReload(); }} onCancel={() => setEditing(false)} />
                    ) : (
                      <Flex direction="column" gap="2">
                        {!readOnly && <Box><Button size="1" variant="soft" onClick={() => setEditing(true)}>Edit</Button></Box>}
                        <RecentTransactions r={r} tx={tx} snaps={snaps} onOpenSnap={onOpenSnap} />
                      </Flex>
                    )}
                  </Table.Cell>
                </Table.Row>
              )}
            </Fragment>
          ))}
        </Table.Body>
      </Table.Root>
    </Flex>
  );
}

// Last 5 transactions for a resident (transaction rows are newest first), matched on directory code.
function RecentTransactions({ r, tx, snaps, onOpenSnap }: {
  r: ResidentRow; tx: TransactionRow[] | null; snaps: Snaps; onOpenSnap: (t: TransactionRow) => void;
}) {
  if (!tx) return <Text size="2" color="gray">No transactions yet. Pull transactions from the gate.</Text>;
  const recent = tx.filter((t) => t.directoryCode === r.directoryCode).slice(0, 5);
  if (!recent.length) return <Text size="2" color="gray">No transactions for this entry.</Text>;
  const cols: Column[] = snaps.settings ? [...HISTORY_COLUMNS, ['Camera', 'snap']] : HISTORY_COLUMNS;
  return (
    <Table.Root size="1">
      <Table.Header>
        <Table.Row>{cols.map(([label, k]) => <Table.ColumnHeaderCell key={k}>{label}</Table.ColumnHeaderCell>)}</Table.Row>
      </Table.Header>
      <Table.Body>
        {recent.map((t, i) => (
          <Table.Row key={i} style={txTone(t) ? { background: `var(--${txTone(t)}-a3)` } : undefined}>
            {cols.map(([, k]) => (
              <Table.Cell key={k}>
                {k === 'snap' ? <SnapCell t={t} snaps={snaps} onOpen={onOpenSnap} /> : String((t as unknown as Record<string, unknown>)[k] ?? '')}
              </Table.Cell>
            ))}
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}
