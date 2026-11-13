import { useState } from 'react';
import { Button, Card, Checkbox, Flex, Grid, Heading, Select, Table, Text, TextField } from '@radix-ui/themes';
import type { CameraSettings } from '../../../src/types.ts';
import { errorText, gateUrl, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { Field } from '../panes/fields.tsx';

type LiveFrame = { channel: number; name?: string; file?: string; error?: string };

function Choice({ value, options, onChange, disabled }: { value: string; options: [string, string][]; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger />
      <Select.Content>{options.map(([v, label]) => <Select.Item key={v} value={v}>{label}</Select.Item>)}</Select.Content>
    </Select.Root>
  );
}
const nums = (list: number[]): [string, string][] => list.map((n) => [String(n), String(n)]);

// Gate cameras: a Dahua/Amcrest recorder reached through Dahua's P2P cloud. Up to 4 channels. The password is
// never sent back; leaving it blank keeps the saved one.
export function CameraForm({ settings, phone, gapi, onSaved }: { settings: CameraSettings | null; phone: string; gapi: GateApi; onSaved: () => Promise<void> }) {
  const c = settings;
  const [f, setF] = useState(() => ({
    serial: c?.serial || '', username: c?.username || '', password: '', clockOffset: String(c?.clockOffset ?? 0), mode: c?.mode || 'snapshots',
    frames: String(c?.frames ?? 3), framesAfter: String(c?.framesAfter ?? 0), clipTries: String(c?.clipTries ?? 2), events: c?.events || 'access',
    backfillHours: String(c?.backfillHours ?? 24), keepDays: String(c?.keepDays ?? 0), enabled: c ? c.enabled !== false : true,
  }));
  const [channels, setChannels] = useState(() => Array.from({ length: 4 }, (_, i) => {
    const ch = (c?.channels || [{ channel: 1, name: '' }])[i];
    return { channel: ch ? String(ch.channel) : '', name: ch ? ch.name : '' };
  }));
  const [info, setInfo] = useState('');
  const [live, setLive] = useState<{ frames: LiveFrame[]; stamp: number } | null>(null);
  const [testing, setTesting] = useState(false);
  const [dialog, confirm] = useConfirm();
  const set = (k: keyof typeof f, v: string | boolean) => setF({ ...f, [k]: v });
  const video = f.mode === 'video';

  const run = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { setInfo(errorText(e)); } };
  const save = () => run(async () => {
    const keep = Number(f.keepDays);
    if (keep && keep !== (settings?.keepDays || 0) && !await confirm({ title: `Keep pictures for ${keep} days?`, action: 'Save', color: 'red',
      body: `Pictures and videos older than ${keep} days are deleted now, and each day from then on. This cannot be undone.` })) return;
    setInfo('Saving…');
    try { await gapi('PUT', '/cameras', { ...f, channels: channels.map((ch) => ({ channel: ch.channel.trim(), name: ch.name })) }); } catch (e) {
      setInfo(`Save failed: ${errorText(e)}`); return;
    }
    set('password', '');
    setInfo('Saved. Use Test to check the login and channels.');
    await onSaved();
  });
  const test = () => run(async () => {
    setInfo('Connecting to the recorder… (up to a minute)');
    setTesting(true);
    try {
      const r = await gapi<{ channels: LiveFrame[] }>('POST', '/cameras/test', {});
      setLive({ frames: r.channels, stamp: Date.now() });
      setInfo(`Live pictures from ${r.channels.filter((x) => x.file).length} of ${r.channels.length} channels.`);
    } catch (e) { setInfo(`Test failed: ${errorText(e)}`); }
    setTesting(false);
  });
  const remove = () => run(async () => {
    if (!await confirm({ title: 'Remove the camera settings for this gate?', body: 'Saved snapshots are kept.', action: 'Remove', color: 'red' })) return;
    await gapi('DELETE', '/cameras');
    setLive(null);
    setInfo('Removed.');
    await onSaved();
  });
  const deleteSnaps = () => run(async () => {
    if (!await confirm({ title: 'Delete all saved camera pictures for this gate?', action: 'Delete all', color: 'red',
      body: 'This cannot be undone. Transactions still in the look-back period get new pictures on the next snapshot run.' })) return;
    try {
      const r = await gapi<{ files: number; minutes: number }>('DELETE', '/snapshots');
      setLive(null);
      setInfo(`Deleted ${r.files} pictures (${r.minutes} minutes).`);
      await onSaved();
    } catch (e) { setInfo(`Delete failed: ${errorText(e)}`); }
  });

  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3">Gate cameras</Heading>
        <Text size="2" color="gray">
          A Dahua/Amcrest recorder reached through Dahua's P2P cloud (as DMSS/SmartPSS do). After each transactions pull, including
          scheduled pulls, frames (or a 2-minute video) from each channel for every new transaction's minute are saved and shown on the
          Transactions page. Stored locally and <strong>shared by every account that manages this gate</strong>; the password is
          encrypted in the local database.
        </Text>
        <Grid columns={{ initial: '1', sm: '2', md: '3' }} gap="3">
          <Field label="Recorder serial" help="cameraSerial"><TextField.Root autoComplete="off" value={f.serial} onChange={(e) => set('serial', e.target.value)} /></Field>
          <Field label="Username"><TextField.Root autoComplete="off" value={f.username} onChange={(e) => set('username', e.target.value)} /></Field>
          <Field label="Password"><TextField.Root type="password" autoComplete="new-password" value={f.password}
            placeholder={settings ? 'saved (leave blank to keep)' : ''} onChange={(e) => set('password', e.target.value)} /></Field>
          <Field label="Clock offset (seconds)" help="clockOffset"><TextField.Root type="number" step="1" value={f.clockOffset} onChange={(e) => set('clockOffset', e.target.value)} /></Field>
          <Field label="Save" help="cameraMode"><Choice value={f.mode} onChange={(v) => set('mode', v)} options={[['snapshots', 'Snapshots (pictures)'], ['video', '2-minute video clips']]} /></Field>
          <Field label="Frames per transaction" help="cameraFrames"><Choice value={f.frames} onChange={(v) => set('frames', v)} options={nums([1, 2, 3, 4, 6])} disabled={video} /></Field>
          <Field label="Frames after the minute" help="cameraFramesAfter"><Choice value={f.framesAfter} onChange={(v) => set('framesAfter', v)} options={nums([0, 1, 2, 3, 4, 6])} disabled={video} /></Field>
          <Field label="Video tries"><Choice value={f.clipTries} onChange={(v) => set('clipTries', v)} options={nums([1, 2, 3, 4, 5])} disabled={!video} /></Field>
          <Field label="Transactions" help="cameraEvents"><Choice value={f.events} onChange={(v) => set('events', v)} options={[['access', 'Admitted and denied entries'], ['all', 'All']]} /></Field>
          <Field label="Keep pictures" help="cameraKeep"><Choice value={f.keepDays} onChange={(v) => set('keepDays', v)}
            options={[['15', '15 days'], ['30', '30 days'], ['60', '60 days'], ['90', '90 days'], ['0', 'Forever']]} /></Field>
          <Field label="Look back (hours)" help="cameraLookBack"><TextField.Root type="number" min={0} max={720} step="1" value={f.backfillHours} onChange={(e) => set('backfillHours', e.target.value)} /></Field>
        </Grid>
        <Table.Root size="1" style={{ width: 'fit-content' }}>
          <Table.Header><Table.Row><Table.ColumnHeaderCell>Channel</Table.ColumnHeaderCell><Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell></Table.Row></Table.Header>
          <Table.Body>
            {channels.map((ch, i) => (
              <Table.Row key={i}>
                <Table.Cell><TextField.Root size="1" inputMode="numeric" style={{ width: '6ch' }} value={ch.channel}
                  onChange={(e) => setChannels(channels.map((x, j) => (j === i ? { ...x, channel: e.target.value } : x)))} /></Table.Cell>
                <Table.Cell><TextField.Root size="1" maxLength={40} value={ch.name}
                  onChange={(e) => setChannels(channels.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        <Text as="label" size="2"><Flex gap="2" align="center">
          <Checkbox checked={f.enabled} onCheckedChange={(v) => set('enabled', v === true)} /> Save snapshots after transaction pulls
        </Flex></Text>
        <Text size="2" color="gray">
          Clock offset is added to the gate's transaction time to match the recorder's clock. Look back limits which transactions get
          snapshots (recorders keep only so many days). Leave the password blank to keep the saved one.
        </Text>
        {video && (
          <Text size="2" color="gray">
            Videos run from the start of the transaction's minute for 2 minutes, at the recorder's full quality without re-encoding (about
            65 MB per channel for a 4 Mbit/s camera). The recorder sends them at normal playback speed, so each video takes about 2 minutes
            to fetch, one at a time. H.265 cameras need a browser that plays H.265 (current Safari, and Chrome or Edge on most computers
            with hardware support).
          </Text>
        )}
        <Flex gap="2" wrap="wrap" align="center">
          <Button onClick={save}>Save camera settings</Button>
          <Button variant="soft" onClick={test} disabled={!settings || testing}>Test (live picture)</Button>
          <Button variant="soft" color="gray" onClick={remove} disabled={!settings}>Remove</Button>
          <Button variant="soft" color="red" onClick={deleteSnaps}>Delete all pictures</Button>
          <Text size="2" color="gray">{info}</Text>
        </Flex>
        {live && (
          <Flex gap="2" wrap="wrap" align="start">
            {live.frames.map((x) => (x.file ? (
              <figure key={x.channel} className="snap-figure">
                <img src={`${gateUrl(phone, `/snapshots/live/${x.file}`)}?t=${live.stamp}`} alt={x.name || `Channel ${x.channel}`} style={{ maxWidth: 320 }} />
                <figcaption>{x.name || `Channel ${x.channel}`} (channel {x.channel})</figcaption>
              </figure>
            ) : <Text key={x.channel} size="2" color="red">Channel {x.channel}: {x.error}</Text>))}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
