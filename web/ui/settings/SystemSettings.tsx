import { useEffect, useState } from 'react';
import { Button, Card, Checkbox, Flex, Heading, Link, Text } from '@radix-ui/themes';
import type { CameraSettings, DebugLogInfo, GateConfig as Config, GatePrefs, ResidentsReply } from '../../../src/types.ts';
import { api, errorText, gateUrl, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { HelpTip } from '../HelpTip.tsx';
import { CameraForm } from './CameraForm.tsx';
import { GateConfig } from './GateConfig.tsx';
import { GateSettingsEditor } from './GateSettingsEditor.tsx';
import { DeviceAssociation } from './LocalPrefs.tsx';
import { useGateSettings } from './useGateSettings.ts';

// Deletes everything this app stores about the gate (database rows for every user and the gate's folder), after a
// warning. Nothing on the gate changes. Afterwards the gate is gone from every list, so the page returns to the list.
function DeleteGateData({ phone, gapi, onDeleted }: { phone: string; gapi: GateApi; onDeleted: () => void }) {
  const [dialog, confirm] = useConfirm();
  const [info, setInfo] = useState('');
  const remove = async () => {
    if (!await confirm({ title: `Delete everything stored about gate ${phone}?`, action: 'Delete all gate data', color: 'red',
      body: 'This permanently deletes, for every account on this computer: the gate in every user\'s gate list (with its master code), '
        + 'gate configuration, relay names, Device association, notes, the transaction history, History, scheduled transfers, '
        + 'camera settings, the pulled files, the working copy with any unsent changes, and every camera picture and video. '
        + 'It can\'t be undone (only from a backup). Nothing on the gate itself changes.' })) return;
    setInfo('Deleting…');
    try {
      const r = await gapi<{ filesError?: string }>('POST', '/delete-data', { confirm: true });
      if (r.filesError) { setInfo(`Database data deleted, but some files could not be deleted: ${r.filesError}`); return; }
      onDeleted();
    } catch (e) { setInfo(`Not deleted: ${errorText(e)}`); }
  };
  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3" color="red">Delete stored gate data<HelpTip of="deleteGateData" /></Heading>
        <Text size="2" color="gray">
          Removes everything this app has stored about this gate, for <strong>every account</strong> on this computer, and takes it off
          every gate list. Use it when the gate is no longer managed here. Nothing on the gate changes; to manage it again, add it and pull.
        </Text>
        <Flex gap="3" align="center"><Button color="red" onClick={remove}>Delete all data for this gate…</Button>
          <Text size="2" color="gray">{info}</Text></Flex>
      </Flex>
    </Card>
  );
}

function DebugLogs() {
  const [log, setLog] = useState<DebugLogInfo | null>(null);
  const [info, setInfo] = useState('');
  useEffect(() => { api<DebugLogInfo>('GET', '/api/debug-log').then(setLog, (e) => setInfo(errorText(e))); }, []);
  const toggle = async (on: boolean) => {
    try { setLog(await api<DebugLogInfo>('PUT', '/api/debug-log', { enabled: on })); setInfo(''); } catch (e) { setInfo(`Not saved: ${errorText(e)}`); }
  };
  return (
    <Card>
      <Flex direction="column" gap="3">
        <Heading size="3">Debug logs<HelpTip of="debugLogs" /></Heading>
        <Text as="label" size="2"><Flex gap="2" align="center">
          <Checkbox checked={Boolean(log && log.enabled)} onCheckedChange={(v) => toggle(v === true)} /> Debug logs
        </Flex></Text>
        <Text size="2" color="gray">
          While on, errors and other issues (failed camera pictures after their retry, recorder connection failures, failed gate
          connections and schedules, failed requests) are added to a log file on this computer. One setting for the whole server,{' '}
          <strong>every gate and account</strong>.
        </Text>
        <Flex gap="3" align="center">
          <Link href="/api/debug-log/file" target="_blank" rel="noopener">Open log</Link>
          <Text size="2" color="gray">
            {info || (log ? `${log.file} (${log.size < 1024 ? `${log.size} bytes` : `${Math.round(log.size / 1024)} KB`})` : '')}
          </Text>
        </Flex>
      </Flex>
    </Card>
  );
}

// Downloads of the working copy's board files (names.map flags the 128-byte blocks of names.bin that changed).
function WorkingCopyFiles({ phone, available }: { phone: string; available: boolean }) {
  return (
    <Card>
      <Flex direction="column" gap="3">
        <Heading size="3">Working copy files</Heading>
        <Text size="2" color="gray">
          {available ? 'Download the working copy\'s files, with every change saved to it.' : 'No working copy yet. Pull residents from the gate.'}
        </Text>
        {available && (
          <Flex gap="3" wrap="wrap">
            {['names.bin', 'names.map', 'phone.bin', 'cards.bin'].map((f) => (
              <Link key={f} size="2" href={gateUrl(phone, `/files/${f}`)} download={f}>{f}</Link>
            ))}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}

// System Settings: gate configuration, gate settings (working copy), working copy files, device association,
// cameras, debug logs, appearance and deleting the gate's stored data. Relay names are on the Relays page.
export function SystemSettings({ phone, gapi, prefs, defaults, list, cameras, dark, onToggleDark, onReload, onSessionChange, onJobStarted }: {
  phone: string; gapi: GateApi; prefs: GatePrefs; defaults: Config; list: ResidentsReply | null; cameras: CameraSettings | null;
  dark: boolean; onToggleDark: () => void; onReload: () => Promise<void>; onSessionChange: () => void; onJobStarted: () => void;
}) {
  const gs = useGateSettings(gapi);
  const reloadAll = async () => { await onReload(); await gs.load(); };
  return (
    <Flex direction="column" gap="4">
      <Heading>System Settings</Heading>
      <GateConfig key={`${JSON.stringify(prefs.gateConfig)}-${list?.dirDigits}`} prefs={prefs} defaults={defaults} list={list} gapi={gapi}
        onSaved={async () => { onSessionChange(); await reloadAll(); }} />
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">Gate settings</Heading>
          <GateSettingsEditor gs={gs} view="prefs" gapi={gapi} onReload={onReload} onJobStarted={onJobStarted} />
        </Flex>
      </Card>
      <WorkingCopyFiles phone={phone} available={Boolean(gs.reply)} />
      <DeviceAssociation key={JSON.stringify(prefs.deviceAssociation)} prefs={prefs} gapi={gapi} onSaved={onReload} />
      <CameraForm key={JSON.stringify(cameras)} settings={cameras} phone={phone} gapi={gapi} onSaved={onReload} />
      <DebugLogs />
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">Appearance</Heading>
          <Text as="label" size="2"><Flex gap="2" align="center">
            <Checkbox checked={dark} onCheckedChange={onToggleDark} /> Dark mode
          </Flex></Text>
          <Text size="2" color="gray">Remembered in this browser.</Text>
        </Flex>
      </Card>
      <DeleteGateData phone={phone} gapi={gapi} onDeleted={onSessionChange} />
    </Flex>
  );
}
