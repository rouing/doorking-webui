import { useState } from 'react';
import { Chip, Paper, Stack, TableBody, TableCell, TableRow, TextField, Typography } from '@mui/material';
import { Choice } from '../panes/fields.tsx';
import type { GatePrefs, GateSettingRow } from '../types.ts';
import type { GateApi } from '../api.ts';
import { trackerOf, trackerRelays } from '../format.ts';
import { Box, CLEAR_NOTE, DAY_LETTERS, DAY_NAMES, GroupPage, Head, rowState, setBit, TimeBox, TogglePill } from './GroupPage.tsx';
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
}

/**
 * Hold Open: begin/end times and days per row (7 rows + Holiday), and which relays each row holds open. The relay
 * columns are stored per relay as one flag per row. shown: relays 0-2 plus the Tracker relays.
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.relays - Relays.
 * @returns Rendered React element.
 */
export function HoldOpenPage({ gapi, relays: shown }: HoldOpenPageProps) {
  const settings = useGateSettings(gapi);
  const field = (label: string, part: string) => settings.field(`holdOpen${label}${part}`);
  const relays = shown.map((relay) => field('Relay', String(relay)));
  return (
    <GroupPage settings={settings} group="Hold Open" title="Hold Open" help="holdOpen" bare clearValue={holdOpenClear(shown)}
      intro={`Set begin/end times and days for each schedule row (7 rows + the Holiday row), and which relays (${relayRanges(shown)}) it holds open. Leave a row's times blank to disable it. ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Stack spacing={1} sx={{ width: '100%', maxWidth: 680 }}>
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
            <Paper key={label} variant="outlined" sx={{ p: 1.25, width: '100%', boxSizing: 'border-box', backgroundColor: row.style.background || 'background.paper' }}>
              <Stack spacing={1}>
                <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                    <Chip size="small" color={active ? 'primary' : 'default'} label={label === 'Hol' ? 'HOL' : `#${label}`} sx={{ minWidth: 44 }} />
                    <TimeBox value={curBegin} ariaLabel={`Row ${label} begin time`} onChange={(value) => settings.edit(begin, value)} />
                    <Typography variant="caption" color="text.secondary">–</Typography>
                    <TimeBox value={curEnd} ariaLabel={`Row ${label} end time`} onChange={(value) => settings.edit(end, value)} />
                  </Stack>
                  <Chip size="small" color={pill.color} label={pill.label} sx={{ minWidth: 68, flexShrink: 0 }} />
                </Stack>
                <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ mr: 0.25, fontWeight: 600 }}>Days</Typography>
                    {DAY_LETTERS.map((letter, day) => (
                      <TogglePill
                        key={day}
                        label={letter}
                        active={curDays[day] === '1'}
                        ariaLabel={`Row ${label} ${DAY_NAMES[day]}`}
                        onToggle={(on) => settings.edit(days, setBit(curDays, day, on))}
                      />
                    ))}
                  </Stack>
                  <Stack direction="row" spacing={0.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ mr: 0.25, fontWeight: 600 }}>Relays</Typography>
                    {relays.map((relay, i) => relay && (
                      <TogglePill
                        key={i}
                        label={String(shown[i])}
                        active={settings.current(relay)[rowIndex] === '1'}
                        ariaLabel={`Row ${label} relay ${shown[i]}`}
                        onToggle={(on) => settings.edit(relay, setBit(settings.current(relay), rowIndex, on))}
                      />
                    ))}
                  </Stack>
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
 * @returns Rendered React element.
 */
export function SecurityPage({ gapi, floors: showFloors, relays: shown }: SecurityPageProps) {
  const settings = useGateSettings(gapi);
  const hol = settings.field(HOL_FOR_SL)?.value === 'Yes';
  const levels = [...new Set(settings.fields.filter((setting) => setting.group === 'Security').map((setting) => Number(/^sec(\d+)tz/.exec(setting.key)![1])))].sort((a, b) => a - b);
  const [picked, setPicked] = useState(2);
  const level = levels.includes(picked) ? picked : levels[0];
  const field = (tz: number, part: string) => settings.field(`sec${level}tz${tz}${part}`);
  const picker = levels.length > 0 && (
    <Choice
      title="Level"
      ariaLabel="Security level"
      value={String(level)}
      onChange={(value) => setPicked(Number(value))}
      options={levels.map((lvl) => [String(lvl), `Level ${String(lvl).padStart(2, '0')}`] as const)}
    />
  );
  return (
    <GroupPage settings={settings} group="Security" title="Security Levels" help="security" bare buttons={picker}
      intro={`Pick a level (02–30) and edit each of its 4 time zones: begin/end times, days, ${showFloors
        ? `relays (${relayRanges(shown)}) and floors (comma-separated, 1–64)` : `and relays (${relayRanges(shown)})`}. ${hol
        ? 'Holidays for Security Levels is on (Holidays page), so TZ4 is the Holiday time zone (HOL): on a holiday it overrides the other time zones of the level. '
        : ''}${EDITS_NOTE}`}>
      <Stack spacing={1} sx={{ width: '100%', maxWidth: 680 }}>
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
            <Paper key={tz} variant="outlined" sx={{ p: 1.25, width: '100%', boxSizing: 'border-box', backgroundColor: row.style.background || 'background.paper' }}>
              <Stack spacing={1}>
                <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                  <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                    <Chip size="small" color={active ? 'primary' : 'default'} label={tzLabel} sx={{ minWidth: 46 }} />
                    <TimeBox value={curBegin} ariaLabel={`${tzLabel} begin time`} onChange={(value) => settings.edit(begin, value)} />
                    <Typography variant="caption" color="text.secondary">–</Typography>
                    <TimeBox value={curEnd} ariaLabel={`${tzLabel} end time`} onChange={(value) => settings.edit(end, value)} />
                  </Stack>
                  <Chip size="small" color={pill.color} label={pill.label} sx={{ minWidth: 68, flexShrink: 0 }} />
                </Stack>
                <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ mr: 0.25, fontWeight: 600 }}>Days</Typography>
                    {DAY_LETTERS.map((letter, day) => (
                      <TogglePill
                        key={day}
                        label={letter}
                        active={curDays[day] === '1'}
                        ariaLabel={`${tzLabel} ${DAY_NAMES[day]}`}
                        onToggle={(on) => settings.edit(days, setBit(curDays, day, on))}
                      />
                    ))}
                  </Stack>
                  <Stack direction="row" spacing={0.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ mr: 0.25, fontWeight: 600 }}>Relays</Typography>
                    {shown.map((relay) => (
                      <TogglePill
                        key={relay}
                        label={String(relay)}
                        active={curRelays[relay] === '1'}
                        ariaLabel={`${tzLabel} relay ${relay}`}
                        onToggle={(on) => settings.edit(relays, setBit(curRelays, relay, on))}
                      />
                    ))}
                  </Stack>
                  {showFloors && (
                    <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>Floors</Typography>
                      <TextField
                        size="small"
                        placeholder="e.g. 1,8"
                        value={settings.current(floors)}
                        slotProps={{ htmlInput: { 'aria-label': `${tzLabel} floors` } }}
                        sx={{ width: '11ch', '& .MuiInputBase-input': { py: 0.5, px: 0.75, fontSize: '0.85rem' } }}
                        onChange={(event) => settings.edit(floors, event.target.value.trim())}
                      />
                    </Stack>
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
