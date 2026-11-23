import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Alert, Box, Stack, TextField, Typography } from '@mui/material';
import type { GateSettingRow } from '../../../src/types.ts';
import { errorText, useDraftActions, type GateApi } from '../api.ts';
import { ConflictList } from '../panes/WorkingCopyBar.tsx';
import { INVALID_BG, PENDING_BG, UNSAVED_BG } from './GroupPage.tsx';
import { gsShow, type GateSettings } from './useGateSettings.ts';

const HINTS: [string, string][] = [['holiday', 'MM/DD'], ['Tone', '1-9'], ['EntryCodeRange', '0000'], ['outsideLineDigit', '0-9']];

/**
 * Background of a setting: blue = unsaved edit, green = saved in the working copy but not sent to the gate.
 *
 * @param settings - Settings map or configuration.
 * @param setting - `GateSettingRow` value.
 * @returns Operation result.
 */
export function settingTone(settings: GateSettings, setting: GateSettingRow) {
  return setting.key in settings.edits ? UNSAVED_BG : setting.value !== setting.gate ? PENDING_BG : undefined;
}

/**
 * Setting title.
 *
 * @param settings - Settings map or configuration.
 * @param setting - `GateSettingRow` value.
 * @returns Operation result.
 */
export function settingTitle(settings: GateSettings, setting: GateSettingRow) {
  const edited = setting.key in settings.edits;
  const pending = setting.value !== setting.gate;
  return `${setting.name}\nGate (pulled): ${gsShow(setting.gate)}${pending ? `\nWorking copy (saved, not sent): ${gsShow(setting.value)}` : ''}`
    + `${edited ? `\nYour change (unsaved): ${gsShow(settings.edits[setting.key])}` : ''}`
    + `\nnames.bin offset 0x${setting.offset.toString(16)}${setting.editable ? '' : ' (read-only)'}`;
}

/**
 * Width in px that fits `max` of the widest character in the input's font as the browser draws it (its fonts, zoom and
 * minimum font size included), plus the input's text indent and border and a little room for the caret; null until
 * the input is on screen.
 */
const SPARE_PX = 28; // room past a full-length message so it never touches the edge or scrolls

function useFitWidth(input: RefObject<HTMLInputElement | null>, max: number | null) {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || !max) return;
    const cs = getComputedStyle(el);
    const probe = document.createElement('span');
    probe.textContent = 'W'.repeat(max);
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', fontFamily: cs.fontFamily,
      fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, letterSpacing: cs.letterSpacing });
    el.parentElement!.append(probe);
    const text = probe.getBoundingClientRect().width;
    probe.remove();
    const indent = parseFloat(cs.textIndent) || 0;
    const root = el.parentElement!.getBoundingClientRect().width - el.getBoundingClientRect().width;
    setWidth(Math.ceil(text + indent * 2 + root + SPARE_PX));
  }, [input, max]);
  return width;
}

interface SettingInputProps {
  settings: GateSettings;
  setting: GateSettingRow;
  invalid?: string;
}

/**
 * One input for a gate setting, coloured and with hover text as above. Text settings (display messages) are wide
 * enough for the most characters the gate accepts (in a fixed-width font, like the gate's LCD) and stop at it.
 * invalid: a reason the value can't be saved (red, shown visibly below the field and in the hover text).
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.setting - Setting.
 * @param props.invalid - Optional validation message blocking save (shown in red and tooltip).
 * @returns Rendered React element.
 */
export function SettingInput({ settings, setting, invalid }: SettingInputProps) {
  const max = setting.maxLength;
  const ref = useRef<HTMLInputElement>(null);
  const fit = useFitWidth(ref, max);
  const width = fit ? `${fit}px` : max ? `calc(${max}ch + 24px)`
    : setting.editable ? '9ch' : `calc(${Math.max(9, settings.current(setting).length)}ch + 24px)`;
  const bg = invalid ? INVALID_BG : settingTone(settings, setting);
  return (
    <TextField
      inputRef={ref}
      size="small"
      value={settings.current(setting)}
      error={Boolean(invalid)}
      helperText={invalid}
      title={invalid ? `${invalid}\n${settingTitle(settings, setting)}` : settingTitle(settings, setting)}
      placeholder={HINTS.find(([k]) => setting.key.includes(k))?.[1] || ''}
      className={max ? 'lcd-input' : undefined}
      slotProps={{
        htmlInput: {
          readOnly: !setting.editable,
          maxLength: max ?? undefined,
          'aria-label': setting.name,
          'aria-invalid': Boolean(invalid) || undefined,
        },
      }}
      sx={{
        width,
        minWidth: width,
        flexShrink: 0,
        opacity: setting.editable ? undefined : 0.7,
        '& .MuiInputBase-root': { backgroundColor: bg },
        '& .MuiInputBase-input': {
          py: 0.5,
          px: 1,
          fontSize: '0.85rem',
          ...(max ? { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } : {}),
        },
        '& .MuiFormHelperText-root': { mx: 0 },
      }}
      onChange={(event) => settings.edit(setting, event.target.value)}
    />
  );
}

/** The outcome of the bar's last action. */
interface Result { title: string; lines: string[]; color: 'blue' | 'red' }

interface SettingsBarProps {
  settings: GateSettings;
  gapi: GateApi;
  onReload: () => Promise<void> | void;
  blocked?: string;
}

/**
 * Save / Discard for the gate settings, the working copy's state and the result of the last action (Reset to gate and
 * Send to gate are in the sidebar's gate connection). blocked: why the edits can't be saved yet (Save is disabled).
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onReload - Callback to reload the gate data.
 * @param props.blocked - Optional reason preventing Save (disables the Save button).
 * @returns Rendered React element.
 */
export function SettingsBar({ settings, gapi, onReload, blocked }: SettingsBarProps) {
  const [result, setResult] = useState<Result | null>(null);
  const unsaved = Object.keys(settings.edits).length;
  const loaded = Boolean(settings.reply);

  const save = async () => {
    try {
      const saved = await settings.save();
      setResult({ title: `Saved to the working copy. Block(s) differing from the gate: ${saved.changedBlocks.join(', ') || 'none'}`,
        lines: saved.changed.map((change) => `${change.name}: "${change.from}" → "${change.to}"`), color: 'blue' });
    } catch (err) { setResult({ title: 'Save failed', lines: [errorText(err)], color: 'red' }); }
  };
  const discard = () => { settings.discard(); setResult(null); };
  useDraftActions(loaded ? { unsaved, blocked, save, discard } : null);

  const status = !loaded ? '' : [
    unsaved ? `${unsaved} unsaved change(s)` : 'No unsaved changes',
    settings.pending.length ? `${settings.pending.length} setting(s) saved, not sent (block(s) ${settings.blocks.join(', ')})` : '',
    `gate pulled ${new Date(settings.reply!.pulled).toLocaleString()}`,
    settings.pending.length ? `working copy saved ${new Date(settings.reply!.saved).toLocaleString()}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        Edits go to the working copy (use <strong>Gate → Save to working copy</strong> to keep changes).
      </Typography>
      {blocked && <Alert severity="error">{blocked}</Alert>}
      {!loaded && settings.error && <Alert severity="error">{settings.error}</Alert>}
      {status && <Typography variant="body2" color="text.secondary">{status}</Typography>}
      <ConflictList conflicts={settings.conflicts} gapi={gapi} onDecided={async () => { await settings.load(); await onReload(); }} />
      {result && (
        <Alert severity={result.color === 'red' ? 'error' : 'info'}>
          <Box component="strong">{result.title}</Box>
          {result.lines.length > 0 && (
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              {result.lines.map((line, i) => <li key={i}>{line}</li>)}
            </Box>
          )}
        </Alert>
      )}
    </Stack>
  );
}
