import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import type { GateConfig as Config, GateFeatures, GatePrefs, ResidentsReply } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { featuresOf, trackerOf } from '../format.ts';
import { Choice, Field } from '../panes/fields.tsx';
import { HelpTip } from '../HelpTip.tsx';
import { GATE_CONFIG_KEYS } from '../../../src/shared.ts';

export const CONFIG_OPTIONS: Partial<Record<keyof Config, string[]>> = {
  memorySize: ['1000', '2000', '3000'], areaCodes: ['10 Area Codes', '255 Area Codes'], modelNumber: ['1833/1835/1837/1838', '1834'],
  antiPassBack: ['N', 'Y'], interface1816: ['N', 'Y'],
};
export const CONFIG_LABELS: Record<keyof Config, string> = {
  siteName: 'Site name', memorySize: 'System memory', areaCodes: 'Area codes', modelNumber: 'Model',
  antiPassBack: 'Anti-passback', interface1816: 'Interface 1816/1820',
};

interface ConfigFieldsProps {
  config: Record<string, string>;
  onChange: (cfg: Record<string, string>) => void;
  disabled?: boolean;
}

/**
 * Gate configuration (must match the gate; DKS Cloud uses it to connect), the working copy's area codes and the
 * directory code digits. gate: what the gate's last pull records (system memory, memory chips), to point out a mismatch.
 * The gate configuration fields (drop-downs for the settings with fixed choices).
 *
 * @param props - Component props.
 * @param props.config - Validated server configuration.
 * @param props.onChange - Callback invoked when the value changes.
 * @param props.disabled - Whether the control is disabled.
 * @returns Rendered React element.
 */
export function ConfigFields({ config, onChange, disabled }: ConfigFieldsProps) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' }, gap: 2 }}>
      {GATE_CONFIG_KEYS.map((key) => (
        <Field key={key} label={CONFIG_LABELS[key]} help={key}>
          {CONFIG_OPTIONS[key]
            ? (
              <Choice
                value={config[key]}
                ariaLabel={CONFIG_LABELS[key]}
                onChange={(value) => onChange({ ...config, [key]: value })}
                options={CONFIG_OPTIONS[key]!}
                disabled={disabled}
              />
            ) : (
              <TextField
                size="small"
                value={config[key]}
                slotProps={{ htmlInput: { maxLength: 40, 'aria-label': CONFIG_LABELS[key] } }}
                onChange={(event) => onChange({ ...config, [key]: event.target.value })}
                disabled={disabled}
              />
            )}
        </Field>
      ))}
    </Box>
  );
}

interface GateConfigProps {
  prefs: GatePrefs;
  defaults: Config;
  list: ResidentsReply | null;
  gapi: GateApi;
  gate?: { memory?: string; chips?: string };
  onSaved: () => Promise<void>;
}

/**
 * GateConfig React component.
 *
 * @param props - Component props.
 * @param props.prefs - Gate-scoped preferences object.
 * @param props.defaults - Defaults.
 * @param props.list - List of input items.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param [props.gate] - Currently open gate summary (`GateInfo`).
 * @param props.onSaved - On saved.
 * @returns Rendered React element.
 */
export function GateConfig({ prefs, defaults, list, gapi, gate = {}, onSaved }: GateConfigProps) {
  const [cfg, setCfg] = useState<Record<string, string>>(() => Object.fromEntries(GATE_CONFIG_KEYS.map((key) => [key, (prefs.gateConfig && prefs.gateConfig[key]) || defaults[key] || ''])));
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [digits, setDigits] = useState(String(list ? list.dirDigits : 3));
  const [digitsInfo, setDigitsInfo] = useState('');
  const [digitsError, setDigitsError] = useState('');
  const [features, setFeatures] = useState<GateFeatures>(() => featuresOf(prefs));
  const [featuresInfo, setFeaturesInfo] = useState('');
  const [featuresError, setFeaturesError] = useState('');
  const [tracker, setTracker] = useState(() => trackerOf(prefs).enabled);
  const [trackerInfo, setTrackerInfo] = useState('');
  const [trackerError, setTrackerError] = useState('');
  const [dialog, confirm] = useConfirm();
  const areaCodes = list ? list.areaCodes : [];
  const from = list ? list.dirDigits : 3;
  const saved = (key: keyof Config) => (prefs.gateConfig && prefs.gateConfig[key]) || defaults[key] || '';
  const mismatches = [
    ...(gate.memory && /^\d+$/.test(gate.memory) && saved('memorySize') !== gate.memory
      ? [`The gate records a system memory of ${gate.memory}, but System memory here is ${saved('memorySize')}.`] : []),
    ...(gate.chips === 'Anti-pass back' && saved('antiPassBack') !== 'Y'
      ? ['The gate reports anti-pass back memory chips, but Anti-passback here is N.'] : []),
    ...(gate.chips && gate.chips !== 'Anti-pass back' && !gate.chips.startsWith('?') && saved('antiPassBack') === 'Y'
      ? [`The gate reports ${gate.chips} memory chips (no anti-pass back), but Anti-passback here is Y.`] : []),
  ];

  async function save() {
    setError('');
    setInfo('Saving…');
    try {
      await gapi('PUT', '/prefs', { gateConfig: cfg });
      setInfo('Saved. Pulls and sends will use these.');
      await onSaved();
    } catch (err) {
      setInfo('');
      setError(`Save failed: ${errorText(err)}`);
    }
  }

  /**
   * The Floors/Elevators switches save at once; they only change what the page shows.
   *
   * @param key - Lookup key, API key, or setting key.
   * @param on - `boolean` value.
   */
  async function toggle(key: keyof GateFeatures, on: boolean) {
    const next = { ...features, [key]: on };
    setFeatures(next);
    setFeaturesError('');
    setFeaturesInfo('Saving…');
    try {
      await gapi('PUT', '/prefs', { features: next });
      setFeaturesInfo('Saved.');
      await onSaved();
    } catch (err) {
      setFeatures(features);
      setFeaturesInfo('');
      setFeaturesError(`Save failed: ${errorText(err)}`);
    }
  }

  async function toggleTracker(on: boolean) {
    setTracker(on);
    setTrackerError('');
    setTrackerInfo('Saving…');
    try {
      await gapi('PUT', '/prefs', { tracker: { ...prefs.tracker, enabled: on } });
      setTrackerInfo('Saved.');
      await onSaved();
    } catch (err) {
      setTracker(!on);
      setTrackerInfo('');
      setTrackerError(`Save failed: ${errorText(err)}`);
    }
  }

  async function changeDigits() {
    const to = Number(digits);
    setDigitsError('');
    if (to === from) { setDigitsInfo(`Already ${to} digits.`); return; }
    const decrease = to < from;
    const ok = await confirm(decrease
      ? { title: `Decrease to ${to} digits?`, action: 'Destroy resident data and change', color: 'red',
        body: `Decreasing from ${from} to ${to} digits DESTROYS ALL RESIDENT DATA in the working copy (directory, phone numbers, cards, area codes).` }
      : { title: `Increase to ${to} digits?`, action: 'Change digits',
        body: `Increase from ${from} to ${to} digits? Existing codes get leading zeros. Decreasing later will clear all resident data.` });
    if (!ok) { setDigits(String(from)); return; }
    try {
      await gapi('PUT', '/dir-digits', { digits: to, confirm: decrease });
      setDigitsInfo(`Changed to ${to} digits. Send to update the gate.`);
      await onSaved();
    } catch (err) {
      setDigitsInfo('');
      setDigitsError(`Change failed: ${errorText(err)}`);
    }
  }

  return (
    <Card>
      {dialog}
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Gate configuration</Typography>
          <Typography variant="body2" color="text.secondary">
            These must match the gate&apos;s own settings; DKS Cloud uses them to connect. Stored locally and <strong>shared by every
            account that manages this gate</strong> (keyed by system phone number). Pulls and sends use them automatically.
          </Typography>
          <ConfigFields config={cfg} onChange={setCfg} />
          {mismatches.map((mismatch) => (
            <Alert key={mismatch} severity="error" role="alert">
              {mismatch} They must match, or pulls and sends fail.
            </Alert>
          ))}
          <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="contained" onClick={save}>Save gate configuration</Button>
            {info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
          </Stack>
          {error && <Alert severity="error">{error}</Alert>}

          <Stack spacing={0.5}>
            <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <FormControlLabel
                sx={{ mr: 0 }}
                control={<Switch checked={tracker} onChange={(_, checked) => toggleTracker(checked)} />}
                label={
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center' }}>
                    Tracker (Tracker expansion boards are connected; not for the 1834)
                    <HelpTip of="tracker" />
                  </Box>
                }
              />
              {trackerInfo && <Typography variant="body2" color="text.secondary">{trackerInfo}</Typography>}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Shows the &ldquo;Additional relays&rdquo; choices on the Relays page. Saved for this page only, not sent to the gate.
            </Typography>
            {trackerError && <Alert severity="error">{trackerError}</Alert>}
          </Stack>

          <Stack spacing={1}>
            <Typography variant="body2" component="div" sx={{ fontWeight: 500, display: 'flex', alignItems: 'center' }}>
              Show on the page<HelpTip of="showOnPage" />
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Turn off what this gate doesn&apos;t use to hide it from the tables and forms. Nothing on the gate changes, and
              the stored values are kept.
            </Typography>
            <Stack direction="row" spacing={2.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <FormControlLabel
                sx={{ mr: 0 }}
                control={<Switch checked={features.floors} onChange={(_, checked) => toggle('floors', checked)} />}
                label="Floors (Residents Floor column and field, Security Levels Floors column)"
              />
              <FormControlLabel
                sx={{ mr: 0 }}
                control={<Switch checked={features.elevators} onChange={(_, checked) => toggle('elevators', checked)} />}
                label="Elevators (Residents Elevator column and field, Elevator Reference and Relay / Elevator pages)"
              />
              {featuresInfo && <Typography variant="body2" color="text.secondary">{featuresInfo}</Typography>}
            </Stack>
            {featuresError && <Alert severity="error">{featuresError}</Alert>}
          </Stack>

          {areaCodes.length > 0 && (
            <Typography variant="body2" color="text.secondary">
              Working copy has {areaCodes.length} area code{areaCodes.length === 1 ? '' : 's'}: {areaCodes.map((areaCode) => `${areaCode.code} (${areaCode.uses})`).join(', ')}.
              4-digit codes (1 + area code) are dialed as long distance.
            </Typography>
          )}

          <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label="Num of digits in dir code" help="dirDigits">
              <Choice value={digits} ariaLabel="Number of digits in directory code" onChange={setDigits} options={['1', '2', '3', '4']} />
            </Field>
            <Button variant="outlined" onClick={changeDigits} disabled={!list}>Change digits</Button>
            {digitsInfo && <Typography variant="body2" color="text.secondary">{digitsInfo}</Typography>}
          </Stack>
          {digitsError && <Alert severity="error">{digitsError}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
}
