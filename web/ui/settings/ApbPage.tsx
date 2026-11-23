import type { ReactNode } from 'react';
import {
  Chip,
  FormControlLabel,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TableBody,
  TableCell,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { Choice } from '../panes/fields.tsx';
import type { GateSettingRow } from '../../../src/types.ts';
import type { GateApi } from '../api.ts';
import { HelpTip } from '../HelpTip.tsx';
import { usePhone } from '../phone.ts';
import { DAY_LETTERS, DAY_NAMES, GroupPage, Head, rowState, setBit, TimeBox, TogglePill } from './GroupPage.tsx';
import { useGateSettings, type GateSettings } from './useGateSettings.ts';

const MAX_RELAYS = 10;
/** Values Clear sets (every setting on the page back to unset). */
const CLEAR: Record<string, string> = {
  apbMode: 'Off', apbRelaysIn: '', apbRelaysOut: '', apbCounterEvery: 'Off', apbCounterReset: '', apbResyncAll: 'No',
  apbResyncList: '', apbScheduleEnabled: 'No', apbScheduleDays: '0000000', apbScheduleTime: '',
};
/** "?" tip of each row (a key in HELP). */
const ROW_HELP: Record<string, string> = {
  'True Anti Passback': 'apbMode', 'Relays In': 'apbRelays', 'Relays Out': 'apbRelays', 'Record Facility Counter Every': 'apbCounter',
  'Reset Facility Counter to': 'apbCounter', 'Re-Sync': 'apbResync', 'Enable Scheduled Re-Sync All': 'apbResync',
};

interface GateChoiceProps {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  ariaLabel?: string;
}

/**
 * The gate's own value stays in the list even when it isn't one of the usual ones.
 *
 * @param props - Component props.
 * @param props.value - Input value.
 * @param props.options - Optional settings.
 * @param props.onChange - Callback invoked when the value changes.
 * @param props.ariaLabel - Accessible label for the select control.
 * @returns Rendered React element.
 */
function GateChoice({ value, options, onChange, ariaLabel }: GateChoiceProps) {
  return <Choice size="1" value={value} ariaLabel={ariaLabel} options={options.includes(value) ? options : [...options, value]} onChange={onChange} />;
}

interface RelayPicksProps {
  settings: GateSettings;
  setting: GateSettingRow;
  name: (relay: number) => string;
  shown: number[];
}

/**
 * In/Out relays: checkboxes for the shown relays; hidden relays already set are kept. At most 10 in total.
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.setting - Setting.
 * @param props.name - Display name or filename.
 * @param props.shown - Shown.
 * @returns Rendered React element.
 */
function RelayPicks({ settings, setting, name, shown }: RelayPicksProps) {
  const on = new Set(settings.current(setting).split(',').filter(Boolean).map(Number));
  const set = (relay: number, picked: boolean) => {
    on.delete(relay);
    if (picked) on.add(relay);
    settings.edit(setting, [...on].sort((a, b) => a - b).join(','));
  };
  return (
    <Stack direction="row" spacing={0.75} useFlexGap sx={{ flexWrap: 'wrap' }}>
      {shown.map((relay) => {
        const active = on.has(relay);
        const label = name(relay);
        return (
          <TogglePill
            key={relay}
            label={label}
            ariaLabel={`Relay ${label}`}
            active={active}
            disabled={!active && on.size >= MAX_RELAYS}
            onToggle={(checked) => set(relay, checked)}
          />
        );
      })}
    </Stack>
  );
}

interface ResyncProps {
  settings: GateSettings;
  all: GateSettingRow;
  list: GateSettingRow;
}

/**
 * Re-Sync: none, all devices, or a list of up to 5 device numbers.
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.all - All.
 * @param props.list - List of input items.
 * @returns Rendered React element.
 */
function Resync({ settings, all, list }: ResyncProps) {
  const cur = settings.current(list);
  const mode = cur !== '' ? 'list' : settings.current(all) === 'Yes' ? 'all' : 'none';
  const slots = (cur || ',,,,').split(',');
  const setMode = (nextMode: string) => {
    settings.edit(all, nextMode === 'all' ? 'Yes' : 'No');
    settings.edit(list, nextMode === 'list' ? (cur || ',,,,') : '');
  };
  return (
    <Stack spacing={1}>
      <RadioGroup row value={mode} aria-label="Re-Sync mode" onChange={(_, val) => setMode(val)} sx={{ flexWrap: 'wrap' }}>
        <FormControlLabel value="none" control={<Radio size="small" />} label="None" />
        <FormControlLabel value="all" control={<Radio size="small" />} label="Re-Sync All Devices" />
        <FormControlLabel value="list" control={<Radio size="small" />} label="Enable Re-Sync List" />
      </RadioGroup>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {Array.from({ length: 5 }, (_, i) => (
          <TextField
            key={i}
            size="small"
            type="number"
            disabled={mode !== 'list'}
            value={slots[i] ?? ''}
            slotProps={{ htmlInput: { min: 1, max: 65535, 'aria-label': `Re-Sync device ${i + 1}` } }}
            sx={{ width: '9ch', '& .MuiInputBase-input': { py: 0.5, px: 1, fontSize: '0.85rem' } }}
            onChange={(event) => {
              const next = Array.from({ length: 5 }, (__, j) => slots[j] ?? '');
              next[i] = event.target.value.trim();
              settings.edit(list, next.join(','));
            }}
          />
        ))}
      </Stack>
    </Stack>
  );
}

interface ApbPageProps {
  gapi: GateApi;
  relayLabels: Record<string, string | undefined>;
  relays: number[];
}

/**
 * Anti-Pass Back (names.bin block 20): mode, In/Out relays, facility counter, one-time re-sync and the scheduled
 * Re-Sync All. shown: relays 0-2 plus the Tracker relays.
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.relayLabels - Relay labels.
 * @param props.relays - Relays.
 * @returns Rendered React element.
 */
export function ApbPage({ gapi, relayLabels, relays: shown }: ApbPageProps) {
  const settings = useGateSettings(gapi);
  const phone = usePhone();
  const field = (key: string) => settings.field(key);
  const name = (relay: number) => (relayLabels[relay] && relayLabels[relay] !== `Relay ${relay}` ? relayLabels[relay]! : String(relay));
  const rows: [string, (GateSettingRow | undefined)[], (fs: GateSettingRow[]) => ReactNode, boolean?][] = [
    ['True Anti Passback', [field('apbMode')], ([setting]) => (
      <GateChoice value={settings.current(setting)} ariaLabel="True Anti Passback" options={['Off', 'Passive', 'Active', 'Trap']} onChange={(value) => settings.edit(setting, value)} />
    ), true],
    ['Relays In', [field('apbRelaysIn')], ([setting]) => <RelayPicks settings={settings} setting={setting} name={name} shown={shown} />],
    ['Relays Out', [field('apbRelaysOut')], ([setting]) => <RelayPicks settings={settings} setting={setting} name={name} shown={shown} />],
    ['Record Facility Counter Every', [field('apbCounterEvery')], ([setting]) => (
      <GateChoice value={settings.current(setting)} ariaLabel="Record Facility Counter Every" options={['Off', '15 Mins', '30 Mins', 'Hour']} onChange={(value) => settings.edit(setting, value)} />
    ), true],
    ['Reset Facility Counter to', [field('apbCounterReset')], ([setting]) => (
      <TextField
        size="small"
        type="number"
        value={settings.current(setting)}
        slotProps={{ htmlInput: { min: 0, max: 65535, 'aria-label': 'Reset Facility Counter to' } }}
        sx={{ width: '10ch', '& .MuiInputBase-input': { py: 0.5, px: 1, fontSize: '0.85rem' } }}
        onChange={(event) => settings.edit(setting, event.target.value.trim())}
      />
    ), true],
    ['Re-Sync', [field('apbResyncAll'), field('apbResyncList')], ([a, setting]) => <Resync settings={settings} all={a} list={setting} />],
    ['Enable Scheduled Re-Sync All', [field('apbScheduleEnabled')], ([setting]) => (
      <Switch
        size="small"
        checked={settings.current(setting) === 'Yes'}
        slotProps={{ input: { 'aria-label': 'Enable Scheduled Re-Sync All' } }}
        onChange={(_, on) => settings.edit(setting, on ? 'Yes' : 'No')}
      />
    ), true],
    ['Scheduled Re-Sync All days', [field('apbScheduleDays')], ([setting]) => (
      <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {DAY_LETTERS.map((letter, i) => (
          <TogglePill
            key={i}
            label={letter}
            ariaLabel={DAY_NAMES[i]}
            active={settings.current(setting)[i] === '1'}
            onToggle={(on) => settings.edit(setting, setBit(settings.current(setting), i, on))}
          />
        ))}
      </Stack>
    )],
    ['Scheduled Re-Sync All time', [field('apbScheduleTime')], ([setting]) => (
      <TimeBox value={settings.current(setting)} ariaLabel="Scheduled Re-Sync All time" onChange={(value) => settings.edit(setting, value)} />
    ), true],
  ];
  const intro = 'Set the anti-pass back mode, In/Out relays (up to 10 each), facility counter, one-time re-sync functions and the scheduled Re-Sync All. Anti-pass back applies only to cards in security levels 02–27; levels 01, 28, 29 and 30 are never limited by it. Clear sets every setting on this page back to unset. Edits go to the working copy (blue = unsaved, green = saved but not sent to the gate).';
  if (phone) {
    return (
      <GroupPage settings={settings} group="Anti-Pass Back" title="Anti-Pass Back" help="apb" bare clearValue={(setting) => CLEAR[setting.key]} intro={intro}>
        <Stack spacing={1} sx={{ width: '100%' }}>
          {rows.map(([label, fs, build, inline]) => {
            if (fs.some((setting) => !setting)) return null;
            const row = rowState(settings, fs, { pendingText: 'Not sent' });
            const statusColor = row.status === 'unsaved' ? 'primary' : row.status ? 'success' : undefined;
            return (
              <Paper
                key={label}
                elevation={0}
                sx={{
                  px: 1.5,
                  py: 1,
                  borderRadius: 2,
                  bgcolor: row.style.background || 'action.hover',
                }}
              >
                {inline ? (
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                    <Typography variant="body2" sx={{ fontWeight: 500, display: 'flex', alignItems: 'center', minWidth: 0 }}>
                      <span>{label}</span>
                      {ROW_HELP[label] && <HelpTip of={ROW_HELP[label]} />}
                    </Typography>
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexShrink: 0 }}>
                      {row.status && <Chip size="small" color={statusColor} label={row.status === 'unsaved' ? 'Unsaved' : row.status} />}
                      {build(fs as GateSettingRow[])}
                    </Stack>
                  </Stack>
                ) : (
                  <Stack spacing={0.75}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                      <Typography variant="body2" sx={{ fontWeight: 500, display: 'flex', alignItems: 'center' }}>
                        {label}{ROW_HELP[label] && <HelpTip of={ROW_HELP[label]} />}
                      </Typography>
                      {row.status && <Chip size="small" color={statusColor} label={row.status === 'unsaved' ? 'Unsaved' : row.status} />}
                    </Stack>
                    {build(fs as GateSettingRow[])}
                  </Stack>
                )}
              </Paper>
            );
          })}
        </Stack>
      </GroupPage>
    );
  }
  return (
    <GroupPage settings={settings} group="Anti-Pass Back" title="Anti-Pass Back" help="apb" clearValue={(setting) => CLEAR[setting.key]} intro={intro}>
      <Head cols={['Setting', 'Value', 'Status']} />
      <TableBody>
        {rows.map(([label, fs, build]) => {
          if (fs.some((setting) => !setting)) return null;
          const row = rowState(settings, fs, { pendingText: 'saved, not sent' });
          return (
            <TableRow key={label} sx={{ backgroundColor: row.style.background }}>
              <TableCell>{label}{ROW_HELP[label] && <HelpTip of={ROW_HELP[label]} />}</TableCell>
              <TableCell>{build(fs as GateSettingRow[])}</TableCell>
              <TableCell><Typography variant="caption" color="text.secondary">{row.status}</Typography></TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </GroupPage>
  );
}
