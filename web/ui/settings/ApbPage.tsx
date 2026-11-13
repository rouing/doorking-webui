import type { ReactNode } from 'react';
import { Flex, RadioGroup, Select, Table, Text, TextField } from '@radix-ui/themes';
import type { GateSettingRow } from '../../../src/types.ts';
import type { GateApi } from '../api.ts';
import { HelpTip } from '../HelpTip.tsx';
import { Box, DAY_LETTERS, GroupPage, Head, rowState, setBit, TimeBox } from './GroupPage.tsx';
import { useGateSettings, type GateSettings } from './useGateSettings.ts';

const MAX_RELAYS = 10;
// Values Clear sets (every setting on the page back to unset).
const CLEAR: Record<string, string> = {
  apbMode: 'Off', apbRelaysIn: '', apbRelaysOut: '', apbCounterEvery: 'Off', apbCounterReset: '', apbResyncAll: 'No',
  apbResyncList: '', apbScheduleEnabled: 'No', apbScheduleDays: '0000000', apbScheduleTime: '',
};
// "?" tip of each row (a key in HELP).
const ROW_HELP: Record<string, string> = {
  'True Anti Passback': 'apbMode', 'Relays In': 'apbRelays', 'Relays Out': 'apbRelays', 'Record Facility Counter Every': 'apbCounter',
  'Reset Facility Counter to': 'apbCounter', 'Re-Sync': 'apbResync', 'Enable Scheduled Re-Sync All': 'apbResync',
};

function Choice({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <Select.Root size="1" value={value} onValueChange={onChange}>
      <Select.Trigger />
      <Select.Content>{(options.includes(value) ? options : [...options, value]).map((o) => <Select.Item key={o} value={o}>{o}</Select.Item>)}</Select.Content>
    </Select.Root>
  );
}

// In/Out relays: checkboxes for the shown relays; hidden relays already set are kept. At most 10 in total.
function RelayPicks({ gs, f, name, shown }: { gs: GateSettings; f: GateSettingRow; name: (r: number) => string; shown: number[] }) {
  const on = new Set(gs.current(f).split(',').filter(Boolean).map(Number));
  const set = (r: number, v: boolean) => { if (v) on.add(r); else on.delete(r); gs.edit(f, [...on].sort((a, b) => a - b).join(',')); };
  return (
    <Flex gap="3" wrap="wrap">
      {shown.map((r) => <Box key={r} label={name(r)} checked={on.has(r)} disabled={!on.has(r) && on.size >= MAX_RELAYS} onChange={(v) => set(r, v)} />)}
    </Flex>
  );
}

// Re-Sync: none, all devices, or a list of up to 5 device numbers.
function Resync({ gs, all, list }: { gs: GateSettings; all: GateSettingRow; list: GateSettingRow }) {
  const cur = gs.current(list);
  const mode = cur !== '' ? 'list' : gs.current(all) === 'Yes' ? 'all' : 'none';
  const slots = (cur || ',,,,').split(',');
  const setMode = (m: string) => {
    gs.edit(all, m === 'all' ? 'Yes' : 'No');
    gs.edit(list, m === 'list' ? (cur || ',,,,') : '');
  };
  return (
    <Flex direction="column" gap="2">
      <RadioGroup.Root size="1" value={mode} onValueChange={setMode}>
        <Flex gap="3"><RadioGroup.Item value="none">None</RadioGroup.Item><RadioGroup.Item value="all">Re-Sync All Devices</RadioGroup.Item>
          <RadioGroup.Item value="list">Enable Re-Sync List</RadioGroup.Item></Flex>
      </RadioGroup.Root>
      <Flex gap="1">
        {Array.from({ length: 5 }, (_, i) => (
          <TextField.Root key={i} size="1" type="number" min={1} max={65535} style={{ width: '9ch' }} disabled={mode !== 'list'} value={slots[i] ?? ''}
            onChange={(e) => { const s = Array.from({ length: 5 }, (__, j) => slots[j] ?? ''); s[i] = e.target.value.trim(); gs.edit(list, s.join(',')); }} />
        ))}
      </Flex>
    </Flex>
  );
}

// Anti-Pass Back (names.bin block 20): mode, In/Out relays, facility counter, one-time re-sync and the scheduled
// Re-Sync All. shown: relays 0-2 plus the Tracker relays.
export function ApbPage({ gapi, relayLabels, relays: shown }: { gapi: GateApi; relayLabels: Record<string, string | undefined>; relays: number[] }) {
  const gs = useGateSettings(gapi);
  const f = (k: string) => gs.field(k);
  const name = (r: number) => (relayLabels[r] && relayLabels[r] !== `Relay ${r}` ? relayLabels[r]! : String(r));
  const rows: [string, (GateSettingRow | undefined)[], (fs: GateSettingRow[]) => ReactNode][] = [
    ['True Anti Passback', [f('apbMode')], ([x]) => <Choice value={gs.current(x)} options={['Off', 'Passive', 'Active', 'Trap']} onChange={(v) => gs.edit(x, v)} />],
    ['Relays In', [f('apbRelaysIn')], ([x]) => <RelayPicks gs={gs} f={x} name={name} shown={shown} />],
    ['Relays Out', [f('apbRelaysOut')], ([x]) => <RelayPicks gs={gs} f={x} name={name} shown={shown} />],
    ['Record Facility Counter Every', [f('apbCounterEvery')], ([x]) => <Choice value={gs.current(x)} options={['Off', '15 Mins', '30 Mins', 'Hour']} onChange={(v) => gs.edit(x, v)} />],
    ['Reset Facility Counter to', [f('apbCounterReset')], ([x]) => <TextField.Root size="1" type="number" min={0} max={65535} style={{ width: '10ch' }}
      value={gs.current(x)} onChange={(e) => gs.edit(x, e.target.value.trim())} />],
    ['Re-Sync', [f('apbResyncAll'), f('apbResyncList')], ([a, l]) => <Resync gs={gs} all={a} list={l} />],
    ['Enable Scheduled Re-Sync All', [f('apbScheduleEnabled')], ([x]) => <Box checked={gs.current(x) === 'Yes'} onChange={(on) => gs.edit(x, on ? 'Yes' : 'No')} />],
    ['Scheduled Re-Sync All days', [f('apbScheduleDays')], ([x]) => (
      <Flex gap="2">{DAY_LETTERS.map((d, i) => <Box key={i} label={d} checked={gs.current(x)[i] === '1'} onChange={(on) => gs.edit(x, setBit(gs.current(x), i, on))} />)}</Flex>
    )],
    ['Scheduled Re-Sync All time', [f('apbScheduleTime')], ([x]) => <TimeBox value={gs.current(x)} onChange={(v) => gs.edit(x, v)} />],
  ];
  return (
    <GroupPage gs={gs} group="Anti-Pass Back" title="Anti-Pass Back" help="apb" clearValue={(x) => CLEAR[x.key]}
      intro="Set the anti-pass back mode, In/Out relays (up to 10 each), facility counter, one-time re-sync functions and the scheduled Re-Sync All. Anti-pass back applies only to cards in security levels 02–27; levels 01, 28, 29 and 30 are never limited by it. Clear sets every setting on this page back to unset. Edits go to the working copy (blue = unsaved, green = saved but not sent to the gate).">
      <Head cols={['Setting', 'Value', 'Status']} />
      <Table.Body>
        {rows.map(([label, fs, build]) => {
          if (fs.some((x) => !x)) return null;
          const st = rowState(gs, fs, undefined, undefined, 'saved, not sent');
          return (
            <Table.Row key={label} style={st.style}>
              <Table.Cell>{label}{ROW_HELP[label] && <HelpTip of={ROW_HELP[label]} />}</Table.Cell>
              <Table.Cell>{build(fs as GateSettingRow[])}</Table.Cell>
              <Table.Cell><Text size="1" color="gray">{st.status}</Text></Table.Cell>
            </Table.Row>
          );
        })}
      </Table.Body>
    </GroupPage>
  );
}
