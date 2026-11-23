import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import type { DeviceRange, EntryChange, GateFeatures, ResidentRow, ResidentsReply, TransactionRow } from '../../../src/types.ts';
import { dirCell, doorKingCsv, downloadText, fmtTime, isEmptySlot, phoneFull } from '../format.ts';
import { nextSort, SortHead, sortRows, useShownRows, type Column, type Sort } from '../table.tsx';
import { CardList } from './fields.tsx';
import type { Snaps } from '../camera/snapshots.ts';
import { ImportCsvDialog } from './ImportCsvDialog.tsx';
import { ResidentForm } from './ResidentForm.tsx';
import { WelcomeInstructionsDialog } from './WelcomeInstructionsDialog.tsx';
import { TransactionCard } from './Transactions.tsx';
import { ACTIONS } from './History.tsx';
import { WorkingCopyBar } from './WorkingCopyBar.tsx';
import { errorText, useReadOnly, type GateApi } from '../api.ts';
import { useBackLayer } from '../back.ts';
import { usePhone } from '../phone.ts';
import { useConfirm } from '../Confirm.tsx';

const COLUMNS: Record<'residents' | 'vendors', Column[]> = {
  residents: [['Directory Code', 'directoryCode'], ['Name', 'name'], ['Hidden', 'hidden'], ['Phone', 'phoneFull'],
    ['Entry Code', 'entryCode'], ['Security', 'securityLevel'], ['Floor', 'floor'], ['Elevator', 'elevatorRef'], ['Cards', 'cards'],
    ['Notes', 'note']],
  vendors: [['Directory Code', 'directoryCode'], ['Name', 'name'], ['Entry Code', 'entryCode'], ['Security', 'securityLevel'],
    ['Cards', 'cards'], ['Notes', 'note']],
};

interface DirectoryProps {
  kind: 'residents' | 'vendors';
  gatePhone: string;
  adminPhone: string;
  account: string; // the site name, the export's ACCOUNT column
  list: ResidentsReply | null;
  tx: TransactionRow[] | null;
  devices: DeviceRange[];
  features: GateFeatures;
  snaps: Snaps;
  onOpenSnap: (transaction: TransactionRow) => void;
  highlight: string | null;
  gapi: GateApi;
  onReload: () => Promise<void>;
}

/**
 * Residents or vendors in the working copy. Clicking a row shows its last 5 transactions and an Edit button;
 * Add opens a form for a new entry.
 *
 * @param props - Component props.
 * @param props.kind - Item or operation kind.
 * @param props.account - Gate site name used for the DoorKing CSV `ACCOUNT` column.
 * @param props.list - List of input items.
 * @param props.tx - Loaded transaction rows for recent-activity lookups, or `null`.
 * @param props.devices - Configured Device Association card ranges.
 * @param props.features - Visible feature toggles (`floors`, `elevators`).
 * @param props.snaps - Gate snapshot state and actions hook.
 * @param props.onOpenSnap - Callback to open the snapshot viewer for a transaction.
 * @param props.highlight - Directory code to highlight and scroll into view.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onReload - Callback to reload the gate data.
 * @returns Rendered React element.
 */
export function Directory({ kind, gatePhone, adminPhone, account, list, tx, devices, features, snaps, onOpenSnap, highlight, gapi, onReload }: DirectoryProps) {
  const cols = COLUMNS[kind].filter(([, k]) => (k !== 'floor' || features.floors) && (k !== 'elevatorRef' || features.elevators));
  const vendor = kind === 'vendors';
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);
  const [open, setOpen] = useState<string | null>(highlight);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [welcomeResident, setWelcomeResident] = useState<ResidentRow | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const usedEntryCodes = useMemo(() => (list?.rows ?? []).map((row) => row.entryCode).filter(Boolean), [list]);
  const grantAccessDigit = list?.grantAccessDigit || '9';
  const [bulkLevel, setBulkLevel] = useState('1');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState('');
  const [dialog, confirm] = useConfirm();
  /**
   * Back closes an open add or edit form, after asking (its typing would be lost).
   *
   * @returns Computed result.
   */
  const leaveForm = () => confirm({ title: 'Leave this form?', body: 'Changes you haven\'t saved are lost.', action: 'Leave', color: 'red' });
  useBackLayer(adding, () => setAdding(false), leaveForm);
  useBackLayer(editing, () => setEditing(false), leaveForm);
  const readOnly = useReadOnly();
  const phone = usePhone(); // phones: no Export CSV

  useEffect(() => {
    setOpen(highlight);
    setEditing(false);
    if (!highlight) return;
    setFilter('');
    requestAnimationFrame(() => document.querySelector(`[data-code="${highlight}"]`)?.scrollIntoView({ block: 'center' }));
  }, [highlight]);

  const rows = useMemo(() => {
    let out = (list ? list.rows : []).filter((resident) => (resident.type === 'Vendor') === (kind === 'vendors') && !isEmptySlot(resident));
    const query = filter.trim().toLowerCase();
    if (query) out = out.filter((resident) => [...Object.values(resident), dirCell(resident, 'securityLevel')].join(' ').toLowerCase().includes(query));
    return sortRows(out, sort, (col) => (resident: ResidentRow) => dirCell(resident, col));
  }, [list, kind, filter, sort]);
  /**
   * Values held by more than one entry (all kinds, so a clash between a resident and a vendor shows on both pages).
   */
  const dups = useMemo(() => {
    const of = (kindOf: string) => new Set((list?.duplicates || []).filter((duplicate) => duplicate.kind === kindOf).map((duplicate) => duplicate.value));
    return { directoryCode: of('directoryCode'), entryCode: of('entryCode'), card: of('card') };
  }, [list]);
  const dupCell = (resident: ResidentRow, column: string) => (column === 'directoryCode' && dups.directoryCode.has(resident.directoryCode))
    || (column === 'entryCode' && Boolean(resident.entryCode) && dups.entryCode.has(resident.entryCode));

  const { limit, more } = useShownRows(rows.length, `${filter}|${kind}`);
  const end = Math.max(limit, rows.findIndex((resident) => resident.directoryCode === highlight) + 1); // a highlighted entry always shows

  /**
   * Every directory code (residents, vendors and empty slots), in DoorKing's cloud export format.
   *
   * @returns Computed result.
   */
  const csv = () => list && downloadText('ResidentsExport.csv', doorKingCsv(account, list.rows || [], list.unassignedCards));
  const toggleSelected = (code: string) => {
    setSelected((cur) => { const next = new Set(cur); if (next.has(code)) next.delete(code); else next.add(code); return next; });
  };
  const visibleRows = rows.slice(0, end);
  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((row) => selected.has(row.directoryCode));
  const toggleAllVisible = () => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (allVisibleSelected) visibleRows.forEach((row) => next.delete(row.directoryCode));
      else visibleRows.forEach((row) => next.add(row.directoryCode));
      return next;
    });
  };
  async function runBulk(action: 'setSecurityLevel' | 'delete') {
    const codes = [...selected];
    if (!codes.length) return;
    const label = action === 'setSecurityLevel' ? `set security level to ${bulkLevel} on` : 'delete';
    if (!await confirm({
      title: `Bulk ${label} ${codes.length} ${kind}?`, action: action === 'delete' ? 'Delete selected' : 'Apply',
      color: action === 'delete' ? 'red' : 'blue',
      body: 'This updates the working copy in one History entry. The gate is not changed until Send to gate.',
    })) return;
    setBulkBusy(true);
    setBulkError('');
    try {
      await gapi('POST', '/residents/bulk', { action, codes, ...(action === 'setSecurityLevel' ? { securityLevel: Number(bulkLevel) } : {}) });
      setSelected(new Set());
      await onReload();
    } catch (err) { setBulkError(errorText(err)); }
    setBulkBusy(false);
  }

  return (
    <Stack spacing={2}>
      {dialog}
      <ImportCsvDialog open={importing} onOpenChange={setImporting} vendor={vendor} gapi={gapi} onImported={onReload} />
      {welcomeResident && (
        <WelcomeInstructionsDialog
          open={Boolean(welcomeResident)}
          onOpenChange={(next) => { if (!next) setWelcomeResident(null); }}
          phone={gatePhone}
          siteName={account}
          resident={{
            name: welcomeResident.name,
            directoryCode: welcomeResident.directoryCode,
            entryCode: welcomeResident.entryCode,
            hidden: welcomeResident.hidden,
            cards: welcomeResident.cards.map((card) => String(Number(card))),
          }}
          defaultAdminPhone={adminPhone}
          defaultGrantDigit={grantAccessDigit}
          onAdminPhoneSaved={onReload}
        />
      )}
      <Typography variant="h5">{kind === 'vendors' ? 'Vendors' : 'Residents'}</Typography>
      <WorkingCopyBar cache={list ? list.cache : null} gapi={gapi} onReload={onReload} />
      {list && list.duplicates.length > 0 && (
        <Alert severity="error" role="alert">
          <Typography variant="body2">
            <strong>Duplicate {list.duplicates.length === 1 ? 'number' : 'numbers'}: two or more entries share a directory code, entry code or card.</strong>{' '}
            The gate can&apos;t tell them apart, so <strong>Send to gate is refused</strong> until each is changed or removed (marked red below).
          </Typography>
          <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
            {list.duplicates.map((duplicate) => <li key={`${duplicate.kind}-${duplicate.value}`}>{duplicate.text}</li>)}
          </Box>
        </Alert>
      )}
      {adding && list && (
        <Card>
          <CardContent>
            <ResidentForm
              resident={null}
              vendor={vendor}
              gatePhone={gatePhone}
              siteName={account}
              dirDigits={list.dirDigits}
              emptyCodes={list.emptyCodes}
              usedEntryCodes={usedEntryCodes}
              adminPhone={adminPhone}
              grantAccessDigit={grantAccessDigit}
              devices={devices}
              features={features}
              gapi={gapi}
              onDone={async () => { setAdding(false); await onReload(); }}
              onAdminPhoneSaved={onReload}
              onCancel={() => setAdding(false)}
            />
          </CardContent>
        </Card>
      )}
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        {!readOnly && (
          <Button variant="contained" onClick={() => setAdding(!adding)} disabled={!list}>
            {vendor ? 'Add vendor' : 'Add resident'}
          </Button>
        )}
        {!readOnly && !phone && (
          <Button variant="outlined" onClick={() => setImporting(true)} disabled={!list}>Import CSV</Button>
        )}
        <TextField
          size="small"
          type="search"
          placeholder="Filter rows"
          slotProps={{ htmlInput: { 'aria-label': 'Filter rows' } }}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {!phone && (
          <Button
            variant="outlined"
            onClick={csv}
            disabled={!list}
            title="Every directory code (residents, vendors and empty units), in the format DoorKing's cloud exports"
          >
            Export CSV
          </Button>
        )}
        <Typography variant="body2" color="text.secondary">
          {!list ? 'No data yet. Pull residents from the gate.'
            : `${rows.length} ${kind}${rows.length > limit ? ` (first ${limit} shown)` : ''} · downloaded ${fmtTime(list.updated)}`
              + (kind === 'residents' && list.unassignedCards.length ? ` · ${list.unassignedCards.length} cards without a directory code` : '')}
        </Typography>
      </Stack>
      {!readOnly && selected.size > 0 && (
        <Alert severity="info">
          <Stack spacing={1}>
            <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>{selected.size} selected</Typography>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Typography variant="caption" color="text.secondary">Security level:</Typography>
                <TextField
                  size="small"
                  type="number"
                  slotProps={{ htmlInput: { min: 0, max: 30, 'aria-label': 'Bulk security level' } }}
                  sx={{ width: '8ch' }}
                  value={bulkLevel}
                  onChange={(event) => setBulkLevel(event.target.value)}
                />
                <Button size="small" variant="outlined" disabled={bulkBusy} onClick={() => runBulk('setSecurityLevel')}>Set level</Button>
              </Stack>
              <Button size="small" variant="outlined" color="error" disabled={bulkBusy} onClick={() => runBulk('delete')}>Delete selected</Button>
              <Button size="small" variant="text" color="inherit" onClick={() => setSelected(new Set())}>Clear</Button>
            </Stack>
            {bulkError && <Alert severity="error" sx={{ py: 0 }}>{bulkError}</Alert>}
          </Stack>
        </Alert>
      )}
      {phone ? (
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={0.75} sx={{ overflowX: 'auto', pb: 0.5, alignItems: 'center', '&::-webkit-scrollbar': { display: 'none' } }}>
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, mr: 0.25 }}>Sort:</Typography>
            {cols.map(([label, key]) => {
              const active = sort?.col === key;
              const dir = active ? (sort!.dir > 0 ? ' ▲' : ' ▼') : '';
              return (
                <Chip
                  key={key}
                  size="small"
                  clickable
                  color={active ? 'primary' : 'default'}
                  label={`${label}${dir}`}
                  onClick={() => setSort(nextSort(sort, key))}
                  sx={{ flexShrink: 0 }}
                />
              );
            })}
          </Stack>
          <Stack spacing={1}>
            {visibleRows.map((resident) => {
              const isOpen = open === resident.directoryCode;
              const phoneText = !vendor ? phoneFull(resident) : '';
              const hasDup = dupCell(resident, 'directoryCode') || dupCell(resident, 'entryCode') || dupCell(resident, 'cards');
              const titleText = `${resident.name || '(Unnamed)'} - #${resident.directoryCode}`;
              return (
                <Paper
                  key={resident.directoryCode}
                  elevation={0}
                  data-code={resident.directoryCode}
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: resident.directoryCode === highlight
                      ? (theme) => alpha(theme.palette.primary.main, 0.14)
                      : hasDup
                        ? (theme) => alpha(theme.palette.error.main, 0.1)
                        : 'action.hover',
                    color: resident.hidden && !vendor ? 'text.secondary' : undefined,
                  }}
                >
                  <Stack spacing={1}>
                    <Box
                      onClick={() => { setOpen(isOpen ? null : resident.directoryCode); setEditing(false); }}
                      sx={{ cursor: 'pointer' }}
                    >
                      <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 600, mr: 0.25 }}>
                          {titleText}
                        </Typography>
                        {phoneText && (
                          <Chip size="small" label={phoneText} />
                        )}
                        {resident.entryCode && (
                          <Chip
                            size="small"
                            color={dupCell(resident, 'entryCode') ? 'error' : 'primary'}
                            label={`#${resident.entryCode}`}
                          />
                        )}
                        {resident.hidden && !vendor && (
                          <Chip size="small" color="warning" label="Hidden" />
                        )}
                        {hasDup && (
                          <Chip size="small" color="error" label="Duplicate" />
                        )}
                      </Stack>
                    </Box>

                    {isOpen && (
                      <Box sx={{ pt: 0.5 }}>
                        {editing && list ? (
                          <ResidentForm
                            resident={resident}
                            vendor={vendor}
                            gatePhone={gatePhone}
                            siteName={account}
                            dirDigits={list.dirDigits}
                            emptyCodes={list.emptyCodes}
                            usedEntryCodes={usedEntryCodes.filter((code) => code !== resident.entryCode)}
                            adminPhone={adminPhone}
                            grantAccessDigit={grantAccessDigit}
                            devices={devices}
                            features={features}
                            gapi={gapi}
                            onDone={async () => { setEditing(false); await onReload(); }}
                            onAdminPhoneSaved={onReload}
                            onCancel={() => setEditing(false)}
                          />
                        ) : (
                          <Stack spacing={1.5}>
                            {resident.cards.length > 0 && (
                              <Box>
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                                  Cards
                                </Typography>
                                <CardList cards={resident.cards} devices={devices} dups={dups.card} />
                              </Box>
                            )}
                            {resident.note && (
                              <Typography variant="body2" color="text.secondary">{resident.note}</Typography>
                            )}
                            <LastEdit resident={resident} gapi={gapi} version={list ? String(list.saved) : ''} />
                            <RecentTransactions resident={resident} tx={tx} snaps={snaps} onOpenSnap={onOpenSnap} />
                            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                              {!readOnly && (
                                <Button size="small" variant="contained" onClick={() => setEditing(true)} sx={{ flex: 1 }}>
                                  Edit
                                </Button>
                              )}
                              {!vendor && (
                                <Button size="small" variant="outlined" onClick={() => setWelcomeResident(resident)} sx={{ flex: 1 }}>
                                  Welcome &amp; PDF…
                                </Button>
                              )}
                            </Stack>
                          </Stack>
                        )}
                      </Box>
                    )}
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
        </Stack>
      ) : (
        <TableContainer component={Paper} variant="outlined" className="dir-table">
          <Table size="small">
            <SortHead
              cols={cols}
              sort={sort}
              onSort={(column) => setSort(nextSort(sort, column))}
              leading={!readOnly ? (
                <TableCell sx={{ width: 28 }}>
                  <Checkbox
                    size="small"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    slotProps={{ input: { 'aria-label': 'Select all visible' } }}
                    sx={{ p: 0.25 }}
                  />
                </TableCell>
              ) : undefined}
            />
            <TableBody>
              {visibleRows.map((resident) => (
                <Fragment key={resident.directoryCode}>
                  <TableRow
                    hover
                    className="card-row"
                    data-code={resident.directoryCode}
                    data-open={open === resident.directoryCode || undefined}
                    onClick={() => { setOpen(open === resident.directoryCode ? null : resident.directoryCode); setEditing(false); }}
                    sx={{
                      cursor: 'pointer',
                      bgcolor: resident.directoryCode === highlight ? (theme) => alpha(theme.palette.primary.main, 0.14) : undefined,
                      color: resident.hidden && kind === 'residents' ? 'text.secondary' : undefined,
                    }}
                  >
                    {!readOnly && (
                      <TableCell onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          size="small"
                          checked={selected.has(resident.directoryCode)}
                          onChange={() => toggleSelected(resident.directoryCode)}
                          slotProps={{ input: { 'aria-label': `Select ${resident.directoryCode}` } }}
                          sx={{ p: 0.25 }}
                        />
                      </TableCell>
                    )}
                    {cols.map(([, k]) => (
                      <TableCell
                        key={k}
                        data-col={k}
                        sx={dupCell(resident, k) ? { bgcolor: (theme) => alpha(theme.palette.error.main, 0.16), color: 'error.main', fontWeight: 600 } : undefined}
                        title={dupCell(resident, k) ? 'Also used by another entry' : undefined}
                      >
                        {k === 'cards' ? <CardList cards={resident.cards} devices={devices} dups={dups.card} />
                          : k === 'note' ? <Box className="note-cell" title={resident.note || undefined}>{resident.note}</Box>
                            : dirCell(resident, k)}
                      </TableCell>
                    ))}
                  </TableRow>
                  {open === resident.directoryCode && (
                    <TableRow className="detail-row">
                      <TableCell colSpan={cols.length + (!readOnly ? 1 : 0)} sx={{ bgcolor: 'background.paper' }}>
                        {editing && list ? (
                          <ResidentForm
                            resident={resident}
                            vendor={vendor}
                            gatePhone={gatePhone}
                            siteName={account}
                            dirDigits={list.dirDigits}
                            emptyCodes={list.emptyCodes}
                            usedEntryCodes={usedEntryCodes.filter((code) => code !== resident.entryCode)}
                            adminPhone={adminPhone}
                            grantAccessDigit={grantAccessDigit}
                            devices={devices}
                            features={features}
                            gapi={gapi}
                            onDone={async () => { setEditing(false); await onReload(); }}
                            onAdminPhoneSaved={onReload}
                            onCancel={() => setEditing(false)}
                          />
                        ) : (
                          <Stack spacing={1.5}>
                            <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                              {!readOnly && <Button size="small" variant="contained" onClick={() => setEditing(true)}>Edit</Button>}
                              {!vendor && (
                                <Button size="small" variant="outlined" onClick={() => setWelcomeResident(resident)}>
                                  Welcome &amp; PDF…
                                </Button>
                              )}
                              <LastEdit resident={resident} gapi={gapi} version={list ? String(list.saved) : ''} />
                            </Stack>
                            <RecentTransactions resident={resident} tx={tx} snaps={snaps} onOpenSnap={onOpenSnap} />
                          </Stack>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {more}
    </Stack>
  );
}

interface LastEditProps {
  resident: ResidentRow;
  gapi: GateApi;
  version: string;
}

/**
 * "Last edited by <user>, <time>" for a directory code, from History; clicking it lists every recorded change (what,
 * when, who). Nothing is shown when History has none. version: reloads after the working copy changes.
 *
 * @param props - Component props.
 * @param props.resident - Resident/vendor row.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.version - Reloads after the working copy changes.
 * @returns Rendered React element.
 */
function LastEdit({ resident, gapi, version }: LastEditProps) {
  const [changes, setChanges] = useState<EntryChange[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  useBackLayer(open, () => setOpen(false));
  useEffect(() => {
    let live = true;
    gapi<{ changes: EntryChange[] }>('GET', `/residents/${encodeURIComponent(resident.directoryCode)}/history`)
      .then((reply) => { if (live) { setChanges(reply.changes); setError(''); } }, (err) => { if (live) setError(errorText(err)); });
    return () => { live = false; };
  }, [gapi, resident.directoryCode, version]);
  if (error) return <Alert severity="error" sx={{ py: 0 }}>Change history unavailable: {error}</Alert>;
  if (!changes || !changes.length) return null;
  const last = changes[0];
  return (
    <>
      <Link
        href="#"
        variant="body2"
        title="See every recorded change to this entry"
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(true); }}
      >
        Last edited by {last.user} · {fmtTime(last.time)}{changes.length > 1 ? ` (${changes.length} changes)` : ''}
      </Link>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth onClick={(event) => event.stopPropagation()}>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
          <span>Changes to directory code {resident.directoryCode}{resident.name ? ` (${resident.name})` : ''}</span>
          <IconButton size="small" aria-label="Close" onClick={() => setOpen(false)}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {changes.map((change) => (
              <Card key={change.id}>
                <CardContent>
                  <Stack spacing={1}>
                    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                      <Typography variant="body2" sx={{ fontWeight: 500 }}>{fmtTime(change.time)}</Typography>
                      <Typography variant="body2">by {change.user}</Typography>
                      <Chip size="small" label={ACTIONS[change.action] || change.action} />
                      {change.change !== 'changed' && (
                        <Chip size="small" color={change.change === 'added' ? 'success' : 'error'} label={change.change} />
                      )}
                      {change.revertedBy && (
                        <Chip
                          size="small"
                          color="warning"
                          label="Reverted"
                          title={`${change.revertedBy.user}, ${fmtTime(change.revertedBy.time)}`}
                        />
                      )}
                    </Stack>
                    <Typography variant="caption" color="text.secondary">{change.summary}</Typography>
                    {change.fields.length > 0 && (
                      <TableContainer component={Paper} variant="outlined">
                        <Table size="small">
                          <TableHead>
                            <TableRow>
                              {['What', 'Before', 'After'].map((header) => <TableCell key={header}>{header}</TableCell>)}
                            </TableRow>
                          </TableHead>
                          <TableBody>
                            {change.fields.map((field, i) => (
                              <TableRow key={i}>
                                <TableCell>{field.field}</TableCell>
                                <TableCell>
                                  <Typography variant="body2" color="text.secondary">{field.from || '—'}</Typography>
                                </TableCell>
                                <TableCell>{field.to || '—'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    )}
                  </Stack>
                </CardContent>
              </Card>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 1.5 }}>
          <Button color="inherit" onClick={() => setOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

interface RecentTransactionsProps {
  resident: ResidentRow;
  tx: TransactionRow[] | null;
  snaps: Snaps;
  onOpenSnap: (transaction: TransactionRow) => void;
}

/**
 * Last 5 transactions for a resident (transaction rows are newest first), matched on directory code.
 *
 * @param props - Component props.
 * @param props.resident - Resident/vendor row.
 * @param props.tx - Loaded transaction rows for recent-activity lookups, or `null`.
 * @param props.snaps - Gate snapshot state and actions hook.
 * @param props.onOpenSnap - Callback to open the snapshot viewer for a transaction.
 * @returns Rendered React element.
 */
function RecentTransactions({ resident, tx, snaps, onOpenSnap }: RecentTransactionsProps) {
  if (!tx) return <Typography variant="body2" color="text.secondary">No transactions yet. Pull transactions from the gate.</Typography>;
  const recent = tx.filter((transaction) => transaction.directoryCode === resident.directoryCode).slice(0, 5);
  if (!recent.length) return <Typography variant="body2" color="text.secondary">No transactions for this entry.</Typography>;
  return (
    <Stack spacing={1}>
      {recent.map((transaction, i) => (
        <TransactionCard
          key={`${transaction.raw}-${i}`}
          transaction={transaction}
          snaps={snaps}
          compact
          onOpenSnap={onOpenSnap}
        />
      ))}
    </Stack>
  );
}
