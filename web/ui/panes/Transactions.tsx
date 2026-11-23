import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import { errorText } from '../api.ts';
import { Choice } from './fields.tsx';
import type { ResidentRow, TransactionRow } from '../../../src/types.ts';
import { cell, downloadCsv, fieldOf, fmtTime, residentFinder, txTone } from '../format.ts';
import { nextSort, SortHead, sortRows, useShownRows, type Column, type Sort } from '../table.tsx';
import { usePhone } from '../phone.ts';
import { SnapCell } from '../camera/SnapViews.tsx';
import type { Snaps } from '../camera/snapshots.ts';

export const TX_COLUMNS: Column[] = [['Date', 'date'], ['Time', 'time'], ['Event Type', 'eventType'], ['Number', 'number'],
  ['Name', 'name'], ['Access', 'access'], ['Relay', 'relay'], ['APB', 'apb'], ['Directory Code', 'directoryCode']];

const txValue = (col: string) => (col === 'time'
  ? (transaction: TransactionRow) => { const date = new Date(transaction.ts); return date.getHours() * 60 + date.getMinutes(); }
  : (transaction: TransactionRow) => fieldOf(transaction, col));

type ToneKey = 'red' | 'amber' | 'green';
type TonePalette = { error: { main: string }; warning: { main: string }; success: { main: string }; action: { hover: string } };
const TONE_PALETTE_KEY: Record<ToneKey, 'error' | 'warning' | 'success'> = { red: 'error', amber: 'warning', green: 'success' };

const toneBg = (tone: ToneKey | null) => (theme: { palette: TonePalette }) =>
  (tone ? alpha(theme.palette[TONE_PALETTE_KEY[tone]].main, 0.13) : theme.palette.action.hover);

const tableToneBg = (tone: ToneKey | null) =>
  (tone ? (theme: { palette: TonePalette }) => alpha(theme.palette[TONE_PALETTE_KEY[tone]].main, 0.12) : undefined);

export interface TransactionCardProps {
  transaction: TransactionRow;
  person?: ResidentRow | null;
  snaps: Snaps;
  compact?: boolean;
  onOpenResident?: (resident: ResidentRow) => void;
  onOpenSnap: (transaction: TransactionRow) => void;
}

/**
 * Formats the combined event pill label: directory events show `"Directory"`, portal opens show `"Portal Open"`,
 * and numbered credentials (cards, remotes, entry codes) combine as `"<Event>: #<Number>"`.
 */
function eventPillLabel(transaction: TransactionRow): string {
  if (transaction.source === 'portal') return 'Portal Open';
  const type = transaction.eventType || 'Event';
  const isDir = transaction.lookup === 'directory' || /^directory$/i.test(type);
  if (isDir) return 'Directory';
  if (transaction.number) return `${type}: #${transaction.number}`;
  return type;
}

/**
 * Compact tinted transaction bubble card with all details shown directly in solid pills (no click-to-expand):
 * - Left: `"Name - #DirCode"` + Access pill (`!compact`), followed by combined Event pill + combined Date/Time pill.
 * - Right: Camera thumbnail / Get video control pinned to the trailing edge.
 *
 * @param props - Card props.
 * @returns Rendered transaction bubble card.
 */
export function TransactionCard({
  transaction, person = null, snaps, compact = false, onOpenResident, onOpenSnap,
}: TransactionCardProps) {
  const tone = txTone(transaction);
  const accessColor = tone === 'green' ? 'success' : tone === 'red' ? 'error' : tone === 'amber' ? 'warning' : 'default';
  const displayName = transaction.name || 'Unknown';
  const nameWithUnit = transaction.directoryCode ? `${displayName} - #${transaction.directoryCode}` : displayName;
  const dateTimeLabel = [transaction.date, transaction.time].filter(Boolean).join(' · ');

  return (
    <Paper
      elevation={0}
      sx={(theme) => ({
        p: compact ? 1.25 : 1.5,
        borderRadius: 2,
        bgcolor: toneBg(tone)(theme),
      })}
    >
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Stack spacing={0.75} sx={{ flex: 1, minWidth: 0 }}>
          {!compact && (
            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                {person && transaction.name && transaction.directoryCode && onOpenResident ? (
                  <Link
                    href="#"
                    onClick={(event) => { event.preventDefault(); onOpenResident(person); }}
                    underline="hover"
                  >
                    {nameWithUnit}
                  </Link>
                ) : nameWithUnit}
              </Typography>
              {transaction.access && (
                <Chip size="small" color={accessColor} label={transaction.access} />
              )}
            </Stack>
          )}
          <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            {compact && transaction.access && (
              <Chip size="small" color={accessColor} label={transaction.access} />
            )}
            <Chip
              size="small"
              color={transaction.source === 'portal' ? 'primary' : 'default'}
              label={eventPillLabel(transaction)}
            />
            {dateTimeLabel && <Chip size="small" label={dateTimeLabel} />}
            {transaction.apb && <Chip size="small" label={`APB: ${transaction.apb}`} />}
          </Stack>
        </Stack>
        {snaps.settings && transaction.camera && (
          <Box sx={{ flexShrink: 0, ml: 'auto', display: 'flex', alignItems: 'center' }}>
            <SnapCell transaction={transaction} snaps={snaps} onOpen={onOpenSnap} />
          </Box>
        )}
      </Stack>
    </Paper>
  );
}

interface TransactionsProps {
  tx: { updated: string; rows: TransactionRow[]; next?: number | null } | null;
  onLoadOlder: () => Promise<void>;
  residents: ResidentRow[];
  onOpenResident: (resident: ResidentRow) => void;
  snaps: Snaps;
  onOpenSnap: (transaction: TransactionRow) => void;
}

/**
 * Window-level table virtualization for desktop transaction rows (`@tanstack/react-virtual`).
 * Measures the table container's document-relative offset (`getBoundingClientRect().top + scrollY`)
 * and re-measures when resize or banner layout dependencies change.
 *
 * @param count - Number of virtualized rows (`0` on phones).
 * @param estimateSize - Estimated row height in pixels.
 * @param measureDeps - Values that may shift the table's vertical offset when toggled.
 * @returns Container ref, virtualizer handle, visible items, and top/bottom spacer heights.
 */
function useTableVirtualizer(count: number, estimateSize: number, measureDeps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    if (!count) return;
    const measure = () => {
      const element = containerRef.current;
      if (element) setScrollMargin(element.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [count > 0, ...measureDeps]);
  const virtualizer = useWindowVirtualizer({ count, estimateSize: () => estimateSize, overscan: 15, scrollMargin });
  const items = count ? virtualizer.getVirtualItems() : [];
  const topPad = items.length > 0 ? Math.max(0, items[0].start - scrollMargin) : 0;
  const bottomPad = items.length > 0 ? Math.max(0, virtualizer.getTotalSize() - (items[items.length - 1].end - scrollMargin)) : 0;
  return { containerRef, virtualizer, items, topPad, bottomPad };
}

interface TransactionRowViewProps {
  transaction: TransactionRow;
  index: number;
  cols: Column[];
  person: ResidentRow | null;
  snaps: Snaps;
  isOpen: boolean;
  onToggle: () => void;
  onOpenResident: (resident: ResidentRow) => void;
  onOpenSnap: (transaction: TransactionRow) => void;
  rowRef?: (element: HTMLTableRowElement | null) => void;
}

/**
 * Renders one transaction row (desktop table row or expandable phone card).
 *
 * @param props - Row render props.
 * @param props.transaction - Transaction row to display.
 * @param props.index - Row index in the filtered/sorted list.
 * @param props.cols - Visible table columns.
 * @param props.person - Matching resident/vendor, or `null`.
 * @param props.snaps - Gate snapshot state and actions hook.
 * @param props.isOpen - Whether the phone card is expanded.
 * @param props.onToggle - Toggles phone card expansion.
 * @param props.onOpenResident - Callback to jump to the matching resident entry.
 * @param props.onOpenSnap - Callback to open the snapshot viewer for this transaction.
 * @param [props.rowRef] - Optional virtualizer measurement ref callback.
 * @returns Rendered table row element.
 */
function TransactionRowView({
  transaction, index, cols, person, snaps, isOpen, onToggle, onOpenResident, onOpenSnap, rowRef,
}: TransactionRowViewProps) {
  const tone = txTone(transaction);
  const handleClick = (event: MouseEvent) => {
    if (!(event.target as Element).closest('a, button')) onToggle();
  };
  const residentLink = (label: string, resident: ResidentRow) => (
    <Link
      href="#"
      title={`Open ${resident.name || `directory code ${resident.directoryCode}`} (code ${resident.directoryCode})`}
      onClick={(event) => { event.preventDefault(); onOpenResident(resident); }}
    >
      {label}
    </Link>
  );
  return (
    <TableRow
      ref={rowRef}
      data-index={index}
      className="card-row"
      data-open={isOpen || undefined}
      data-tone={tone || undefined}
      onClick={handleClick}
      sx={{ bgcolor: tableToneBg(tone) }}
    >
      {cols.map(([, key]) => (
        <TableCell key={key} data-col={key}>
          {key === 'snap' ? <SnapCell transaction={transaction} snaps={snaps} onOpen={onOpenSnap} />
            : key === 'eventType' && transaction.source === 'portal' ? <Chip color="primary" size="small" label="Portal Open" />
            : person && key === 'name' && transaction.name && transaction.directoryCode ? residentLink(transaction.name, person)
            : person && key === 'number' && transaction.number ? residentLink(transaction.number, person)
              : cell(fieldOf(transaction, key))}
        </TableCell>
      ))}
    </TableRow>
  );
}

/**
 * The gate's transaction log (`rcv_out.bin`), newest first. Names and numbers link to the resident/vendor; with
 * camera settings saved, a Camera column shows each transaction's pictures (or videos). The newest transactions are
 * loaded first; Load older transactions adds the page before them (`onLoadOlder`). On desktop the table is virtualized
 * (`@tanstack/react-virtual`) so thousands of loaded rows scroll smoothly with a small DOM; phones page cards 100 at a time.
 *
 * @param props - Component props.
 * @param props.tx - Loaded gate transactions (`{ updated, rows, next }`), or `null` before a pull.
 * @param props.onLoadOlder - Callback to fetch the next older page of transactions.
 * @param props.residents - Resident/vendor rows used to link names and numbers.
 * @param props.onOpenResident - Callback to jump to a resident entry.
 * @param props.snaps - Gate snapshot state and actions hook.
 * @param props.onOpenSnap - Callback to open the snapshot viewer for a transaction.
 * @returns Rendered React element.
 */
export function Transactions({ tx, onLoadOlder, residents, onOpenResident, snaps, onOpenSnap }: TransactionsProps) {
  const cols: Column[] = snaps.settings ? [...TX_COLUMNS, ['Camera', 'snap']] : TX_COLUMNS;
  const progress = snaps.run && snaps.running ? snaps.run.progress : undefined;
  const phone = usePhone();
  const [days, setDays] = useState('7');
  const [filter, setFilter] = useState('');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderError, setOlderError] = useState('');
  const [olderLoaded, setOlderLoaded] = useState(0);

  const who = useMemo(() => residentFinder(residents), [residents]);
  const rows = useMemo(() => {
    let out = tx ? tx.rows : [];
    const count = Number(days);
    if (count && out.length) {
      const since = out[0].ts - count * 86400000;
      out = out.filter((transaction) => transaction.ts >= since);
    }
    const query = filter.trim().toLowerCase();
    if (query) out = out.filter((transaction) => Object.values(transaction).join(' ').toLowerCase().includes(query));
    return sortRows(out, sort, txValue);
  }, [tx, days, filter, sort]);

  const PHONE_TX_STEP = 25;
  const { limit, showMore } = useShownRows(phone ? rows.length : 0, `${filter}|${days}`, phone ? PHONE_TX_STEP : undefined);
  useEffect(() => { if (olderLoaded && phone) showMore(); }, [olderLoaded, phone]);
  const loadOlder = async () => {
    setOlderLoading(true);
    setOlderError('');
    try {
      await onLoadOlder();
      setOlderLoaded((count) => count + 1);
    } catch (err) {
      setOlderError(`Not loaded: ${errorText(err)}`);
    } finally {
      setOlderLoading(false);
    }
  };
  const csv = () => downloadCsv('transactions.csv', TX_COLUMNS.map((column) => column[0]),
    rows.map((transaction) => TX_COLUMNS.map(([, key]) => cell(fieldOf(transaction, key)))));

  const { containerRef, virtualizer, items, topPad, bottomPad } = useTableVirtualizer(
    phone ? 0 : rows.length,
    snaps.settings ? 58 : 36,
    [Boolean(snaps.settings), Boolean(snaps.info), Boolean(snaps.running), Boolean(progress), olderLoading, Boolean(olderError)],
  );

  const renderEntry = (transaction: TransactionRow, index: number, rowRef?: (element: HTMLTableRowElement | null) => void) => {
    const id = `${transaction.raw}-${index}`;
    return (
      <TransactionRowView
        key={id}
        transaction={transaction}
        index={index}
        cols={cols}
        person={who(transaction)}
        snaps={snaps}
        isOpen={openRow === id}
        onToggle={() => setOpenRow(openRow === id ? null : id)}
        onOpenResident={onOpenResident}
        onOpenSnap={onOpenSnap}
        rowRef={rowRef}
      />
    );
  };

  return (
    <Stack spacing={2}>
      <Typography variant="h5">Transactions</Typography>
      {phone ? (
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Choice
              value={days}
              onChange={setDays}
              ariaLabel="Time range"
              options={[['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['0', 'All']]}
            />
            <TextField
              size="small"
              type="search"
              placeholder="Filter rows"
              slotProps={{ htmlInput: { 'aria-label': 'Filter rows' } }}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              sx={{ flex: 1, minWidth: 0 }}
            />
          </Stack>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Button variant="outlined" onClick={csv} disabled={!rows.length} sx={{ flex: 1 }}>
              Download CSV
            </Button>
            {snaps.settings && (
              <Button variant="outlined" disabled={snaps.running} onClick={snaps.runAll} sx={{ flex: 1 }}>
                {snaps.video ? 'Get camera videos' : 'Get camera snapshots'}
              </Button>
            )}
          </Stack>
          {snaps.settings && snaps.running && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Button variant="outlined" color="inherit" disabled={Boolean(snaps.run?.stopping)} onClick={snaps.stop}>
                {snaps.video ? 'Stop videos' : 'Stop snapshots'}
              </Button>
              <LinearProgress
                variant={progress && progress.frames ? 'determinate' : 'indeterminate'}
                value={progress && progress.frames ? (progress.framesDone / progress.frames) * 100 : undefined}
                sx={{ flex: 1 }}
              />
            </Stack>
          )}
          <Typography variant="body2" color="text.secondary">
            {!tx ? 'No transactions yet. Pull transactions from the gate.'
              : `${rows.length} transactions${rows.length > limit ? ` (showing ${limit})` : ''} · downloaded ${fmtTime(tx.updated)}`}
          </Typography>
        </Stack>
      ) : (
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Choice
            value={days}
            onChange={setDays}
            ariaLabel="Time range"
            options={[['1', 'Last 24 hours'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['0', 'All']]}
          />
          <TextField
            size="small"
            type="search"
            placeholder="Filter rows"
            slotProps={{ htmlInput: { 'aria-label': 'Filter rows' } }}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <Button variant="outlined" onClick={csv} disabled={!rows.length}>Download CSV</Button>
          {snaps.settings && (
            <Button variant="outlined" disabled={snaps.running} onClick={snaps.runAll}>
              {snaps.video ? 'Get camera videos' : 'Get camera snapshots'}
            </Button>
          )}
          {snaps.settings && snaps.running && (
            <Button variant="outlined" color="inherit" disabled={Boolean(snaps.run?.stopping)} onClick={snaps.stop}>
              {snaps.video ? 'Stop videos' : 'Stop snapshots'}
            </Button>
          )}
          {snaps.settings && snaps.running && (
            <LinearProgress
              variant={progress && progress.frames ? 'determinate' : 'indeterminate'}
              value={progress && progress.frames ? (progress.framesDone / progress.frames) * 100 : undefined}
              sx={{ width: 120 }}
            />
          )}
          <Typography variant="body2" color="text.secondary">
            {!tx ? 'No transactions yet. Pull transactions from the gate.'
              : `${rows.length} transactions · downloaded ${fmtTime(tx.updated)}`}
          </Typography>
          {tx && tx.next != null && (
            <Button
              variant="outlined"
              color="inherit"
              onClick={loadOlder}
              disabled={olderLoading}
              title={`Only the newest ${tx.rows.length} transactions are loaded`}
            >
              {olderLoading ? 'Loading…' : 'Load older transactions'}
            </Button>
          )}
        </Stack>
      )}
      {olderError && <Alert severity="error">{olderError}</Alert>}
      {snaps.settings && snaps.info && <Typography variant="body2" color="text.secondary">{snaps.info}</Typography>}
      {phone ? (
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={0.75} sx={{ overflowX: 'auto', pb: 0.5, alignItems: 'center', '&::-webkit-scrollbar': { display: 'none' } }}>
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, mr: 0.25 }}>Sort:</Typography>
            {cols.filter(([, key]) => key !== 'snap').map(([label, key]) => {
              const active = sort?.col === key || sort?.then?.col === key;
              const dir = sort?.col === key ? (sort.dir > 0 ? ' ▲' : ' ▼')
                : sort?.then?.col === key ? (sort.then.dir > 0 ? ' ▲' : ' ▼') : '';
              return (
                <Chip
                  key={key}
                  size="small"
                  clickable
                  color={active ? 'primary' : 'default'}
                  label={`${label}${dir}`}
                  onClick={() => setSort(nextSort(sort, key, true))}
                  sx={{ flexShrink: 0 }}
                />
              );
            })}
          </Stack>
          <Stack spacing={1}>
            {rows.slice(0, limit).map((transaction, index) => (
              <TransactionCard
                key={`${transaction.raw}-${index}`}
                transaction={transaction}
                person={who(transaction)}
                snaps={snaps}
                onOpenResident={onOpenResident}
                onOpenSnap={onOpenSnap}
              />
            ))}
          </Stack>
          {rows.length > limit ? (
            <Stack spacing={0.75} sx={{ alignItems: 'center', pt: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                Showing {limit} of {rows.length} transactions
              </Typography>
              <Button variant="outlined" fullWidth onClick={showMore}>
                Load more
              </Button>
            </Stack>
          ) : tx && tx.next != null ? (
            <Button variant="outlined" fullWidth disabled={olderLoading} onClick={loadOlder}>
              {olderLoading ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </Stack>
      ) : (
        <div ref={containerRef}>
          <TableContainer component={Paper} variant="outlined" className="tx-table">
            <Table size="small">
              <SortHead
                cols={cols}
                sort={sort}
                onSort={(column) => { if (column !== 'snap') setSort(nextSort(sort, column, true)); }}
                title={(column) => (column === 'time' ? 'Click to sort. After sorting by Date, sorts the times within each date.' : 'Click to sort')}
              />
              <TableBody>
                {topPad > 0 && (
                  <tr aria-hidden="true" style={{ height: topPad }}>
                    <td colSpan={cols.length} style={{ padding: 0, border: 0, height: topPad }} />
                  </tr>
                )}
                {items.map((item) => renderEntry(rows[item.index], item.index, virtualizer.measureElement))}
                {bottomPad > 0 && (
                  <tr aria-hidden="true" style={{ height: bottomPad }}>
                    <td colSpan={cols.length} style={{ padding: 0, border: 0, height: bottomPad }} />
                  </tr>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </div>
      )}
    </Stack>
  );
}
