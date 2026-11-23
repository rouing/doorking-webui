/**
 * @module web/ui/panes/ImportCsvDialog
 *
 * CSV import dialog for Residents/Vendors with server-side dry-run preview (`POST /residents/import`).
 */
import { useState, type ChangeEvent } from 'react';
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
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
import CloseIcon from '@mui/icons-material/Close';
import type { SendChange } from '../../../src/types.ts';
import { parseNanpPhone } from '../../../src/shared.ts';
import { errorText, type GateApi } from '../api.ts';
import { useBackLayer } from '../back.ts';

interface ImportRow {
  directoryCode: string;
  name: string;
  vendor?: boolean;
  areaCode?: string;
  phone?: string;
  entryCode?: string;
  securityLevel?: number;
  cards?: string[];
  note?: string;
}

interface PreviewReply {
  added: number;
  updated: number;
  errors: { row: number; directoryCode: string; error: string }[];
  changes: SendChange[];
}

/** Splits one CSV line honoring quoted fields and escaped `""`. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { cells.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Parses CSV text (either simple `directoryCode,name,phone,entryCode,securityLevel,cards,note` or DoorKing export
 * headers `Dir,Resident,AAC,PHONE,ENT,SL,Device,Vendor,RESIDENTNOTES`) into import row objects.
 *
 * @param text - Raw CSV text.
 * @param defaultVendor - Whether rows without an explicit Vendor column are imported as vendors.
 * @returns Parsed `ImportRow[]`.
 */
export function parseImportCsv(text: string, defaultVendor: boolean): ImportRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const col = (...names: string[]) => {
    for (const candidate of names) {
      const idx = headers.indexOf(candidate);
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const codeCol = col('directorycode', 'dir', 'code');
  const nameCol = col('name', 'resident');
  const areaCodeCol = col('areacode', 'aac');
  const phoneCol = col('phone', 'phonenumber');
  const entryCol = col('entrycode', 'ent');
  const securityCol = col('securitylevel', 'security', 'sl');
  const vendorCol = col('vendor');
  const noteCol = col('residentnotes', 'note', 'notes');
  const cardCols = headers.map((h, idx) => (/^(cards?|device\d*)$/.test(h) ? idx : -1)).filter((idx) => idx >= 0);

  const out: ImportRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const directoryCode = codeCol >= 0 ? cells[codeCol] || '' : '';
    const name = nameCol >= 0 ? cells[nameCol] || '' : '';
    if (!directoryCode && !name) continue;
    const rawPhone = (phoneCol >= 0 ? cells[phoneCol] || '' : '').replace(/\D/g, '');
    const rawArea = (areaCodeCol >= 0 ? cells[areaCodeCol] || '' : '').replace(/\D/g, '');
    const parsed = !rawArea ? parseNanpPhone(rawPhone, { keepLeadingOne: true }) : null;
    const areaCode = rawArea || parsed?.areaCode || '';
    const phone = parsed ? parsed.phone : rawPhone;
    const cards = cardCols.flatMap((idx) => (cells[idx] || '').split(/[\s;]+/).map((c) => c.trim()).filter(Boolean));
    const secText = securityCol >= 0 ? cells[securityCol] || '' : '';
    const vendorText = vendorCol >= 0 ? (cells[vendorCol] || '').toLowerCase() : '';
    out.push({
      directoryCode,
      name,
      vendor: vendorCol >= 0 ? (vendorText === 'y' || vendorText === 'yes' || vendorText === 'true') : defaultVendor,
      ...(areaCode && { areaCode }),
      ...(phone && { phone }),
      ...(entryCol >= 0 && cells[entryCol] && { entryCode: cells[entryCol] }),
      ...(secText !== '' && !Number.isNaN(Number(secText)) && { securityLevel: Number(secText) }),
      ...(cards.length > 0 && { cards }),
      ...(noteCol >= 0 && cells[noteCol] && { note: cells[noteCol] }),
    });
  }
  return out;
}

interface ImportCsvDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vendor: boolean;
  gapi: GateApi;
  onImported: () => Promise<void>;
}

/**
 * Dialog for uploading or pasting CSV resident/vendor rows, previewing the exact working-copy diff, and applying.
 *
 * @param props - Component props.
 * @param props.open - Whether the dialog is open.
 * @param props.onOpenChange - Callback toggling open state.
 * @param props.vendor - Default vendor flag when CSV has no Vendor column.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onImported - Callback reloading residents after a successful import.
 * @returns Rendered React element.
 */
export function ImportCsvDialog({ open, onOpenChange, vendor, gapi, onImported }: ImportCsvDialogProps) {
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<PreviewReply | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useBackLayer(open, () => onOpenChange(false));

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setCsvText(await file.text());
    setPreview(null);
    setError('');
  };

  async function runImport(dryRun: boolean) {
    const rows = parseImportCsv(csvText, vendor);
    if (!rows.length) { setError('Paste or upload a CSV with a header row and at least one entry.'); return; }
    setBusy(true);
    setError('');
    try {
      const reply = await gapi<PreviewReply>('POST', '/residents/import', { rows, dryRun });
      if (dryRun) {
        setPreview(reply);
      } else {
        setPreview(null);
        setCsvText('');
        onOpenChange(false);
        await onImported();
      }
    } catch (err) { setError(errorText(err)); }
    setBusy(false);
  }

  return (
    <Dialog open={open} onClose={() => onOpenChange(false)} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <span>Import CSV to working copy</span>
        <IconButton size="small" aria-label="Close" onClick={() => onOpenChange(false)}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Accepts simple headers (<code>directoryCode,name,phone,entryCode,securityLevel,cards,note</code>) or
            DoorKing&apos;s <code>ResidentsExport.csv</code>. Preview shows the exact working-copy diff before saving.
          </Typography>
          <input type="file" accept=".csv,text/csv" aria-label="Upload CSV file" onChange={onFile} />
          <TextField
            multiline
            minRows={6}
            fullWidth
            placeholder={'directoryCode,name,phone,entryCode,cards\n101,Smith J,2145550101,4821,10234'}
            slotProps={{ htmlInput: { 'aria-label': 'CSV rows' } }}
            value={csvText}
            onChange={(event) => { setCsvText(event.target.value); setPreview(null); }}
          />
          {error && <Alert severity="error">{error}</Alert>}
          <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Button variant="outlined" disabled={busy || !csvText.trim()} onClick={() => runImport(true)}>Preview diff</Button>
            {preview && preview.errors.length === 0 && (
              <Button variant="contained" disabled={busy} onClick={() => runImport(false)}>
                Apply import ({preview.added} added, {preview.updated} updated)
              </Button>
            )}
          </Stack>
          {preview && (
            <Stack spacing={1.5}>
              <Typography variant="body2">
                Preview: <strong>{preview.added}</strong> added, <strong>{preview.updated}</strong> updated
                {preview.errors.length > 0 ? `, ${preview.errors.length} error(s)` : ''}.
              </Typography>
              {preview.errors.length > 0 && (
                <Alert severity="error">
                  <Stack spacing={0.5}>
                    {preview.errors.slice(0, 10).map((item) => (
                      <Typography key={`${item.row}-${item.directoryCode}`} variant="caption">
                        Row {item.row} ({item.directoryCode || 'no code'}): {item.error}
                      </Typography>
                    ))}
                  </Stack>
                </Alert>
              )}
              {preview.changes.length > 0 && (
                <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 240 }}>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Item</TableCell>
                        <TableCell>Field</TableCell>
                        <TableCell>Before</TableCell>
                        <TableCell>After</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {preview.changes.slice(0, 40).flatMap((item) => item.fields.map((field, idx) => (
                        <TableRow key={`${item.key}-${field.field}-${idx}`}>
                          <TableCell>
                            {idx === 0 && (
                              <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                                <Typography variant="body2" sx={{ fontWeight: 500 }}>{item.label}</Typography>
                                <Chip size="small" label={item.change} color={item.change === 'added' ? 'success' : 'primary'} />
                              </Stack>
                            )}
                          </TableCell>
                          <TableCell>{field.field}</TableCell>
                          <TableCell>
                            <Typography variant="body2" color="text.secondary">{field.from || '—'}</Typography>
                          </TableCell>
                          <TableCell>{field.to || '—'}</TableCell>
                        </TableRow>
                      )))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Stack>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button color="inherit" onClick={() => onOpenChange(false)}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
