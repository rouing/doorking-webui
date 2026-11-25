import { useState } from 'react';
import { Chip, MenuItem, Paper, Select, Stack, TableBody, TableCell, TableRow, TextField, Typography } from '@mui/material';
import type { GatePrefs, GateSettingRow } from '../types.ts';
import type { GateApi } from '../api.ts';
import { trackerOf, trackerRelays } from '../format.ts';
import { MobileFilterChip } from '../panes/MobilePrimitives.tsx';
import { Box, CLEAR_NOTE, GroupPage, Head, rowState, setBit, TimeBox, WeekdayRow } from './GroupPage.tsx';
import { useGateSettings } from './useGateSettings.ts';
import { HOL_FOR_SL } from './ListPages.tsx';

const EDITS_NOTE = 'Edits go to the working copy (use Gate → Save to working copy).';

/**
 * The shown relays as ranges, e.g. "0–2" or "0–10".
 *
 * @param relays - `number[]` value.
 * @returns Computed result.
 */
const relayRanges = (relays: number[]) => relays.reduce<number[][]>((ranges, relay) => {
  const last = ranges[ranges.length - 1];
  if (last && relay === last[1] + 1) {
    last[1] = relay;
    return ranges;
  }
  ranges.push([relay, relay]);
  return ranges;
}, []).map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ');

/**
 * Hold Open unset: no times, no days, and the shown relays off for every row (hidden relays stay as they are).
 *
 * @param shown - `number[]` value.
 * @returns Rendered React element.
 */
const holdOpenClear = (shown: number[]) => (setting: GateSettingRow) => {
  if (setting.key.endsWith('Begin') || setting.key.endsWith('End')) return '';
  if (setting.key.endsWith('Days')) return '';
  const relay = /^holdOpenRelay(\d+)$/.exec(setting.key);
  return relay && shown.includes(Number(relay[1])) ? '00000000' : undefined;
};

interface HoldOpenPageProps {
  gapi: GateApi;
  relays: number[];
  relayLabels?: Record<string, string | undefined>;
}

const relayName = (relayLabels: Record<string, string | undefined> | undefined, relay: number) =>
  relayLabels?.[String(relay)]?.trim() || `Relay ${relay}`;

/**
 * Hold Open: begin/end times and days per row (7 rows + Holiday), and which relays each row holds open. The relay
 * columns are stored per relay as one flag per row. shown: relays 0-2 plus the Tracker relays.
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.relays - Relays.
 * @param [props.relayLabels] - Configured relay labels.
 * @returns Rendered React element.
 */
export function HoldOpenPage({ gapi, relays: shown, relayLabels }: HoldOpenPageProps) {
  const settings = useGateSettings(gapi);
  const field = (label: string, part: string) => settings.field(`holdOpen${label}${part}`);
  const relays = shown.map((relay) => field('Relay', String(relay)));
  return (
    <GroupPage settings={settings} group="Hold Open" title="Hold Open" help="holdOpen" bare clearValue={holdOpenClear(shown)}
      intro={`Set begin/end times and days for each schedule row (7 rows + the Holiday row), and which relays (${relayRanges(shown)}) it holds open. Leave a row's times blank to disable it. ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 680 }}>
        {['1', '2', '3', '4', '5', '6', '7', 'Hol'].map((label, rowIndex) => {
          const begin = field(label, 'Begin'); const end = field(label, 'End'); const days = field(label, 'Days');
          if (!begin || !end || !days) return null;
          const relayEdited = relays.some((relay) => relay && settings.current(relay)[rowIndex] !== relay.value[rowIndex]);
          const relayPending = relays.some((relay) => relay && relay.value[rowIndex] !== relay.gate[rowIndex]);
          const own = [begin, end, days];
          const edited = own.some((setting) => setting.key in settings.edits) || relayEdited;
          const pending = own.some((setting) => setting.value !== setting.gate) || relayPending;
          const row = rowState(settings, own, { edited, pending, pendingText: 'Not sent' });
          const curBegin = settings.current(begin);
          const curEnd = settings.current(end);
          const curDays = settings.current(days);
          const active = Boolean(curBegin || curEnd);
          const pill = edited
            ? { label: 'Unsaved', color: 'primary' as const }
            : pending
              ? { label: 'Not sent', color: 'success' as const }
              : active
                ? { label: 'Active', color: 'success' as const }
                : { label: 'Unused', color: 'default' as const };
          return (
            <Paper
              key={label}
              elevation={0}
              sx={{
                p: 2,
                borderRadius: '12px',
                width: '100%',
                boxSizing: 'border-box',
                bgcolor: row.style.background || 'var(--md-surface-low)',
              }}
            >
              <Stack spacing={1.25}>
                <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <Chip size="small" color={active ? 'primary' : 'default'} label={label === 'Hol' ? 'HOL' : `Row #${label}`} sx={{ height: 26 }} />
                  <Chip size="small" color={pill.color} label={pill.label} sx={{ height: 26 }} />
                </Stack>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <TimeBox label="Start" fullWidth value={curBegin} ariaLabel={`Row ${label} start time`} onChange={(value) => settings.edit(begin, value)} />
                  <TimeBox label="End" fullWidth value={curEnd} ariaLabel={`Row ${label} end time`} onChange={(value) => settings.edit(end, value)} />
                </Stack>
                <WeekdayRow
                  bits={curDays}
                  labelPrefix={`Row ${label}`}
                  onToggle={(day, on) => settings.edit(days, setBit(curDays, day, on))}
                />
                <Stack direction="row" sx={{ gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, mr: 0.25 }}>Relays</Typography>
                  {relays.map((relay, i) => relay && (
                    <MobileFilterChip
                      key={i}
                      label={relayName(relayLabels, shown[i])}
                      selected={settings.current(relay)[rowIndex] === '1'}
                      showCheck
                      onClick={() => settings.edit(relay, setBit(settings.current(relay), rowIndex, settings.current(relay)[rowIndex] !== '1'))}
                    />
                  ))}
                </Stack>
              </Stack>
            </Paper>
          );
        })}
      </Stack>
    </GroupPage>
  );
}

interface ElevatorPageProps {
  gapi: GateApi;
}

/**
 * Elevator Reference table (DoorKing manual 4.3): for each of the 8 references (ER1-ER8), which elevators (1-8) a
 * visitor may use and how long the resident's floor button stays active, in seconds. A resident's Elevator
 * reference picks the row.
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @returns Rendered React element.
 */
export function ElevatorPage({ gapi }: ElevatorPageProps) {
  const settings = useGateSettings(gapi);
  return (
    <GroupPage settings={settings} group="Elevator" title="Elevator Reference" help="elevatorReference" clearValue={(setting) => (setting.key.endsWith('Elevators') ? '00000000' : '')}
      intro={`When a resident lets a visitor in, the visitor can use only the elevators checked in the resident's Elevator reference row, and only the resident's floor button works, for the time set here (seconds, counted once the elevator reaches the ground floor). ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Head cols={['Reference', ...Array.from({ length: 8 }, (_, elevator) => String(elevator + 1)), 'Floor button (s)', 'Status']} />
      <TableBody>
        {Array.from({ length: 8 }, (_, i) => i + 1).map((reference) => {
          const elevs = settings.field(`elevator${reference}Elevators`); const time = settings.field(`elevator${reference}Time`);
          if (!elevs || !time) return null;
          const row = rowState(settings, [elevs, time]);
          return (
            <TableRow key={reference} sx={{ backgroundColor: row.style.background }}>
              <TableCell component="th" scope="row">ER{reference}</TableCell>
              {Array.from({ length: 8 }, (_, elevator) => (
                <TableCell key={elevator}>
                  <Box
                    checked={settings.current(elevs)[elevator] === '1'}
                    ariaLabel={`ER${reference} elevator ${elevator + 1}`}
                    onChange={(on) => settings.edit(elevs, setBit(settings.current(elevs), elevator, on))}
                  />
                </TableCell>
              ))}
              <TableCell>
                <TextField
                  size="small"
                  type="number"
                  value={settings.current(time)}
                  slotProps={{ htmlInput: { min: 0, max: 254, 'aria-label': `ER${reference} floor button seconds` } }}
                  sx={{ width: '9ch', '& .MuiInputBase-input': { py: 0.5, px: 1, fontSize: '0.85rem' } }}
                  onChange={(event) => settings.edit(time, event.target.value.trim())}
                />
              </TableCell>
              <TableCell><Typography variant="caption" color="text.secondary">{row.status}</Typography></TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </GroupPage>
  );
}

interface RelayElevatorPageProps {
  gapi: GateApi;
  prefs: GatePrefs;
}

/**
 * Relay / Elevator table: which elevators (1-8) each relay controls. Relays 0-2, plus 3-10 / 11-18 with the Tracker
 * boxes; hidden relays are left as they are.
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.prefs - Gate-scoped preferences object.
 * @returns Rendered React element.
 */
export function RelayElevatorPage({ gapi, prefs }: RelayElevatorPageProps) {
  const settings = useGateSettings(gapi);
  const relays = trackerRelays(trackerOf(prefs));
  const label = (relay: number) => prefs.relayLabels?.[String(relay)];
  return (
    <GroupPage settings={settings} group="Relay Elevator" title="Relay / Elevator" help="relayElevator"
      clearValue={(setting) => (relays.includes(Number(/^relay(\d+)Elevators$/.exec(setting.key)?.[1])) ? '00000000' : undefined)}
      intro={`Check which elevators (1–8) each relay controls. Relays 3–18 show when their Tracker box is ticked on the Relays page. ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Head cols={['Relay', ...Array.from({ length: 8 }, (_, elevator) => String(elevator + 1)), 'Status']} />
      <TableBody>
        {relays.map((relay) => {
          const elevs = settings.field(`relay${relay}Elevators`);
          if (!elevs) return null;
          const row = rowState(settings, [elevs]);
          return (
            <TableRow key={relay} sx={{ backgroundColor: row.style.background }}>
              <TableCell component="th" scope="row">{`Relay ${relay}${label(relay) && label(relay) !== `Relay ${relay}` ? ` (${label(relay)})` : ''}`}</TableCell>
              {Array.from({ length: 8 }, (_, elevator) => (
                <TableCell key={elevator}>
                  <Box
                    checked={settings.current(elevs)[elevator] === '1'}
                    ariaLabel={`Relay ${relay} elevator ${elevator + 1}`}
                    onChange={(on) => settings.edit(elevs, setBit(settings.current(elevs), elevator, on))}
                  />
                </TableCell>
              ))}
              <TableCell><Typography variant="caption" color="text.secondary">{row.status}</Typography></TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </GroupPage>
  );
}

interface SecurityPageProps {
  gapi: GateApi;
  floors: boolean;
  relays: number[];
  relayLabels?: Record<string, string | undefined>;
}

/**
 * Security Levels: per level (02-30), each of its 4 time zones' begin/end times, days, relays and floors (the
 * Floors column only when the gate's Floors feature is on). With Holidays for Security Levels on (working copy),
 * TZ4 is the Holiday time zone and shows as HOL, as in DoorKing32. shown: relays 0-2 plus the Tracker relays.
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.floors - Floors.
 * @param props.relays - Relays.
 * @param [props.relayLabels] - Configured relay labels.
 * @returns Rendered React element.
 */
export function SecurityPage({ gapi, floors: showFloors, relays: shown, relayLabels }: SecurityPageProps) {
  const settings = useGateSettings(gapi);
  const hol = settings.field(HOL_FOR_SL)?.value === 'Yes';
  const levels = [...new Set(settings.fields.filter((setting) => setting.group === 'Security').map((setting) => Number(/^sec(\d+)tz/.exec(setting.key)![1])))].sort((a, b) => a - b);
  const [picked, setPicked] = useState(2);
  const level = levels.includes(picked) ? picked : levels[0];
  const field = (tz: number, part: string) => settings.field(`sec${level}tz${tz}${part}`);
  const activeCountForLevel = (lvl: number) => [1, 2, 3, 4].filter((tz) => {
    const b = settings.field(`sec${lvl}tz${tz}Begin`);
    const e = settings.field(`sec${lvl}tz${tz}End`);
    return Boolean((b && settings.current(b)) || (e && settings.current(e)));
  }).length;
  const levelLabel = (lvl: number) => {
    const active = activeCountForLevel(lvl);
    const num = String(lvl).padStart(2, '0');
    return active > 0 ? `Level ${num} · ${active} active` : `Level ${num}`;
  };
  const picker = levels.length > 0 && (
    <Select
      size="small"
      fullWidth
      value={String(level)}
      inputProps={{ 'aria-label': 'Security level' }}
      onChange={(event) => setPicked(Number(event.target.value))}
      sx={{ maxWidth: 680, borderRadius: '12px' }}
    >
      {levels.map((lvl) => (
        <MenuItem key={lvl} value={String(lvl)}>{levelLabel(lvl)}</MenuItem>
      ))}
    </Select>
  );
  return (
    <GroupPage settings={settings} group="Security" title="Security Levels" help="security" bare buttons={picker}
      intro={`Pick a level (02–30) and edit each of its 4 time zones: begin/end times, days, ${showFloors
        ? `relays (${relayRanges(shown)}) and floors (comma-separated, 1–64)` : `and relays (${relayRanges(shown)})`}. ${hol
        ? 'Holidays for Security Levels is on (Holidays page), so TZ4 is the Holiday time zone (HOL): on a holiday it overrides the other time zones of the level. '
        : ''}${EDITS_NOTE}`}>
      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 680 }}>
        {[1, 2, 3, 4].map((tz) => {
          const begin = field(tz, 'Begin'); const end = field(tz, 'End'); const days = field(tz, 'Days'); const relays = field(tz, 'Relays'); const floors = field(tz, 'Floors');
          if (!begin || !end || !days || !relays || !floors) return null;
          const tzFields = [begin, end, days, relays, floors];
          const edited = tzFields.some((setting) => setting.key in settings.edits);
          const pending = tzFields.some((setting) => setting.value !== setting.gate);
          const row = rowState(settings, tzFields, { edited, pending, pendingText: 'Not sent' });
          const tzLabel = tz === 4 && hol ? 'HOL' : `TZ${tz}`;
          const curBegin = settings.current(begin);
          const curEnd = settings.current(end);
          const curDays = settings.current(days);
          const curRelays = settings.current(relays);
          const active = Boolean(curBegin || curEnd);
          const pill = edited
            ? { label: 'Unsaved', color: 'primary' as const }
            : pending
              ? { label: 'Not sent', color: 'success' as const }
              : active
                ? { label: 'Active', color: 'success' as const }
                : { label: 'Unused', color: 'default' as const };
          return (
            <Paper
              key={tz}
              elevation={0}
              sx={{
                p: 2,
                borderRadius: '12px',
                width: '100%',
                boxSizing: 'border-box',
                bgcolor: row.style.background || 'var(--md-surface-low)',
              }}
            >
              <Stack spacing={1.25}>
                <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <Chip size="small" color={active ? 'primary' : 'default'} label={tzLabel} sx={{ height: 26 }} />
                  <Chip size="small" color={pill.color} label={pill.label} sx={{ height: 26 }} />
                </Stack>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <TimeBox label="Start" fullWidth value={curBegin} ariaLabel={`${tzLabel} start time`} onChange={(value) => settings.edit(begin, value)} />
                  <TimeBox label="End" fullWidth value={curEnd} ariaLabel={`${tzLabel} end time`} onChange={(value) => settings.edit(end, value)} />
                </Stack>
                <WeekdayRow
                  bits={curDays}
                  labelPrefix={tzLabel}
                  onToggle={(day, on) => settings.edit(days, setBit(curDays, day, on))}
                />
                <Stack direction="row" sx={{ gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500, mr: 0.25 }}>Relays</Typography>
                  {shown.map((relay) => (
                    <MobileFilterChip
                      key={relay}
                      label={relayName(relayLabels, relay)}
                      selected={curRelays[relay] === '1'}
                      showCheck
                      onClick={() => settings.edit(relays, setBit(curRelays, relay, curRelays[relay] !== '1'))}
                    />
                  ))}
                  {showFloors && (
                    <TextField
                      size="small"
                      placeholder="Floors (e.g. 1,8)"
                      value={settings.current(floors)}
                      slotProps={{ htmlInput: { 'aria-label': `${tzLabel} floors` } }}
                      sx={{ width: '13ch', '& .MuiInputBase-input': { py: 0.5, px: 0.75, fontSize: '0.85rem' } }}
                      onChange={(event) => settings.edit(floors, event.target.value.trim())}
                    />
                  )}
                </Stack>
              </Stack>
            </Paper>
          );
        })}
      </Stack>
    </GroupPage>
  );
}
