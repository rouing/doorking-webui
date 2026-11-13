import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Checkbox, Flex, Heading, Table, Text, TextField } from '@radix-ui/themes';
import type { Schedule, ScheduleAction, SchedulesReply } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ACTION_ORDER: ScheduleAction[] = ['send', 'residents', 'transactions', 'snapshots'];

// This gate's scheduled transfers (days 0-6 = Sun-Sat, 24-hour time), run by the server with the DKS password of
// the user who last saved each entry.
export function Schedules({ gapi, video }: { gapi: GateApi; video: boolean }) {
  const NAMES: Record<ScheduleAction, string> = { send: 'Send to gate', residents: 'Pull residents', transactions: 'Pull transactions',
    snapshots: video ? 'Camera videos' : 'Camera snapshots' };
  const LABELS: Record<ScheduleAction, string> = { send: 'Send working copy to gate', residents: 'Pull residents',
    transactions: 'Pull transactions', snapshots: video ? 'Get camera videos' : 'Get camera snapshots' };
  const [list, setList] = useState<SchedulesReply | null>(null);
  const [info, setInfo] = useState('Loading…');
  const [editing, setEditing] = useState<string | null>(null); // id in the form, or null when adding
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]);
  const [time, setTime] = useState('02:00');
  const [actions, setActions] = useState<ScheduleAction[]>(['transactions']);
  const [enabled, setEnabled] = useState(true);
  const [formInfo, setFormInfo] = useState('');
  const [dialog, confirm] = useConfirm();

  const load = useCallback(async () => {
    try {
      const r = await gapi<SchedulesReply>('GET', '/schedules');
      setList(r);
      setInfo(`${r.schedules.length} schedule${r.schedules.length === 1 ? '' : 's'}`);
    } catch (e) { setInfo(errorText(e)); }
  }, [gapi]);
  useEffect(() => { load(); }, [load]);

  const fill = (e: Schedule | null) => {
    setEditing(e ? e.id : null);
    setDays(e ? e.days : [0, 1, 2, 3, 4, 5, 6]);
    setTime(e ? e.time : '02:00');
    setActions(e ? e.actions : ['transactions']);
    setEnabled(e ? e.enabled : true);
    setFormInfo('');
  };
  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list.filter((x) => x !== v), v] : list.filter((x) => x !== v));

  async function save() {
    const body = { days: [...days].sort((a, b) => a - b), time, actions: ACTION_ORDER.filter((a) => actions.includes(a)), enabled };
    if (body.actions.includes('send') && !await confirm({ title: 'Save this schedule?', action: 'Save',
      body: 'This schedule sends the working copy to the gate without asking.' })) return;
    setFormInfo('Saving…');
    try {
      if (editing) await gapi('PUT', `/schedules/${encodeURIComponent(editing)}`, body);
      else await gapi('POST', '/schedules', body);
      fill(null);
      setFormInfo('Saved. Your DKS password is stored for scheduled transfers.');
      await load();
    } catch (e) { setFormInfo(`Save failed: ${errorText(e)}`); }
  }

  const act = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { setInfo(errorText(e)); } };
  const runNow = (e: Schedule) => act(async () => {
    await gapi('POST', `/schedules/${encodeURIComponent(e.id)}/run`, {});
    await load();
    setInfo('Queued. Progress shows under Gate connection.');
  });
  const remove = (e: Schedule) => act(async () => {
    if (!await confirm({ title: 'Delete this schedule?', action: 'Delete', color: 'red' })) return;
    await gapi('DELETE', `/schedules/${encodeURIComponent(e.id)}`);
    if (editing === e.id) fill(null);
    await load();
  });

  return (
    <Flex direction="column" gap="3">
      {dialog}
      <Heading>Scheduled Transfers</Heading>
      <Text size="2" color="gray">
        The server runs these at the set days and time (the server's local time), even when no one is signed in. They use the
        gate's DKS login (System Settings → Gate login). A time missed while the server was stopped runs once when it starts. Send to gate runs
        only when the working copy has changes, and runs before the pulls.
      </Text>
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">{editing ? 'Edit schedule' : 'Add a schedule'}</Heading>
          <Flex gap="3" align="center" wrap="wrap">
            <Text size="2" weight="medium">Days:</Text>
            {DAYS.map((d, i) => (
              <Text key={d} as="label" size="2"><Flex gap="1" align="center">
                <Checkbox checked={days.includes(i)} onCheckedChange={(v) => setDays(toggle(days, i, v === true))} />{d}
              </Flex></Text>
            ))}
          </Flex>
          <Flex gap="3" align="center" wrap="wrap">
            <Text size="2" weight="medium">Time</Text>
            <TextField.Root type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            <Text size="2" weight="medium">Transfers:</Text>
            {ACTION_ORDER.map((a) => (
              <Text key={a} as="label" size="2"><Flex gap="1" align="center">
                <Checkbox checked={actions.includes(a)} onCheckedChange={(v) => setActions(toggle(actions, a, v === true))} />{LABELS[a]}
              </Flex></Text>
            ))}
            <Text as="label" size="2"><Flex gap="1" align="center">
              <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />Enabled
            </Flex></Text>
          </Flex>
          <Flex gap="3" align="center">
            <Button onClick={save}>Save schedule</Button>
            {editing && <Button variant="soft" color="gray" onClick={() => fill(null)}>Cancel edit</Button>}
            <Text size="2" color="gray">{formInfo}</Text>
          </Flex>
        </Flex>
      </Card>
      <Card>
        <Heading size="3" mb="2">Schedules for this gate</Heading>
        <Flex gap="3" align="center" mb="2">
          <Button variant="soft" color="gray" onClick={load}>Refresh</Button>
          <Text size="2" color="gray">{info}</Text>
        </Flex>
        <Table.Root size="1">
          <Table.Header>
            <Table.Row>
              {['Days', 'Time', 'Transfers', 'Enabled', 'Saved by', 'Next run', 'Last run', 'Last result', ''].map((h, i) => (
                <Table.ColumnHeaderCell key={i}>{h}</Table.ColumnHeaderCell>))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {(list?.schedules || []).map((e) => {
              const result = e.queued ? 'Queued' : e.lastResult === 'failed' ? `Failed: ${e.lastError || ''}`
                : e.lastResult === 'done' ? `OK${e.lastError ? ` — ${e.lastError}` : ''}` : '';
              return (
                <Table.Row key={e.id} style={{ background: e.lastResult === 'failed' && !e.queued ? 'var(--red-a3)' : undefined,
                  color: e.enabled ? undefined : 'var(--gray-10)' }}>
                  <Table.Cell>{e.days.length === 7 ? 'Every day' : e.days.map((d) => DAYS[d]).join(', ')}</Table.Cell>
                  <Table.Cell>{e.time}</Table.Cell>
                  <Table.Cell>{e.actions.map((a) => NAMES[a]).join(', ')}</Table.Cell>
                  <Table.Cell>{e.enabled ? 'Yes' : 'No'}</Table.Cell>
                  <Table.Cell>{e.user}</Table.Cell>
                  <Table.Cell>{fmtTime(e.nextRun)}</Table.Cell>
                  <Table.Cell>{fmtTime(e.lastRun)}</Table.Cell>
                  <Table.Cell>{result}</Table.Cell>
                  <Table.Cell><Flex gap="1">
                    <Button size="1" variant="soft" color="gray" onClick={() => fill(e)}>Edit</Button>
                    <Button size="1" variant="soft" color="gray" onClick={() => runNow(e)}>Run now</Button>
                    <Button size="1" variant="soft" color="red" onClick={() => remove(e)}>Delete</Button>
                  </Flex></Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      </Card>
    </Flex>
  );
}
