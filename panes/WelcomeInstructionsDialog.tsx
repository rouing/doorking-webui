/**
 * @module web/ui/panes/WelcomeInstructionsDialog
 *
 * Modal for generating a copy-paste-ready resident welcome message and downloading an auto-filled
 * `ResidentInstructions.pdf` handout (DoorKing form 1834-066).
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { buildWelcomeMessage } from '../lib/shared.ts';
import { errorText, gateUrl, useReadOnly } from '../api.ts';
import { useBackLayer } from '../back.ts';
import { Field } from './fields.tsx';

export interface WelcomeResidentInfo {
  name: string;
  directoryCode: string;
  entryCode: string;
  hidden: boolean;
  cards: string[];
}

interface WelcomeInstructionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phone: string;
  siteName: string;
  resident: WelcomeResidentInfo;
  defaultAdminPhone: string;
  defaultGrantDigit: string;
  onAdminPhoneSaved?: () => Promise<void>;
}

/**
 * Displays a ready-to-copy resident welcome message and downloads a pre-filled `ResidentInstructions.pdf`.
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
export function WelcomeInstructionsDialog({
  open, onOpenChange, phone, siteName, resident, defaultAdminPhone, defaultGrantDigit, onAdminPhoneSaved,
}: WelcomeInstructionsDialogProps) {
  const readOnly = useReadOnly();
  const [adminPhone, setAdminPhone] = useState(defaultAdminPhone);
  const [saveAdminPhone, setSaveAdminPhone] = useState(true);
  const [grantDigit, setGrantDigit] = useState(defaultGrantDigit || '9');
  const [customMessage, setCustomMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyPdf, setBusyPdf] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');

  useBackLayer(open, () => onOpenChange(false));

  useEffect(() => {
    if (!open) return;
    setAdminPhone(defaultAdminPhone);
    setGrantDigit(defaultGrantDigit || '9');
    setCustomMessage(null);
    setCopied(false);
    setInfo('');
    setError('');
  }, [open, defaultAdminPhone, defaultGrantDigit, resident.directoryCode, resident.name, resident.entryCode]);

  const generated = buildWelcomeMessage({
    siteName,
    residentName: resident.name,
    directoryCode: resident.directoryCode,
    entryCode: resident.entryCode,
    grantAccessDigit: grantDigit,
    adminPhone,
    hidden: resident.hidden,
    cards: resident.cards,
  });
  const message = customMessage ?? generated;

  const copyMessage = async () => {
    setError('');
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setInfo('Welcome message copied to clipboard.');
      setTimeout(() => setCopied(false), 2500);
    } catch (err) {
      setInfo('');
      setError(`Could not copy: ${errorText(err)}`);
    }
  };

  const downloadPdf = async () => {
    setBusyPdf(true);
    setInfo('');
    setError('');
    try {
      const shouldSave = !readOnly && saveAdminPhone && adminPhone.trim() !== defaultAdminPhone.trim();
      const res = await fetch(gateUrl(phone, '/residents/instructions.pdf'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          residentName: resident.name,
          directoryCode: resident.directoryCode,
          entryCode: resident.entryCode,
          adminPhone: adminPhone.trim(),
          grantAccessDigit: grantDigit.trim() || '9',
          saveAdminPhone: shouldSave,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match ? match[1] : 'ResidentInstructions.pdf';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      if (shouldSave && onAdminPhoneSaved) await onAdminPhoneSaved();
      setInfo(`Downloaded ${filename}.`);
    } catch (err) {
      setError(`PDF download failed: ${errorText(err)}`);
    } finally {
      setBusyPdf(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => onOpenChange(false)} maxWidth="sm" fullWidth onClick={(event) => event.stopPropagation()}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <span>Resident welcome &amp; instructions{resident.name ? ` · ${resident.name}` : ''}</span>
        <IconButton size="small" aria-label="Close" onClick={() => onOpenChange(false)}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Copy a ready-to-send welcome message or download the pre-filled DoorKing <strong>ResidentInstructions.pdf</strong> handout
            (with manager phone, Touch-Tone grant access digit, directory code, and 4-digit entry code filled in).
          </Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
            <Field label="Building manager / HOA phone #">
              <TextField
                size="small"
                fullWidth
                value={adminPhone}
                placeholder="(214) 555-0100"
                slotProps={{ htmlInput: { maxLength: 30, 'aria-label': 'Building manager or HOA phone number' } }}
                onChange={(event) => { setAdminPhone(event.target.value); setCustomMessage(null); }}
              />
              {!readOnly && (
                <FormControlLabel
                  control={<Checkbox size="small" checked={saveAdminPhone} onChange={(event) => setSaveAdminPhone(event.target.checked)} />}
                  label={<Typography variant="caption" color="text.secondary">Remember this phone # for this gate</Typography>}
                  sx={{ mt: 0.25 }}
                />
              )}
            </Field>
            <Field label="Touch-Tone grant access key">
              <TextField
                size="small"
                fullWidth
                value={grantDigit}
                placeholder="9"
                slotProps={{ htmlInput: { maxLength: 4, 'aria-label': 'Touch-Tone grant access key' } }}
                onChange={(event) => { setGrantDigit(event.target.value); setCustomMessage(null); }}
              />
              <Typography variant="caption" color="text.secondary">Pre-filled from Relay 0 tone open setting.</Typography>
            </Field>
          </Box>
          <Field label="Welcome message (email or SMS)">
            <TextField
              multiline
              minRows={10}
              fullWidth
              value={message}
              slotProps={{ htmlInput: { 'aria-label': 'Welcome message' } }}
              onChange={(event) => setCustomMessage(event.target.value)}
            />
          </Field>
          {error && <Alert severity="error">{error}</Alert>}
          {info && <Alert severity="success">{info}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2, flexWrap: 'wrap', gap: 1, justifyContent: 'space-between' }}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="contained" onClick={downloadPdf} disabled={busyPdf}>
            {busyPdf ? 'Generating PDF…' : 'Download ResidentInstructions.pdf'}
          </Button>
          <Button variant="outlined" onClick={copyMessage}>
            {copied ? 'Copied!' : 'Copy welcome message'}
          </Button>
          {customMessage !== null && (
            <Button variant="text" color="inherit" size="small" onClick={() => setCustomMessage(null)}>Reset text</Button>
          )}
        </Stack>
        <Button color="inherit" onClick={() => onOpenChange(false)}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
