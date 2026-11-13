import { useState } from 'react';
import { Select, Table, Text, TextField } from '@radix-ui/themes';
import type { GatePrefs, GateSettingRow } from '../../../src/types.ts';
import type { GateApi } from '../api.ts';
import { trackerOf, trackerRelays } from '../format.ts';
import { Box, CLEAR_NOTE, DAY_LETTERS, GroupPage, Head, rowState, setBit, TimeBox } from './GroupPage.tsx';
import { useGateSettings } from './useGateSettings.ts';
import { HOL_FOR_SL } from './ListPages.tsx';

const EDITS_NOTE = 'Edits go to the working copy (blue = unsaved, green = saved but not sent to the gate).';

// The shown relays as ranges, e.g. "0–2" or "0–10".
const relayRanges = (rs: number[]) => rs.reduce<number[][]>((acc, r) => {
  const last = acc[acc.length - 1];
  if (last && r === last[1] + 1) last[1] = r; else acc.push([r, r]);
  return acc;
}, []).map(([a, b]) => (a === b ? String(a) : `${a}–${b}`)).join(', ');

// Hold Open unset: no times, no days, and the shown relays off for every row (hidden relays stay as they are).
const holdOpenClear = (shown: number[]) => (x: GateSettingRow) => {
  if (x.key.endsWith('Begin') || x.key.endsWith('End')) return '';
  if (x.key.endsWith('Days')) return '';
  const relay = /^holdOpenRelay(\d+)$/.exec(x.key);
  return relay && shown.includes(Number(relay[1])) ? '00000000' : undefined;
};

// Hold Open: begin/end times and days per row (7 rows + Holiday), and which relays each row holds open. The relay
// columns are stored per relay as one flag per row. shown: relays 0-2 plus the Tracker relays.
export function HoldOpenPage({ gapi, relays: shown }: { gapi: GateApi; relays: number[] }) {
  const gs = useGateSettings(gapi);
  const f = (label: string, part: string) => gs.field(`holdOpen${label}${part}`);
  const relays = shown.map((r) => f('Relay', String(r)));
  return (
    <GroupPage gs={gs} group="Hold Open" title="Hold Open" help="holdOpen" clearValue={holdOpenClear(shown)}
      intro={`Set begin/end times and days for each schedule row (7 rows + the Holiday row), and which relays (${relayRanges(shown)}) it holds open. Leave a row's times blank to disable it. ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Head cols={['Row', 'Begin', 'End', ...DAY_LETTERS, ...shown.map(String), 'Status']} />
      <Table.Body>
        {['1', '2', '3', '4', '5', '6', '7', 'Hol'].map((label, ri) => {
          const begin = f(label, 'Begin'); const end = f(label, 'End'); const days = f(label, 'Days');
          if (!begin || !end || !days) return null;
          const relayEdited = relays.some((x) => x && gs.current(x)[ri] !== x.value[ri]);
          const relayPending = relays.some((x) => x && x.value[ri] !== x.gate[ri]);
          const own = [begin, end, days];
          const st = rowState(gs, own, own.some((x) => x.key in gs.edits) || relayEdited,
            own.some((x) => x.value !== x.gate) || relayPending);
          return (
            <Table.Row key={label} style={st.style}>
              <Table.RowHeaderCell>{label}</Table.RowHeaderCell>
              <Table.Cell><TimeBox value={gs.current(begin)} onChange={(v) => gs.edit(begin, v)} /></Table.Cell>
              <Table.Cell><TimeBox value={gs.current(end)} onChange={(v) => gs.edit(end, v)} /></Table.Cell>
              {DAY_LETTERS.map((_, d) => (
                <Table.Cell key={d}><Box checked={gs.current(days)[d] === '1'} onChange={(on) => gs.edit(days, setBit(gs.current(days), d, on))} /></Table.Cell>
              ))}
              {relays.map((x, i) => (
                <Table.Cell key={i}>{x && <Box checked={gs.current(x)[ri] === '1'} onChange={(on) => gs.edit(x, setBit(gs.current(x), ri, on))} />}</Table.Cell>
              ))}
              <Table.Cell><Text size="1" color="gray">{st.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}

// Elevator Reference table (DoorKing manual 4.3): for each of the 8 references (ER1-ER8), which elevators (1-8) a
// visitor may use and how long the resident's floor button stays active, in seconds. A resident's Elevator
// reference picks the row.
export function ElevatorPage({ gapi }: { gapi: GateApi }) {
  const gs = useGateSettings(gapi);
  return (
    <GroupPage gs={gs} group="Elevator" title="Elevator Reference" help="elevatorReference" clearValue={(x) => (x.key.endsWith('Elevators') ? '00000000' : '')}
      intro={`When a resident lets a visitor in, the visitor can use only the elevators checked in the resident's Elevator reference row, and only the resident's floor button works, for the time set here (seconds, counted once the elevator reaches the ground floor). ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Head cols={['Reference', ...Array.from({ length: 8 }, (_, e) => String(e + 1)), 'Floor button (s)', 'Status']} />
      <Table.Body>
        {Array.from({ length: 8 }, (_, i) => i + 1).map((r) => {
          const elevs = gs.field(`elevator${r}Elevators`); const time = gs.field(`elevator${r}Time`);
          if (!elevs || !time) return null;
          const st = rowState(gs, [elevs, time]);
          return (
            <Table.Row key={r} style={st.style}>
              <Table.RowHeaderCell>ER{r}</Table.RowHeaderCell>
              {Array.from({ length: 8 }, (_, e) => (
                <Table.Cell key={e}><Box checked={gs.current(elevs)[e] === '1'} onChange={(on) => gs.edit(elevs, setBit(gs.current(elevs), e, on))} /></Table.Cell>
              ))}
              <Table.Cell><TextField.Root size="1" type="number" min={0} max={254} style={{ width: '8ch' }} value={gs.current(time)}
                onChange={(e) => gs.edit(time, e.target.value.trim())} /></Table.Cell>
              <Table.Cell><Text size="1" color="gray">{st.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}

// Relay / Elevator table: which elevators (1-8) each relay controls. Relays 0-2, plus 3-10 / 11-18 with the Tracker
// boxes; hidden relays are left as they are.
export function RelayElevatorPage({ gapi, prefs }: { gapi: GateApi; prefs: GatePrefs }) {
  const gs = useGateSettings(gapi);
  const relays = trackerRelays(trackerOf(prefs));
  const label = (r: number) => prefs.relayLabels?.[String(r)];
  return (
    <GroupPage gs={gs} group="Relay Elevator" title="Relay / Elevator" help="relayElevator"
      clearValue={(x) => (relays.includes(Number(/^relay(\d+)Elevators$/.exec(x.key)?.[1])) ? '00000000' : undefined)}
      intro={`Check which elevators (1–8) each relay controls. Relays 3–18 show when their Tracker box is ticked on the Relays page. ${CLEAR_NOTE} ${EDITS_NOTE}`}>
      <Head cols={['Relay', ...Array.from({ length: 8 }, (_, e) => String(e + 1)), 'Status']} />
      <Table.Body>
        {relays.map((r) => {
          const elevs = gs.field(`relay${r}Elevators`);
          if (!elevs) return null;
          const st = rowState(gs, [elevs]);
          return (
            <Table.Row key={r} style={st.style}>
              <Table.RowHeaderCell>{`Relay ${r}${label(r) && label(r) !== `Relay ${r}` ? ` (${label(r)})` : ''}`}</Table.RowHeaderCell>
              {Array.from({ length: 8 }, (_, e) => (
                <Table.Cell key={e}><Box checked={gs.current(elevs)[e] === '1'} onChange={(on) => gs.edit(elevs, setBit(gs.current(elevs), e, on))} /></Table.Cell>
              ))}
              <Table.Cell><Text size="1" color="gray">{st.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}

// Security Levels: per level (02-30), each of its 4 time zones' begin/end times, days, relays and floors (the
// Floors column only when the gate's Floors feature is on). With Holidays for Security Levels on (working copy),
// TZ4 is the Holiday time zone and shows as HOL, as in DoorKing32. shown: relays 0-2 plus the Tracker relays.
export function SecurityPage({ gapi, floors: showFloors, relays: shown }: { gapi: GateApi; floors: boolean; relays: number[] }) {
  const gs = useGateSettings(gapi);
  const hol = gs.field(HOL_FOR_SL)?.value === 'Yes';
  const levels = [...new Set(gs.fields.filter((x) => x.group === 'Security').map((x) => Number(/^sec(\d+)tz/.exec(x.key)![1])))].sort((a, b) => a - b);
  const [picked, setPicked] = useState(2);
  const level = levels.includes(picked) ? picked : levels[0];
  const f = (tz: number, part: string) => gs.field(`sec${level}tz${tz}${part}`);
  const picker = levels.length > 0 && (
    <Select.Root value={String(level)} onValueChange={(v) => setPicked(Number(v))}>
      <Select.Trigger title="Level" />
      <Select.Content>{levels.map((l) => <Select.Item key={l} value={String(l)}>Level {String(l).padStart(2, '0')}</Select.Item>)}</Select.Content>
    </Select.Root>
  );
  return (
    <GroupPage gs={gs} group="Security" title="Security Levels" help="security" buttons={picker}
      intro={`Pick a level (02–30) and edit each of its 4 time zones: begin/end times, days, ${showFloors
        ? `relays (${relayRanges(shown)}) and floors (comma-separated, 1–64)` : `and relays (${relayRanges(shown)})`}. ${hol
        ? 'Holidays for Security Levels is on (Holidays page), so TZ4 is the Holiday time zone (HOL): on a holiday it overrides the other time zones of the level. '
        : ''}${EDITS_NOTE}`}>
      <Head cols={['TZ', 'Begin', 'End', ...DAY_LETTERS, ...shown.map(String), ...(showFloors ? ['Floors'] : []), 'Status']} />
      <Table.Body>
        {[1, 2, 3, 4].map((tz) => {
          const begin = f(tz, 'Begin'); const end = f(tz, 'End'); const days = f(tz, 'Days'); const relays = f(tz, 'Relays'); const floors = f(tz, 'Floors');
          if (!begin || !end || !days || !relays || !floors) return null;
          const st = rowState(gs, [begin, end, days, relays, floors]);
          return (
            <Table.Row key={tz} style={st.style}>
              <Table.RowHeaderCell>{tz === 4 && hol ? 'HOL' : `TZ${tz}`}</Table.RowHeaderCell>
              <Table.Cell><TimeBox value={gs.current(begin)} onChange={(v) => gs.edit(begin, v)} /></Table.Cell>
              <Table.Cell><TimeBox value={gs.current(end)} onChange={(v) => gs.edit(end, v)} /></Table.Cell>
              {DAY_LETTERS.map((_, d) => (
                <Table.Cell key={d}><Box checked={gs.current(days)[d] === '1'} onChange={(on) => gs.edit(days, setBit(gs.current(days), d, on))} /></Table.Cell>
              ))}
              {shown.map((r) => (
                <Table.Cell key={r}><Box checked={gs.current(relays)[r] === '1'} onChange={(on) => gs.edit(relays, setBit(gs.current(relays), r, on))} /></Table.Cell>
              ))}
              {showFloors && (
                <Table.Cell><TextField.Root size="1" placeholder="e.g. 1,8" style={{ width: '12ch' }} value={gs.current(floors)}
                  onChange={(e) => gs.edit(floors, e.target.value.trim())} /></Table.Cell>
              )}
              <Table.Cell><Text size="1" color="gray">{st.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}
