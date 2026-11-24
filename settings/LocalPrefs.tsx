import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CardContent,
  Chip,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { DeviceRange, GatePrefs } from '../types.ts';
import { errorText, type GateApi } from '../api.ts';
import { DEFAULT_DEVICE_ASSOCIATION } from '../lib/shared.ts';
import { HelpTip } from '../HelpTip.tsx';

interface RelayNameBoxProps {
  relay: number;
  prefs: GatePrefs;
  gapi: GateApi;
  onSaved: () => Promise<void>;
}

/**
 * The name of one relay (a box in the Relays page's relay settings table). Saved on its own when the box loses
 * focus or on Enter; blank goes back to "Relay N". Shared by every account that manages the gate; not sent to it.
 *
 * @param props - Component props.
 * @param props.relay - Relay.
 * @param props.prefs - Gate-scoped preferences object.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onSaved - On saved.
 * @returns Rendered React element.
 */
export function RelayNameBox({ relay, prefs, gapi, onSaved }: RelayNameBoxProps) {
  const k = String(relay);
  const saved = (prefs.relayLabels && prefs.relayLabels[k]) || `Relay ${k}`;
  const [value, setValue] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setValue(saved); }, [saved]);
  const save = async () => {
    const next = value.trim() || `Relay ${k}`;
    setValue(next);
    if (next === saved) { setError(''); return; }
    setSaving(true);
    setError('');
    try {
      await gapi('PUT', '/prefs', { relayLabels: { [k]: next } });
      await onSaved();
    } catch (err) {
      setError(`Not saved: ${errorText(err)}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <TextField
      size="small"
      value={value}
      error={Boolean(error)}
      helperText={error || (saving ? 'Saving…' : undefined)}
      slotProps={{
        htmlInput: {
          maxLength: 24,
          'aria-label': `Relay ${relay} name`,
          'aria-invalid': Boolean(error) || undefined,
        },
      }}
      title={error || 'Relay name, saved when you leave the box. Shared by every account that manages this gate; not sent to the gate.'}
      sx={{
        width: '16ch',
        '& .MuiInputBase-input': { py: 0.5, px: 1, fontSize: '0.85rem' },
        '& .MuiFormHelperText-root': { mx: 0 },
      }}
      onChange={(event) => { setValue(event.target.value); if (error) setError(''); }}
      onBlur={save}
      onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
    />
  );
}

interface DeviceAssociationProps {
  prefs: GatePrefs;
  gapi: GateApi;
  onSaved: () => Promise<void>;
}

/**
 * Device Association: names for ranges of device codes (00001-65407), up to 10 rows. The server checks names,
 * ranges and overlaps on save.
 *
 * @param props - Component props.
 * @param props.prefs - Gate-scoped preferences object.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onSaved - On saved.
 * @returns Rendered React element.
 */
export function DeviceAssociation({ prefs, gapi, onSaved }: DeviceAssociationProps) {
  const fill = (list: DeviceRange[]) => Array.from({ length: 10 }, (_, i) => ({ ...(list[i] || { name: '', from: '', to: '' }) }));
  const [rows, setRows] = useState(() => fill(prefs.deviceAssociation || DEFAULT_DEVICE_ASSOCIATION));
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const set = (i: number, key: keyof DeviceRange, value: string) => setRows(rows.map((row, j) => (j === i ? { ...row, [key]: value } : row)));
  const save = async () => {
    setError('');
    setInfo('Saving…');
    try {
      const reply = await gapi<GatePrefs>('PUT', '/prefs', { deviceAssociation: rows.map((row) => ({ name: row.name.trim(), from: row.from.trim(), to: row.to.trim() })) });
      setRows(fill(reply.deviceAssociation || []));
      setInfo('Saved.');
      await onSaved(); // card transactions take their Event Type from these ranges
    } catch (err) {
      setInfo('');
      setError(`Save failed: ${errorText(err)}`);
    }
  };
  return (
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2" sx={{ display: 'flex', alignItems: 'center' }}>
            Device association<HelpTip of="deviceAssociation" />
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Names (up to 12 characters) for ranges of device codes (00001–65407), like DoorKing32&apos;s <em>Dev Enable</em> window. Up to 10 rows; ranges may not
            overlap. Stored locally and <strong>shared by every account that manages this gate</strong>. Not sent to the gate.
          </Typography>
          <Stack spacing={1} sx={{ width: '100%', maxWidth: 640 }}>
            {rows.map((row, i) => {
              const active = Boolean(row.name.trim() || row.from.trim() || row.to.trim());
              return (
                <Paper key={i} variant="outlined" sx={{ px: 1.5, py: 0.75, width: '100%', boxSizing: 'border-box' }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%' }}>
                    <Chip
                      size="small"
                      color={active ? 'primary' : 'default'}
                      label={`#${i + 1}`}
                      sx={{ minWidth: 36, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
                    />
                    <TextField
                      size="small"
                      placeholder="Device name"
                      value={row.name}
                      slotProps={{ htmlInput: { maxLength: 12, 'aria-label': `Row ${i + 1} device name` } }}
                      sx={{ flex: '1 1 auto', minWidth: 0, '& .MuiInputBase-input': { py: 0.5, px: 1, fontSize: '0.85rem' } }}
                      onChange={(event) => set(i, 'name', event.target.value)}
                    />
                    <TextField
                      size="small"
                      placeholder="From"
                      value={row.from}
                      slotProps={{ htmlInput: { maxLength: 5, inputMode: 'numeric', 'aria-label': `Row ${i + 1} from` } }}
                      sx={{
                        width: '7.5ch',
                        flexShrink: 0,
                        '& .MuiInputBase-input': { py: 0.5, px: 0.75, fontSize: '0.85rem', textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
                      }}
                      onChange={(event) => set(i, 'from', event.target.value)}
                    />
                    <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>–</Typography>
                    <TextField
                      size="small"
                      placeholder="To"
                      value={row.to}
                      slotProps={{ htmlInput: { maxLength: 5, inputMode: 'numeric', 'aria-label': `Row ${i + 1} to` } }}
                      sx={{
                        width: '7.5ch',
                        flexShrink: 0,
                        '& .MuiInputBase-input': { py: 0.5, px: 0.75, fontSize: '0.85rem', textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
                      }}
                      onChange={(event) => set(i, 'to', event.target.value)}
                    />
                  </Stack>
                </Paper>
              );
            })}
          </Stack>
          <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="contained" onClick={save}>Save</Button>
            {info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
          </Stack>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
}
