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
  Divider,
  Drawer,
  Fab,
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
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import CreditCardOutlinedIcon from '@mui/icons-material/CreditCardOutlined';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import SensorsOutlinedIcon from '@mui/icons-material/SensorsOutlined';
import { MobileFilterChip, MobileSearchBar } from './MobilePrimitives.tsx';
import type { DeviceRange, EntryChange, GateFeatures, ResidentRow, ResidentsReply, TransactionRow } from '../types.ts';
import { cell, dirCell, doorKingCsv, downloadText, fieldOf, fmtTime, isEmptySlot, phoneFull, txTone } from '../format.ts';
import { nextSort, SortHead, sortRows, useShownRows, type Column, type Sort } from '../table.tsx';
import { CardList } from './fields.tsx';
import { SnapCell } from '../camera/SnapViews.tsx';
import type { Snaps } from '../camera/snapshots.ts';
import { ImportCsvDialog } from './ImportCsvDialog.tsx';
import { ResidentForm } from './ResidentForm.tsx';
import { WelcomeInstructionsDialog } from './WelcomeInstructionsDialog.tsx';
import { hidePortalHoldNoise, TransactionCard } from './Transactions.tsx';
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
  exportSignal?: number;
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
export function Directory({ kind, gatePhone, adminPhone, account, list, tx, devices, features, snaps, onOpenSnap, highlight, exportSignal = 0, gapi, onReload }: DirectoryProps) {
  const cols = COLUMNS[kind].filter(([, k]) => (k !== 'floor' || features.floors) && (k !== 'elevatorRef' || features.elevators));
  const vendor = kind === 'vendors';
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<Sort | null>(null);
  const [open, setOpen] = useState<string | null>(highlight);
  const [editing, setEditing] = useState(false);
  const [editingTarget, setEditingTarget] = useState<ResidentRow | null>(null);
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
  useBackLayer(editing || Boolean(editingTarget), () => { setEditing(false); setEditingTarget(null); }, leaveForm);
  const readOnly = useReadOnly();
  const phone = usePhone(); // phones: no Export CSV

  useEffect(() => {
    setOpen(highlight);
    setEditing(false);
    setEditingTarget(null);
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
  const csv = () => list && downloadText(
    vendor ? `vendors-${gatePhone}.csv` : `residents-${gatePhone}.csv`,
    doorKingCsv(account, list.rows || [], list.unassignedCards),
  );
  useEffect(() => {
    if (exportSignal > 0) csv();
  }, [exportSignal]);
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
      {!phone && <Typography variant="h5">{kind === 'vendors' ? 'Vendors' : 'Residents'}</Typography>}
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
      {!phone && adding && list && (
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
      {phone ? (
        <Stack spacing={1}>
          <MobileSearchBar
            value={filter}
            onChange={setFilter}
            placeholder={vendor ? 'Search vendors' : 'Search residents'}
          />
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Stack direction="row" sx={{ gap: '6px', alignItems: 'center' }}>
              {([['Name', 'name'], ['Unit', 'directoryCode'], ['Code', 'entryCode']] as const).map(([label, key]) => {
                const active = sort?.col === key || (!sort && key === 'name');
                return (
                  <MobileFilterChip
                    key={key}
                    label={label}
                    selected={active}
                    showCheck
                    onClick={() => setSort(nextSort(sort, key))}
                  />
                );
              })}
            </Stack>
            {list && (
              <Chip
                size="small"
                label={`${rows.length} shown`}
                sx={{
                  height: 26,
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  bgcolor: 'var(--md-surface-highest)',
                  color: 'text.secondary',
                }}
              />
            )}
          </Stack>
        </Stack>
      ) : (
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          {!readOnly && (
            <Button variant="contained" onClick={() => setAdding(!adding)} disabled={!list}>
              {vendor ? 'Add vendor' : 'Add resident'}
            </Button>
          )}
          {!readOnly && (
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
          <Button
            variant="outlined"
            onClick={csv}
            disabled={!list}
            title="Every directory code (residents, vendors and empty units), in the format DoorKing's cloud exports"
          >
            Export CSV
          </Button>
          <Typography variant="body2" color="text.secondary">
            {!list ? 'No data yet. Pull residents from the gate.'
              : `${rows.length} ${kind}${rows.length > limit ? ` (first ${limit} shown)` : ''} · downloaded ${fmtTime(list.updated)}`
                + (kind === 'residents' && list.unassignedCards.length ? ` · ${list.unassignedCards.length} cards without a directory code` : '')}
          </Typography>
        </Stack>
      )}
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
        <>
          <Stack spacing={1.25}>
            {visibleRows.map((resident) => {
              const isOpen = open === resident.directoryCode;
              const phoneText = !vendor ? phoneFull(resident) : '';
              const hasDup = dupCell(resident, 'directoryCode') || dupCell(resident, 'entryCode') || dupCell(resident, 'cards');
              return (
                <Paper
                  key={resident.directoryCode}
                  elevation={0}
                  data-code={resident.directoryCode}
                  sx={{
                    p: 2,
                    borderRadius: '12px',
                    bgcolor: resident.directoryCode === highlight
                      ? (theme) => alpha(theme.palette.primary.main, 0.14)
                      : hasDup
                        ? (theme) => alpha(theme.palette.error.main, 0.1)
                        : 'var(--md-surface-low)',
                    color: resident.hidden && !vendor ? 'text.secondary' : undefined,
                  }}
                >
                  <Stack spacing={1}>
                    <Box
                      onClick={() => { setOpen(isOpen ? null : resident.directoryCode); }}
                      sx={{ cursor: 'pointer' }}
                    >
                      <Stack spacing={1}>
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          <Typography
                            sx={{
                              fontSize: '1rem',
                              lineHeight: 1.4,
                              fontWeight: 500,
                              flex: 1,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {resident.name || '(Unnamed)'}
                          </Typography>
                          <Chip
                            size="small"
                            color="primary"
                            label={vendor ? `#${resident.directoryCode}` : `Unit ${resident.directoryCode}`}
                            sx={{ height: 26, fontSize: '0.75rem', fontWeight: 500 }}
                          />
                          {isOpen ? (
                            <ExpandLessIcon sx={{ fontSize: 22, color: 'text.secondary', flexShrink: 0 }} />
                          ) : (
                            <ExpandMoreIcon sx={{ fontSize: 22, color: 'text.secondary', flexShrink: 0 }} />
                          )}
                        </Stack>
                        <Stack direction="row" sx={{ gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                          {resident.entryCode && (
                            <Chip
                              size="small"
                              color={dupCell(resident, 'entryCode') ? 'error' : 'success'}
                              label={`#${resident.entryCode}`}
                              sx={{ height: 26, fontSize: '0.75rem', fontWeight: 500 }}
                            />
                          )}
                          {phoneText && (
                            <Chip size="small" label={phoneText} sx={{ height: 26, fontSize: '0.75rem', fontWeight: 500 }} />
                          )}
                          {resident.cards.length > 0 && (
                            <Chip
                              size="small"
                              label={`${resident.cards.length} card${resident.cards.length === 1 ? '' : 's'}`}
                              sx={{ height: 26, fontSize: '0.75rem', fontWeight: 500 }}
                            />
                          )}
                          {resident.portalEnabled && !vendor && (
                            <Chip size="small" color="success" label="Portal" sx={{ height: 26, fontSize: '0.75rem', fontWeight: 500 }} />
                          )}
                          {vendor && (
                            <Chip size="small" label="Vendor" sx={{ height: 26, fontSize: '0.75rem', fontWeight: 500 }} />
                          )}
                          {resident.hidden && !vendor && (
                            <Chip size="small" color="warning" label="Hidden" sx={{ height: 26, fontSize: '0.75rem', fontWeight: 500 }} />
                          )}
                          {hasDup && (
                            <Chip size="small" color="error" label="Duplicate" sx={{ height: 26, fontSize: '0.75rem', fontWeight: 500 }} />
                          )}
                        </Stack>
                      </Stack>
                    </Box>

                    {isOpen && (
                      <Stack spacing={1.25} sx={{ pt: 0.5 }}>
                        <Divider />
                        {resident.cards.length > 0 && (
                          <Paper elevation={0} sx={{ p: 1.5, borderRadius: '16px', bgcolor: 'var(--md-surface-high)' }}>
                            <Stack spacing={1}>
                              <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                                  Access cards &amp; remotes
                                </Typography>
                                <Chip size="small" color="primary" label={`${resident.cards.length}`} sx={{ height: 22 }} />
                              </Stack>
                              <Stack spacing="4px">
                                {resident.cards.map((cardNum, idx) => {
                                  const num = Number(cardNum);
                                  const match = devices.find((r) => Number(r.from) <= num && num <= Number(r.to));
                                  const devLabel = match?.name || 'Access Card';
                                  const isRemote = /click|remote|trans/i.test(devLabel);
                                  const isFob = /key|fob/i.test(devLabel);
                                  const isDupCard = dups.card.has(cardNum);
                                  const topR = idx === 0 ? '12px' : '4px';
                                  const botR = idx === resident.cards.length - 1 ? '12px' : '4px';
                                  return (
                                    <Paper
                                      key={cardNum}
                                      elevation={0}
                                      sx={{
                                        px: 1.5,
                                        py: 1,
                                        borderRadius: `${topR} ${topR} ${botR} ${botR}`,
                                        bgcolor: isDupCard ? 'var(--md-error-container)' : 'var(--md-surface-lowest)',
                                      }}
                                    >
                                      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center' }}>
                                        {isRemote ? (
                                          <SensorsOutlinedIcon sx={{ fontSize: 18, color: 'primary.main' }} />
                                        ) : isFob ? (
                                          <KeyOutlinedIcon sx={{ fontSize: 18, color: 'primary.main' }} />
                                        ) : (
                                          <CreditCardOutlinedIcon sx={{ fontSize: 18, color: 'primary.main' }} />
                                        )}
                                        <Box sx={{ flex: 1, minWidth: 0 }}>
                                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.2 }}>
                                            {devLabel}
                                          </Typography>
                                          <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.875rem' }}>
                                            #{cardNum}
                                          </Typography>
                                        </Box>
                                        <IconButton
                                          size="small"
                                          aria-label={`Copy card ${cardNum}`}
                                          onClick={() => { void navigator.clipboard?.writeText(cardNum); }}
                                          sx={{ color: 'text.secondary' }}
                                        >
                                          <ContentCopyOutlinedIcon sx={{ fontSize: 16 }} />
                                        </IconButton>
                                      </Stack>
                                    </Paper>
                                  );
                                })}
                              </Stack>
                            </Stack>
                          </Paper>
                        )}
                        {resident.note && (
                          <Typography variant="body2" color="text.secondary">
                            Note: {resident.note}
                          </Typography>
                        )}
                        <MobileRecentTransactions resident={resident} tx={tx} snaps={snaps} onOpenSnap={onOpenSnap} />
                        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                          {!readOnly && (
                            <Button
                              variant="contained"
                              startIcon={<EditOutlinedIcon sx={{ fontSize: 18 }} />}
                              onClick={() => setEditingTarget(resident)}
                              sx={{ flex: 1, minHeight: 44, borderRadius: '14px' }}
                            >
                              Edit
                            </Button>
                          )}
                          {!vendor && (
                            <Button
                              variant="outlined"
                              startIcon={<PictureAsPdfOutlinedIcon sx={{ fontSize: 18 }} />}
                              onClick={() => setWelcomeResident(resident)}
                              sx={{ flex: 1, minHeight: 44, borderRadius: '14px' }}
                            >
                              PDF
                            </Button>
                          )}
                          {!readOnly && (
                            <IconButton
                              aria-label={`Delete ${resident.name || resident.directoryCode}`}
                              onClick={async () => {
                                if (!await confirm({
                                  title: `Delete ${resident.name || resident.directoryCode}?`,
                                  body: 'Removes this entry in the working copy. Nothing touches the physical gate until you Send to gate.',
                                  action: 'Delete',
                                  color: 'red',
                                })) return;
                                try {
                                  await gapi('DELETE', `/residents/${encodeURIComponent(resident.directoryCode)}`);
                                  setOpen(null);
                                  await onReload();
                                } catch (err) {
                                  setBulkError(errorText(err));
                                }
                              }}
                              sx={{
                                width: 44,
                                height: 44,
                                borderRadius: '14px',
                                bgcolor: 'var(--md-error-container)',
                                color: 'var(--md-on-error-container)',
                                '&:hover': { bgcolor: 'var(--md-error-container)', filter: 'brightness(0.95)' },
                              }}
                            >
                              <DeleteOutlinedIcon />
                            </IconButton>
                          )}
                        </Stack>
                      </Stack>
                    )}
                  </Stack>
                </Paper>
              );
            })}
          </Stack>

          {/* Material 3 Extended FAB matching Android "+ Add resident" / "+ Add vendor" (primaryContainer) */}
          {!readOnly && list && (
            <Fab
              variant="extended"
              onClick={() => { setEditingTarget(null); setAdding(true); }}
              sx={{
                position: 'fixed',
                right: 'calc(env(safe-area-inset-right) + 16px)',
                bottom: 'calc(env(safe-area-inset-bottom) + 96px)',
                zIndex: 1050,
                height: 56,
                borderRadius: '16px',
                bgcolor: 'var(--md-primary-container)',
                color: 'var(--md-on-primary-container)',
                textTransform: 'none',
                fontWeight: 600,
                fontSize: '0.875rem',
                px: 2.25,
                boxShadow: 3,
                '&:hover': {
                  bgcolor: 'var(--md-primary-container)',
                  filter: 'brightness(0.96)',
                },
              }}
            >
              <AddIcon sx={{ mr: 1 }} />
              {vendor ? 'Add vendor' : 'Add resident'}
            </Fab>
          )}

          {/* Slide-up bottom sheet for Add / Edit Resident & Vendor (matches Android ModalBottomSheet) */}
          <Drawer
            anchor="bottom"
            open={Boolean(list && (adding || editingTarget))}
            onClose={() => { setAdding(false); setEditingTarget(null); }}
            slotProps={{
              paper: {
                sx: {
                  maxHeight: '92dvh',
                  overflowY: 'auto',
                  borderTopLeftRadius: 28,
                  borderTopRightRadius: 28,
                  bgcolor: 'var(--md-surface-low)',
                  pb: 'env(safe-area-inset-bottom)',
                },
              },
            }}
          >
            <Box sx={{ width: 32, height: 4, borderRadius: 2, bgcolor: 'text.disabled', mx: 'auto', mt: 1.5, mb: 0.5, opacity: 0.4 }} />
            <Box sx={{ px: 2.5, py: 1.5 }}>
              {list && (adding || editingTarget) && (
                <ResidentForm
                  resident={editingTarget}
                  vendor={vendor}
                  gatePhone={gatePhone}
                  siteName={account}
                  dirDigits={list.dirDigits}
                  emptyCodes={list.emptyCodes}
                  usedEntryCodes={
                    editingTarget
                      ? usedEntryCodes.filter((code) => code !== editingTarget.entryCode)
                      : usedEntryCodes
                  }
                  adminPhone={adminPhone}
                  grantAccessDigit={grantAccessDigit}
                  devices={devices}
                  features={features}
                  gapi={gapi}
                  onDone={async () => { setAdding(false); setEditingTarget(null); await onReload(); }}
                  onAdminPhoneSaved={onReload}
                  onCancel={() => { setAdding(false); setEditingTarget(null); }}
                />
              )}
            </Box>
          </Drawer>
        </>
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
const RECENT_TX_COLS: [string, string][] = [
  ['Date', 'date'],
  ['Time', 'time'],
  ['Event Type', 'eventType'],
  ['Number', 'number'],
  ['Access', 'access'],
  ['Relay', 'relay'],
];

const RECENT_TONE_KEY = { red: 'error', amber: 'warning', green: 'success' } as const;

/**
 * Classic compact desktop table of the last 5 transactions for a resident/vendor (matched on directory code).
 * Used strictly in the desktop Residents/Vendors expanded row; mobile uses `MobileRecentTransactions`.
 */
function RecentTransactions({ resident, tx, snaps, onOpenSnap }: RecentTransactionsProps) {
  if (!tx) return <Typography variant="body2" color="text.secondary">No transactions yet. Pull transactions from the gate.</Typography>;
  const recent = hidePortalHoldNoise(tx)
    .filter((transaction) => transaction.directoryCode === resident.directoryCode)
    .slice(0, 5);
  if (!recent.length) return <Typography variant="body2" color="text.secondary">No transactions for this entry.</Typography>;
  const cols = snaps.settings ? [...RECENT_TX_COLS, ['Camera', 'snap'] as [string, string]] : RECENT_TX_COLS;
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small">
        <TableHead>
          <TableRow>
            {cols.map(([header]) => (
              <TableCell key={header}>{header}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {recent.map((transaction, i) => {
            const tone = txTone(transaction);
            return (
              <TableRow
                key={`${transaction.raw}-${i}`}
                sx={{
                  bgcolor: tone ? (theme) => alpha(theme.palette[RECENT_TONE_KEY[tone]].main, 0.12) : undefined,
                }}
              >
                {cols.map(([, key]) => (
                  <TableCell key={key}>
                    {key === 'snap' ? (
                      <SnapCell transaction={transaction} snaps={snaps} onOpen={onOpenSnap} />
                    ) : key === 'eventType' && transaction.source === 'portal' ? (
                      <Chip color="primary" size="small" label="Portal Open" />
                    ) : (
                      cell(fieldOf(transaction, key))
                    )}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/**
 * Collapsible mobile Recent Transactions container cloning Android's `ResidentRecentTransactionsSection`.
 */
function MobileRecentTransactions({ resident, tx, snaps, onOpenSnap }: RecentTransactionsProps) {
  const [expanded, setExpanded] = useState(false);
  const norm = (c: string) => c.trim().replace(/^0+/, '') || c.trim();
  const target = norm(resident.directoryCode);
  const recent = useMemo(
    () => (tx || []).filter((t) => t.directoryCode && norm(t.directoryCode) === target).slice(0, 5),
    [tx, target],
  );
  return (
    <Paper elevation={0} sx={{ borderRadius: '16px', bgcolor: 'var(--md-surface-high)', overflow: 'hidden' }}>
      <Box
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v); } }}
        sx={{
          px: 1.5,
          py: 1.25,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
          Recent transactions
        </Typography>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
          <Chip
            size="small"
            color={recent.length > 0 ? 'primary' : 'default'}
            label={tx ? `${recent.length}` : '—'}
            sx={{ height: 22 }}
          />
          {expanded ? (
            <ExpandLessIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
          ) : (
            <ExpandMoreIcon sx={{ fontSize: 20, color: 'text.secondary' }} />
          )}
        </Stack>
      </Box>
      {expanded && (
        <Box sx={{ px: 1.5, pb: 1.5 }}>
          {!tx ? (
            <Typography variant="caption" color="text.secondary">
              Pull transactions from the Gate tab to see recent activity.
            </Typography>
          ) : recent.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              No recent activity for this unit.
            </Typography>
          ) : (
            <Stack spacing={0.75}>
              {recent.map((transaction, i) => (
                <Box key={`${transaction.raw}-${i}`} sx={{ '& > .MuiPaper-root': { bgcolor: 'var(--md-surface-lowest)' } }}>
                  <TransactionCard
                    transaction={transaction}
                    snaps={snaps}
                    compact
                    onOpenSnap={onOpenSnap}
                  />
                </Box>
              ))}
            </Stack>
          )}
        </Box>
      )}
    </Paper>
  );
}
