import { useState, type ReactNode } from 'react';
import {
  Alert,
  Box as MuiBox,
  Button,
  ButtonBase,
  Checkbox,
  Chip,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Table,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { GateSettingRow } from '../types.ts';
import { errorText, useDraftActions } from '../api.ts';
import { HelpTip } from '../HelpTip.tsx';
import { usePhone } from '../phone.ts';
import type { GateSettings } from './useGateSettings.ts';

export const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const CLEAR_NOTE = 'Clear sets every setting on this page back to unset.'; // the gate stores relays 0-18; values for the others are kept unchanged

export const UNSAVED_BG = 'rgba(33, 150, 243, 0.16)';
export const PENDING_BG = 'rgba(76, 175, 80, 0.16)';
export const INVALID_BG = 'rgba(244, 67, 54, 0.18)';

/**
 * How rowState judges a row: edited / pending override what the fields say (rows that also show relay columns);
 * pendingText is the status of a saved, unsent row.
 */
interface RowStateOptions { edited?: boolean; pending?: boolean; pendingText?: string }

/**
 * Row colour and status of a group of settings: blue = unsaved edit, green = saved but not sent to the gate.
 *
 * @param settings - Settings map or configuration.
 * @param fields - Field names or field updates.
 * @param [options] - Options object.
 * @param [options.edited] - Edited.
 * @param [options.pending] - Pending.
 * @param [options.pendingText] - Pending text.
 * @returns Operation result.
 */
export function rowState(settings: GateSettings, fields: (GateSettingRow | undefined)[], { edited, pending, pendingText = 'not sent' }: RowStateOptions = {}) {
  const list = fields.filter((field): field is GateSettingRow => Boolean(field));
  const isEdited = edited ?? list.some((setting) => setting.key in settings.edits);
  const isPending = !isEdited && (pending ?? list.some((setting) => setting.value !== setting.gate));
  return { style: { background: isEdited ? UNSAVED_BG : isPending ? PENDING_BG : undefined }, status: isEdited ? 'unsaved' : isPending ? pendingText : '' };
}

interface BoxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  help?: string;
  ariaLabel?: string;
}

/**
 * A checkbox, with an optional label and "?" tip (help: a key in HELP).
 *
 * @param props - Component props.
 * @param props.checked - Checked.
 * @param props.onChange - Callback invoked when the value changes.
 * @param props.disabled - Whether the control is disabled.
 * @param props.label - Display label.
 * @param props.help - A key in HELP.
 * @param props.ariaLabel - Accessible label when rendered without visible text or with a short letter label.
 * @returns Operation result.
 */
export function Box({ checked, onChange, disabled, label, help, ariaLabel }: BoxProps) {
  const box = (
    <Checkbox
      size="small"
      checked={checked}
      disabled={disabled}
      onChange={(_, isChecked) => onChange(isChecked)}
      slotProps={ariaLabel ? { input: { 'aria-label': ariaLabel } } : undefined}
      sx={label ? undefined : { p: 0.5 }}
    />
  );
  if (!label) return box;
  return (
    <FormControlLabel
      sx={{ mr: 0 }}
      control={box}
      label={
        <MuiBox component="span" sx={{ display: 'inline-flex', alignItems: 'center', fontSize: '0.875rem' }}>
          {label}
          {help && <HelpTip of={help} />}
        </MuiBox>
      }
    />
  );
}

interface TogglePillProps {
  label: string;
  active: boolean;
  ariaLabel: string;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
}

/** Compact clickable toggle pill used for day-of-week and relay bitmasks on schedule and APB cards. */
export function TogglePill({ label, active, ariaLabel, disabled = false, onToggle }: TogglePillProps) {
  return (
    <Chip
      size="small"
      clickable={!disabled}
      disabled={disabled}
      role="checkbox"
      aria-checked={active}
      aria-label={ariaLabel}
      label={label}
      color={active ? 'primary' : 'default'}
      variant={active ? 'filled' : 'outlined'}
      onClick={disabled ? undefined : () => onToggle(!active)}
      sx={{
        minWidth: 30,
        height: 26,
        fontWeight: active ? 700 : 500,
        '& .MuiChip-label': { px: 0.75 },
      }}
    />
  );
}

/** Compact single-row 7-day toggle grid matching Android's `WeekdayToggleRow` (never wraps Saturday). */
export function WeekdayRow({
  bits,
  labelPrefix,
  disabled = false,
  onToggle,
}: {
  bits: string;
  labelPrefix: string;
  disabled?: boolean;
  onToggle: (dayIndex: number, next: boolean) => void;
}) {
  return (
    <MuiBox
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
        gap: '4px',
        width: '100%',
      }}
    >
      {DAY_LETTERS.map((letter, day) => {
        const active = bits[day] === '1';
        return (
          <ButtonBase
            key={day}
            type="button"
            disabled={disabled}
            role="checkbox"
            aria-checked={active}
            aria-label={`${labelPrefix} ${DAY_NAMES[day]}`}
            onClick={() => onToggle(day, !active)}
            sx={{
              height: 36,
              borderRadius: '10px',
              fontSize: '0.75rem',
              fontWeight: active ? 700 : 500,
              bgcolor: active ? 'var(--md-primary-container)' : 'var(--md-surface-highest)',
              color: active ? 'var(--md-on-primary-container)' : 'text.secondary',
              transition: 'background-color 140ms ease, color 140ms ease',
            }}
          >
            {letter}
          </ButtonBase>
        );
      })}
    </MuiBox>
  );
}

interface TimeBoxProps {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
  fullWidth?: boolean;
}

/**
 * Native time input (displays 12-hour AM/PM in US locales while storing 24-hour "HH:MM" for the gate).
 * Supports optional floating label + clear button when used on Board Settings cards.
 */
export function TimeBox({ label, value, onChange, ariaLabel, fullWidth = false }: TimeBoxProps) {
  if (!fullWidth && !label) {
    return (
      <input
        type="time"
        className="time-input"
        aria-label={ariaLabel}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <MuiBox
      sx={{
        position: 'relative',
        flex: fullWidth ? 1 : undefined,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        border: '1px solid var(--md-outline)',
        borderRadius: '12px',
        bgcolor: 'transparent',
        px: 1.5,
        height: 48,
      }}
    >
      {label && (
        <Typography
          component="span"
          sx={{
            position: 'absolute',
            top: -8,
            left: 10,
            px: 0.5,
            fontSize: '0.7rem',
            lineHeight: 1.2,
            color: 'text.secondary',
            bgcolor: 'var(--md-surface-low)',
          }}
        >
          {label}
        </Typography>
      )}
      <input
        type="time"
        aria-label={ariaLabel || label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: '0.875rem',
          width: '100%',
          minWidth: 0,
          fontVariantNumeric: 'tabular-nums',
        }}
      />
      {value && (
        <IconButton
          size="small"
          aria-label={`Clear ${label || 'time'}`}
          onClick={() => onChange('')}
          sx={{ p: 0.25, ml: 0.25, color: 'text.secondary' }}
        >
          <CloseIcon sx={{ fontSize: 16 }} />
        </IconButton>
      )}
    </MuiBox>
  );
}

/**
 * A string of '0'/'1' flags with position i set to on.
 *
 * @param bits - `string` value.
 * @param i - `number` value.
 * @param on - `boolean` value.
 * @returns Operation result.
 */
export const setBit = (bits: string, i: number, on: boolean) => {
  const flags = [...bits.padEnd(i + 1, '0')];
  flags[i] = on ? '1' : '0';
  return flags.join('');
};

interface GroupPageProps {
  title: string;
  intro: ReactNode;
  settings: GateSettings;
  group: string;
  buttons?: ReactNode;
  /** Optional control placed to the left of the red Clear button in the title row (e.g. Facility Codes switch). */
  headerRight?: ReactNode;
  clearValue?: (setting: GateSettingRow) => string | undefined;
  help?: string;
  /** When true, renders `children` directly instead of wrapping in a `<TableContainer><Table>`. */
  bare?: boolean;
  children: ReactNode;
}

export function GroupPage({ title, intro, settings, group, buttons, headerRight, clearValue, help, bare = false, children }: GroupPageProps) {
  const phone = usePhone();
  const [saved, setSaved] = useState('');
  const [saveError, setSaveError] = useState('');
  const fields = settings.fields.filter((setting) => setting.group === group);
  const unsaved = Object.keys(settings.edits).length;
  const pending = fields.filter((setting) => setting.value !== setting.gate).length;
  const save = async () => {
    setSaveError('');
    try {
      const result = await settings.save();
      setSaved(`Saved to working copy. Changed block(s): ${result.changedBlocks.join(', ') || 'none'}`);
    } catch (err) {
      setSaved('');
      setSaveError(`Save failed: ${errorText(err)}`);
    }
  };
  const discard = () => { settings.discard(); setSaved(''); setSaveError(''); };
  useDraftActions({ unsaved, save, discard });
  const canClear = Boolean(clearValue) && fields.some((setting) => {
    const v = clearValue!(setting);
    return v !== undefined && settings.current(setting) !== v;
  });
  const info = !settings.reply ? '' : saved && !unsaved ? saved
    : [unsaved ? `${unsaved} unsaved change(s)` : '', pending ? `${pending} saved, not sent` : ''].filter(Boolean).join(' · ');
  return (
    <Stack spacing={phone ? 1.25 : 2}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            component="h1"
            sx={{
              display: 'flex',
              alignItems: 'center',
              minWidth: 0,
              fontSize: phone ? '1.375rem' : '1.5rem',
              lineHeight: 1.25,
              fontWeight: phone ? 500 : 700,
            }}
          >
            {title}{help && <HelpTip of={help} />}
          </Typography>
          {phone && unsaved > 0 && (
            <Typography variant="caption" color="primary">
              {unsaved} unsaved change(s) — tap Gate tab to Save or Discard.
            </Typography>
          )}
        </Stack>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexShrink: 0 }}>
          {headerRight}
          {clearValue && (
            <Button
              size="small"
              variant="contained"
              color="error"
              disabled={!canClear}
              sx={{ flexShrink: 0, minHeight: 36, px: 2, borderRadius: '999px' }}
              onClick={() => {
                for (const setting of fields) { const v = clearValue(setting); if (v !== undefined) settings.edit(setting, v); }
                setSaved('');
                setSaveError('');
              }}
            >
              Clear
            </Button>
          )}
        </Stack>
      </Stack>
      {!phone && <Typography variant="body2" color="text.secondary">{intro}</Typography>}
      {(buttons || (!phone && info)) && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          {buttons}
          {!phone && info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
        </Stack>
      )}
      {!settings.reply && settings.error && <Alert severity="error">{settings.error}</Alert>}
      {saveError && <Alert severity="error">{saveError}</Alert>}
      {settings.reply && fields.length > 0 && (bare ? children : (
        <TableContainer component={Paper} variant="outlined" sx={{ width: 'fit-content', maxWidth: '100%' }}>
          <Table size="small">{children}</Table>
        </TableContainer>
      ))}
    </Stack>
  );
}

interface HeadProps {
  cols: string[];
}

/**
 * Header row of plain column labels.
 *
 * @param props - Component props.
 * @param props.cols - Table column definitions.
 * @returns Rendered React element.
 */
export function Head({ cols }: HeadProps) {
  return (
    <TableHead>
      <TableRow>{cols.map((column, i) => <TableCell key={i}>{column}</TableCell>)}</TableRow>
    </TableHead>
  );
}
