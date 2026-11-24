import { useMemo, useState } from 'react';
import {
  Button,
  Chip,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { usHolidaysForYear } from '../lib/shared.ts';
import type { GateSettingRow } from '../types.ts';
import type { GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { HelpTip } from '../HelpTip.tsx';
import { CLEAR_NOTE, GroupPage, rowState } from './GroupPage.tsx';
import { useGateSettings, type GateSettings } from './useGateSettings.ts';

type Holiday = { name: string; month: number; day: number };
const NONE = '__none__';
const CUSTOM = '__custom__';

interface HolidayRowProps {
  settings: GateSettings;
  setting: GateSettingRow;
  index: number;
  holidays: Holiday[];
}

function HolidayRow({ settings, setting, index, holidays }: HolidayRowProps) {
  const [custom, setCustom] = useState(false);
  const v = settings.current(setting).trim();
  const name = (monthDay: string) => {
    const [month, day] = monthDay.split('/').map(Number);
    return holidays.find((holiday) => holiday.month === month && holiday.day === day)?.name || '';
  };
  const known = v !== '' && Boolean(name(v));
  const row = rowState(settings, [setting], { pendingText: 'Not sent' });
  const dirty = setting.key in settings.edits;
  const pending = setting.value !== setting.gate;
  const pill = dirty
    ? { label: 'Unsaved', color: 'primary' as const }
    : pending
      ? { label: 'Not sent', color: 'success' as const }
      : v === ''
        ? { label: 'Unused', color: 'default' as const }
        : known
          ? { label: 'Active', color: 'success' as const }
          : { label: 'Custom', color: 'info' as const };

  return (
    <Paper
      variant="outlined"
      title={`Gate (pulled): ${setting.gate || '(none)'}${setting.value !== setting.gate ? `\nWorking copy: ${setting.value || '(none)'}` : ''}`
        + `${dirty ? `\nYour change: ${v || '(none)'}` : ''}`}
      sx={{
        px: 1.5,
        py: 1,
        width: '100%',
        boxSizing: 'border-box',
        backgroundColor: row.style.background || 'background.paper',
      }}
    >
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', width: '100%' }}>
        <Chip size="small" label={`#${index + 1}`} sx={{ flexShrink: 0, minWidth: 36, fontVariantNumeric: 'tabular-nums' }} />
        <Select
          size="small"
          value={custom || (v !== '' && !known) ? CUSTOM : v === '' ? NONE : v}
          inputProps={{ 'aria-label': `Holiday ${index + 1}` }}
          sx={{ flex: '1 1 auto', minWidth: 0, '& .MuiSelect-select': { py: 0.5, fontSize: '0.85rem' } }}
          onChange={(event) => {
            const sel = String(event.target.value);
            if (sel === CUSTOM) { setCustom(true); return; }
            setCustom(false);
            settings.edit(setting, sel === NONE ? '' : sel);
          }}
        >
          <MenuItem value={NONE}>— none —</MenuItem>
          {holidays.map((holiday) => <MenuItem key={holiday.name} value={`${holiday.month}/${holiday.day}`}>{holiday.name}</MenuItem>)}
          <MenuItem value={CUSTOM}>Custom date…</MenuItem>
        </Select>
        <TextField
          size="small"
          placeholder="M/D"
          value={settings.current(setting)}
          slotProps={{ htmlInput: { 'aria-label': `Holiday ${index + 1} date` } }}
          sx={{
            width: '7.5ch',
            flexShrink: 0,
            '& .MuiInputBase-input': { py: 0.5, px: 0.75, fontSize: '0.85rem', textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
          }}
          onChange={(event) => { setCustom(false); settings.edit(setting, event.target.value.trim()); }}
        />
        <Chip size="small" color={pill.color} label={pill.label} sx={{ minWidth: 68, flexShrink: 0 }} />
      </Stack>
    </Paper>
  );
}

export const HOL_FOR_SL = 'holidaysForSecurity';

interface HolidaysForSecurityProps {
  settings: GateSettings;
}

/**
 * The "Holidays for Security Levels" switch card. Turning it on asks first, as DoorKing32 does: TZ4 of every security
 * level becomes the Holiday time zone.
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
function HolidaysForSecurity({ settings }: HolidaysForSecurityProps) {
  const [dialog, confirm] = useConfirm();
  const field = settings.field(HOL_FOR_SL);
  if (!field) return null;
  const row = rowState(settings, [field], { pendingText: 'Not sent' });
  const cur = settings.current(field) === 'Yes';
  const dirty = field.key in settings.edits;
  const pending = field.value !== field.gate;
  const pill = dirty
    ? { label: 'Unsaved', color: 'primary' as const }
    : pending
      ? { label: 'Not sent', color: 'success' as const }
      : cur
        ? { label: 'Enabled', color: 'success' as const }
        : { label: 'Disabled', color: 'default' as const };
  const toggle = async (on: boolean) => {
    if (on && !await confirm({ title: 'Enable Holidays for Security Levels?', action: 'Enable',
      body: 'Time zone 4 (TZ4) of every security level becomes the Holiday schedule (HOL), and it overrides the other time zones of the level on holidays. Nothing is sent to the gate until you Send.' })) return;
    settings.edit(field, on ? 'Yes' : 'No');
  };
  return (
    <Paper variant="outlined" sx={{ px: 2, py: 1, width: '100%', boxSizing: 'border-box', backgroundColor: row.style.background || 'background.paper' }}>
      {dialog}
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
        <Typography variant="body2" component="div" sx={{ fontWeight: 600, flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center' }}>
          Holidays for Security Levels (TZ4 → HOL)<HelpTip of="holidaysForSecurity" />
        </Typography>
        <Switch checked={cur} onChange={(_, checked) => toggle(checked)} slotProps={{ input: { 'aria-label': 'Holidays for Security Levels' } }} />
        <Chip size="small" color={pill.color} label={pill.label} sx={{ minWidth: 74, flexShrink: 0 }} />
      </Stack>
    </Paper>
  );
}

interface HolidaysPageProps {
  gapi: GateApi;
  holidays: Holiday[];
}

/**
 * Holidays: pick from the US holiday list (fixed + floating for the selected year) or enter a date.
 * The gate stores only month/day.
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
export function HolidaysPage({ gapi }: HolidaysPageProps) {
  const settings = useGateSettings(gapi);
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const yearHolidays = useMemo(() => usHolidaysForYear(year), [year]);
  const holidayFields = settings.fields.filter((setting) => setting.group === 'Holidays' && setting.key !== HOL_FOR_SL);
  const fillYear = () => {
    holidayFields.forEach((setting, index) => {
      const holiday = yearHolidays[index];
      settings.edit(setting, holiday ? `${holiday.month}/${holiday.day}` : '');
    });
  };
  return (
    <GroupPage settings={settings} group="Holidays" title="Holidays" help="holidays" bare
      clearValue={(setting) => (setting.key === HOL_FOR_SL ? undefined : '')}
      buttons={(
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Select
            size="small"
            value={String(year)}
            inputProps={{ 'aria-label': 'Holiday year' }}
            onChange={(event) => setYear(Number(event.target.value))}
          >
            {[thisYear, thisYear + 1, thisYear + 2].map((optionYear) => (
              <MenuItem key={optionYear} value={String(optionYear)}>{optionYear}</MenuItem>
            ))}
          </Select>
          <Button variant="outlined" onClick={fillYear} disabled={!holidayFields.length}>Fill {year} US holidays</Button>
        </Stack>
      )}
      intro={`Pick a holiday from the ${year} list (fixed and floating US holidays) or enter a date. ${CLEAR_NOTE} Clear leaves Holidays for Security Levels as it is. Edits go to the working copy.`}>
      <Stack spacing={1} sx={{ width: '100%', maxWidth: 680 }}>
        <HolidaysForSecurity settings={settings} />
        {holidayFields.map((setting, index) => (
          <HolidayRow key={setting.key} settings={settings} setting={setting} index={index} holidays={yearHolidays} />
        ))}
      </Stack>
    </GroupPage>
  );
}

interface FacilityPageProps {
  gapi: GateApi;
}

/**
 * Facility Codes: the enable flag and up to 10 values (0-255; blank = unused).
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @returns Rendered React element.
 */
export function FacilityPage({ gapi }: FacilityPageProps) {
  const settings = useGateSettings(gapi);
  const fields = settings.fields.filter((setting) => setting.group === 'Facility Codes');
  return (
    <GroupPage settings={settings} group="Facility Codes" title="Facility Codes" help="facility" bare
      clearValue={(setting) => (setting.key === 'facilityEnabled' ? 'No' : '')}
      intro={`Enable facility codes and set up to 10 values (000–255; blank = unused). For MicroPLUS transmitters, leave off the leading 0 of the 4-digit facility code (0124 → 124). ${CLEAR_NOTE} Edits go to the working copy.`}>
      <Stack spacing={1} sx={{ width: '100%', maxWidth: 640 }}>
        {fields.map((setting) => {
          const row = rowState(settings, [setting], { pendingText: 'Not sent' });
          const cur = settings.current(setting);
          const dirty = setting.key in settings.edits;
          const pending = setting.value !== setting.gate;
          const isToggle = setting.key === 'facilityEnabled';
          const pill = dirty
            ? { label: 'Unsaved', color: 'primary' as const }
            : pending
              ? { label: 'Not sent', color: 'success' as const }
              : isToggle
                ? { label: cur === 'Yes' ? 'Enabled' : 'Disabled', color: cur === 'Yes' ? ('success' as const) : ('default' as const) }
                : cur
                  ? { label: 'Active', color: 'success' as const }
                  : { label: 'Unused', color: 'default' as const };
          return (
            <Paper
              key={setting.key}
              variant="outlined"
              sx={{
                px: 2,
                py: 1,
                width: '100%',
                boxSizing: 'border-box',
                backgroundColor: row.style.background || 'background.paper',
              }}
            >
              <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <Typography variant="body2" sx={{ fontWeight: 600, flex: '1 1 auto', minWidth: 0 }}>
                  {setting.name}
                </Typography>
                {isToggle ? (
                  <Switch
                    checked={cur === 'Yes'}
                    onChange={(_, checked) => settings.edit(setting, checked ? 'Yes' : 'No')}
                    slotProps={{ input: { 'aria-label': setting.name } }}
                  />
                ) : (
                  <TextField
                    size="small"
                    type="number"
                    placeholder="—"
                    value={cur}
                    slotProps={{ htmlInput: { min: 0, max: 255, inputMode: 'numeric', 'aria-label': setting.name } }}
                    sx={{
                      width: '8.5ch',
                      flexShrink: 0,
                      '& .MuiInputBase-input': { py: 0.5, px: 1, fontSize: '0.875rem', textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
                    }}
                    onChange={(event) => settings.edit(setting, event.target.value.trim())}
                  />
                )}
                <Chip
                  size="small"
                  color={pill.color}
                  label={pill.label}
                  sx={{ minWidth: 74, flexShrink: 0 }}
                />
              </Stack>
            </Paper>
          );
        })}
      </Stack>
    </GroupPage>
  );
}
