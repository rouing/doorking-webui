import { useEffect, useState } from 'react';
import { Button, Card, Flex, Heading, Table, Text, TextField } from '@radix-ui/themes';
import type { DeviceRange, GatePrefs } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { DEFAULT_DEVICES } from '../format.ts';
import { HelpTip } from '../HelpTip.tsx';

// The name of one relay (a box in the Relays page's relay settings table). Saved on its own when the box loses
// focus or on Enter; blank goes back to "Relay N". Shared by every account that manages the gate; not sent to it.
export function RelayNameBox({ relay, prefs, gapi, onSaved }: { relay: number; prefs: GatePrefs; gapi: GateApi; onSaved: () => Promise<void> }) {
  const k = String(relay);
  const saved = (prefs.relayLabels && prefs.relayLabels[k]) || `Relay ${k}`;
  const [value, setValue] = useState(saved);
  const [info, setInfo] = useState('');
  useEffect(() => { setValue(saved); }, [saved]);
  const save = async () => {
    const next = value.trim() || `Relay ${k}`;
    setValue(next);
    if (next === saved) return;
    setInfo('Saving…');
    try {
      await gapi('PUT', '/prefs', { relayLabels: { [k]: next } });
      setInfo('');
      await onSaved();
    } catch (e) { setInfo(`Not saved: ${errorText(e)}`); }
  };
  return (
    <TextField.Root size="1" maxLength={24} value={value} color={info.startsWith('Not') ? 'red' : undefined} style={{ width: '16ch' }}
      title={info || 'Relay name, saved when you leave the box. Shared by every account that manages this gate; not sent to the gate.'}
      onChange={(e) => setValue(e.target.value)} onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}

// Device Association: names for ranges of device codes (00001-65407), up to 10 rows. The server checks names,
// ranges and overlaps on save.
export function DeviceAssociation({ prefs, gapi, onSaved }: { prefs: GatePrefs; gapi: GateApi; onSaved: () => Promise<void> }) {
  const fill = (list: DeviceRange[]) => Array.from({ length: 10 }, (_, i) => ({ ...(list[i] || { name: '', from: '', to: '' }) }));
  const [rows, setRows] = useState(() => fill(prefs.deviceAssociation || DEFAULT_DEVICES));
  const [info, setInfo] = useState('');
  const set = (i: number, k: keyof DeviceRange, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const save = async () => {
    setInfo('Saving…');
    try {
      const p = await gapi<GatePrefs>('PUT', '/prefs', { deviceAssociation: rows.map((r) => ({ name: r.name.trim(), from: r.from.trim(), to: r.to.trim() })) });
      setRows(fill(p.deviceAssociation || []));
      setInfo('Saved.');
      await onSaved(); // card transactions take their Event Type from these ranges
    } catch (e) { setInfo(`Save failed: ${errorText(e)}`); }
  };
  return (
    <Card>
      <Flex direction="column" gap="3">
        <Heading size="3">Device association<HelpTip of="deviceAssociation" /></Heading>
        <Text size="2" color="gray">
          Names (up to 12 characters) for ranges of device codes (00001–65407), like DoorKing32's <em>Dev Enable</em> window. Up to 10 rows; ranges may not
          overlap. Stored locally and <strong>shared by every account that manages this gate</strong>. Not sent to the gate.
        </Text>
        <Table.Root size="1" style={{ width: 'fit-content' }}>
          <Table.Header>
            <Table.Row>{['#', 'Device Name', 'From', 'To'].map((h) => <Table.ColumnHeaderCell key={h}>{h}</Table.ColumnHeaderCell>)}</Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((r, i) => (
              <Table.Row key={i}>
                <Table.Cell>{i + 1}</Table.Cell>
                <Table.Cell><TextField.Root size="1" maxLength={12} value={r.name} onChange={(e) => set(i, 'name', e.target.value)} /></Table.Cell>
                <Table.Cell><TextField.Root size="1" maxLength={5} inputMode="numeric" value={r.from} onChange={(e) => set(i, 'from', e.target.value)} style={{ width: '8ch' }} /></Table.Cell>
                <Table.Cell><TextField.Root size="1" maxLength={5} inputMode="numeric" value={r.to} onChange={(e) => set(i, 'to', e.target.value)} style={{ width: '8ch' }} /></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        <Flex gap="3" align="center"><Button onClick={save}>Save</Button><Text size="2" color="gray">{info}</Text></Flex>
      </Flex>
    </Card>
  );
}
