import { useEffect, useState } from 'react';
import { Badge, Button, Callout, Card, Checkbox, Flex, Grid, Heading, Link, Select, Table, Text, TextField } from '@radix-ui/themes';
import type { ApiKeyInfo, CameraSettings, DebugLogInfo, GateConfig as Config, GateLogin, GatePrefs, GateRole, GateUser, ResidentsReply } from '../../../src/types.ts';
import { api, ApiError, errorText, gateUrl, useReadOnly, type GateApi } from '../api.ts';
import { fmtIntlPhone, fmtTime } from '../format.ts';
import { Field } from '../panes/fields.tsx';
import { useConfirm } from '../Confirm.tsx';
import { HelpTip } from '../HelpTip.tsx';
import { CameraForm } from './CameraForm.tsx';
import { GateConfig } from './GateConfig.tsx';
import { GateSettingsEditor } from './GateSettingsEditor.tsx';
import { DeviceAssociation } from './LocalPrefs.tsx';
import { useGateSettings } from './useGateSettings.ts';

// The gate's DKS login and master code (admins). A new DKS login is checked with DKS Cloud before it is saved; a new
// master code is checked by pulling residents with it and saved only when that works. Neither is ever shown.
function GateLoginCard({ gapi, onJobStarted }: { gapi: GateApi; onJobStarted: () => void }) {
  const [login, setLogin] = useState<GateLogin | null>(null);
  const [f, setF] = useState({ dksUser: '', dksPassword: '', masterCode: '' });
  const [info, setInfo] = useState('');
  const load = () => gapi<GateLogin>('GET', '/login').then((l) => { setLogin(l); setF({ dksUser: l.dksUser, dksPassword: '', masterCode: '' }); },
    (e) => setInfo(errorText(e)));
  useEffect(() => { load(); }, [gapi]);
  const save = async () => {
    setInfo('Checking with DKS Cloud…');
    try {
      const r = await gapi<{ changed?: boolean; checking?: boolean }>('PUT', '/login', f);
      if (r.checking) {
        setInfo('Checking the new master code with a residents pull. It is saved when the pull succeeds (see Gate connection).');
        onJobStarted();
      } else setInfo(r.changed ? 'DKS login saved.' : 'Nothing changed.');
      await load();
    } catch (e) { setInfo(`Not saved: ${errorText(e)}`); }
  };
  return (
    <Card>
      <Flex direction="column" gap="3">
        <Heading size="3">Gate login<HelpTip of="dksLogin" /></Heading>
        <Text size="2" color="gray">
          The DKS Cloud login and master code this gate's pulls, sends, relay changes and scheduled transfers use, for every user of the gate.
          Leave the password and master code empty to keep the saved ones.
        </Text>
        {login && !login.dksPasswordSet && (
          <Callout.Root color="amber"><Callout.Text>No DKS login saved yet: pulls and sends fail until you set one.</Callout.Text></Callout.Root>
        )}
        <Grid columns={{ initial: '1', sm: '3' }} gap="3">
          <Field label="DKS user"><TextField.Root value={f.dksUser} autoComplete="off" onChange={(e) => setF({ ...f, dksUser: e.target.value })} /></Field>
          <Field label="DKS password"><TextField.Root type="password" value={f.dksPassword} autoComplete="new-password"
            placeholder={login && login.dksPasswordSet ? 'saved (leave empty to keep)' : ''} onChange={(e) => setF({ ...f, dksPassword: e.target.value })} /></Field>
          <Field label="Master code" help="gateMasterCode"><TextField.Root type="password" value={f.masterCode} inputMode="numeric" maxLength={4}
            autoComplete="off" placeholder="saved (leave empty to keep)" onChange={(e) => setF({ ...f, masterCode: e.target.value })} /></Field>
        </Grid>
        <Flex gap="3" align="center"><Button onClick={save}>Save gate login</Button><Text size="2" color="gray">{info}</Text></Flex>
      </Flex>
    </Card>
  );
}

function RoleSelect({ value, onChange }: { value: GateRole; onChange: (r: GateRole) => void }) {
  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as GateRole)}>
      <Select.Trigger />
      <Select.Content><Select.Item value="readonly">Read only</Select.Item><Select.Item value="admin">Admin</Select.Item></Select.Content>
    </Select.Root>
  );
}

// Who may use this gate (admins): roles, removing access, creating an account for the gate, and sharing it with an
// existing account. A gate always keeps at least one admin; nobody can see or set another user's password.
function GateUsersCard({ gapi, me, emailEnabled, onSessionChange }: { gapi: GateApi; me: string; emailEnabled: boolean; onSessionChange: () => void }) {
  const [users, setUsers] = useState<GateUser[]>([]);
  const [info, setInfo] = useState('');
  const [create, setCreate] = useState({ username: '', password: '', email: '', role: 'readonly' as GateRole });
  const [createInfo, setCreateInfo] = useState('');
  const [exists, setExists] = useState('');
  const [share, setShare] = useState({ username: '', role: 'readonly' as GateRole });
  const [shareInfo, setShareInfo] = useState('');
  const [dialog, confirm] = useConfirm();
  const load = () => gapi<{ users: GateUser[] }>('GET', '/users').then((r) => setUsers(r.users), (e) => setInfo(errorText(e)));
  useEffect(() => { load(); }, [gapi]);
  const act = async (fn: () => Promise<{ users: GateUser[] }>, set: (t: string) => void, done: string) => {
    try { setUsers((await fn()).users); set(done); return true; } catch (e) { set(errorText(e)); return false; }
  };
  const changeRole = async (u: GateUser, role: GateRole) => {
    await act(() => gapi('PUT', `/users/${encodeURIComponent(u.username)}`, { role }), setInfo, `${u.username} is now ${role === 'admin' ? 'an admin' : 'read only'}.`);
    if (u.username === me) onSessionChange();
  };
  const remove = async (u: GateUser) => {
    if (!await confirm({ title: `Remove ${u.username} from this gate?`, action: 'Remove', color: 'red',
      body: 'They will no longer see this gate. Their account stays (it may have other gates).' })) return;
    await act(() => gapi('DELETE', `/users/${encodeURIComponent(u.username)}`), setInfo, `${u.username} removed.`);
    if (u.username === me) onSessionChange();
  };
  const createUser = async () => {
    setExists('');
    try {
      const r = await gapi<{ users: GateUser[]; invited: boolean }>('POST', '/users', create);
      setUsers(r.users);
      const who = create.username.trim().toLowerCase();
      setCreateInfo(r.invited ? `Invitation sent to ${create.email.trim()}. ${who} chooses their password with the link (valid 72 hours).`
        : `Account ${who} created. Give them the username and temporary password; they choose their own at their first sign-in.`);
      setCreate({ username: '', password: '', email: '', role: 'readonly' });
    } catch (e) {
      setCreateInfo(errorText(e));
      if (e instanceof ApiError && e.body.exists) setExists(create.username.trim().toLowerCase());
    }
  };
  const resendInvite = (u: GateUser) => act(() => gapi('POST', `/users/${encodeURIComponent(u.username)}/invite`, {}), setInfo,
    `Invitation sent again to ${u.pendingEmail}.`);
  const shareWith = (username: string, role: GateRole, set: (t: string) => void) =>
    act(() => gapi('POST', '/share', { username, role }), set, `Shared with ${username.trim().toLowerCase()}.`);
  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3">Gate users<HelpTip of="gateRole" /></Heading>
        <Text size="2" color="gray">
          Everyone who can open this gate. <strong>Admin</strong>: can change everything, including this list. <strong>Read only</strong>: can look,
          pull and use the cameras. A gate always keeps at least one admin.
        </Text>
        <Table.Root size="1">
          <Table.Header>
            <Table.Row>{['User', 'Email', 'Phone', 'Role', 'Added by', 'Last sign-in', ''].map((h, i) => <Table.ColumnHeaderCell key={i}>{h}</Table.ColumnHeaderCell>)}</Table.Row>
          </Table.Header>
          <Table.Body>
            {users.map((u) => (
              <Table.Row key={u.username} align="center">
                <Table.Cell>{u.username}{u.username === me && <Badge ml="2" color="gray">you</Badge>}</Table.Cell>
                <Table.Cell>
                  {u.email || (u.pendingEmail ? <Text color="gray">{u.pendingEmail} (unconfirmed)</Text> : '')}
                  {u.invited && <Flex gap="2" align="center" mt="1"><Badge color="amber">invited</Badge>
                    {emailEnabled && <Button size="1" variant="ghost" onClick={() => resendInvite(u)}>Send again</Button>}</Flex>}
                </Table.Cell>
                <Table.Cell>{u.phone ? <a href={`tel:${u.phone}`}>{fmtIntlPhone(u.phone)}</a> : ''}</Table.Cell>
                <Table.Cell><RoleSelect value={u.role} onChange={(r) => changeRole(u, r)} /></Table.Cell>
                <Table.Cell>{u.grantedBy}</Table.Cell>
                <Table.Cell>{u.lastSignIn ? fmtTime(u.lastSignIn) : 'never'}</Table.Cell>
                <Table.Cell><Button size="1" variant="soft" color="red" onClick={() => remove(u)}>Remove</Button></Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
        {info && <Text size="2" color="gray">{info}</Text>}
        <Heading size="2">Create an account for this gate</Heading>
        <Text size="2" color="gray">
          {emailEnabled ? 'With an email and no password, they get an invitation link to choose their own password. Without an email, set a temporary password; they choose their own at their first sign-in.'
            : 'Set a temporary password; they choose their own at their first sign-in. (Email invitations need email set up on the server.)'}
        </Text>
        <Grid columns={{ initial: '1', sm: '4' }} gap="3">
          <Field label="Username"><TextField.Root value={create.username} autoComplete="off" onChange={(e) => setCreate({ ...create, username: e.target.value })} /></Field>
          <Field label={emailEnabled ? "Temporary password (only without an invitation)" : "Temporary password (12+ characters)"}><TextField.Root type="password" value={create.password} autoComplete="new-password"
            onChange={(e) => setCreate({ ...create, password: e.target.value })} /></Field>
          <Field label={emailEnabled ? "Email (sends an invitation)" : "Email (optional)"}><TextField.Root type="email" value={create.email} onChange={(e) => setCreate({ ...create, email: e.target.value })} /></Field>
          <Field label="Role"><RoleSelect value={create.role} onChange={(r) => setCreate({ ...create, role: r })} /></Field>
        </Grid>
        <Flex gap="3" align="center" wrap="wrap">
          <Button onClick={createUser}>Create account</Button>
          {exists && <Button variant="soft" onClick={async () => { if (await shareWith(exists, create.role, setCreateInfo)) setExists(''); }}>
            Share this gate with {exists} instead</Button>}
          <Text size="2" color="gray">{createInfo}</Text>
        </Flex>
        <Heading size="2">Share with an existing account</Heading>
        <Flex gap="3" align="end" wrap="wrap">
          <Field label="Username"><TextField.Root value={share.username} autoComplete="off" onChange={(e) => setShare({ ...share, username: e.target.value })} /></Field>
          <Field label="Role"><RoleSelect value={share.role} onChange={(r) => setShare({ ...share, role: r })} /></Field>
          <Button onClick={async () => { if (await shareWith(share.username, share.role, setShareInfo)) setShare({ username: '', role: 'readonly' }); }}>Share</Button>
          <Text size="2" color="gray">{shareInfo}</Text>
        </Flex>
      </Flex>
    </Card>
  );
}

// API keys for scripts and other systems (admins). A key belongs to this gate, not to a person; it is shown once when
// created and works only on this gate's routes, with its own role. Revoking stops it at once.
function ApiKeysCard({ phone, gapi }: { phone: string; gapi: GateApi }) {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [form, setForm] = useState({ name: '', role: 'readonly' as GateRole, expiresDays: '0' });
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [info, setInfo] = useState('');
  const [dialog, confirm] = useConfirm();
  const load = () => gapi<{ apiKeys: ApiKeyInfo[] }>('GET', '/api-keys').then((r) => setKeys(r.apiKeys), (e) => setInfo(errorText(e)));
  useEffect(() => { load(); }, [gapi]);
  const create = async () => {
    try {
      const r = await gapi<{ key: string; apiKey: ApiKeyInfo }>('POST', '/api-keys', { ...form, expiresDays: Number(form.expiresDays) });
      setCreated({ key: r.key, name: r.apiKey.name });
      setForm({ name: '', role: 'readonly', expiresDays: '0' });
      setInfo('');
      await load();
    } catch (e) { setInfo(errorText(e)); }
  };
  const revoke = async (k: ApiKeyInfo) => {
    if (!await confirm({ title: `Revoke the API key "${k.name}"?`, action: 'Revoke', color: 'red',
      body: 'Anything using it stops working at once. This can\'t be undone; create a new key if needed.' })) return;
    try { setKeys((await gapi<{ apiKeys: ApiKeyInfo[] }>('DELETE', `/api-keys/${encodeURIComponent(k.id)}`)).apiKeys); setInfo(`Revoked "${k.name}".`); } catch (e) { setInfo(errorText(e)); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(created!.key); setInfo('Copied.'); } catch { setInfo('Copy failed: select the key and copy it.'); } };
  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3">API keys<HelpTip of="apiKeys" /></Heading>
        <Text size="2" color="gray">
          Keys let scripts and other systems use this gate's API without a username or password. A key belongs to the gate (it keeps working if
          the person who made it leaves) and works only on this gate. <strong>Read only</strong> keys can view and pull; <strong>Admin</strong> keys
          can also make changes and send. No key can change the gate login, users, API keys, or delete the gate's data. Send it as the header{' '}
          <code>Authorization: Bearer &lt;key&gt;</code> to <code>/api/gates/{phone}/…</code>.{' '}
          <Link href="/api/docs" target="_blank" rel="noopener">API documentation ↗</Link> (try calls there with a key).
        </Text>
        {created && (
          <Callout.Root color="green">
            <Callout.Text>
              Key "{created.name}" created. <strong>Copy it now: it won't be shown again.</strong>
              <code style={{ display: 'block', margin: '8px 0', wordBreak: 'break-all', userSelect: 'all' }}>{created.key}</code>
              <Flex gap="2"><Button size="1" onClick={copy}>Copy</Button><Button size="1" variant="soft" color="gray" onClick={() => setCreated(null)}>Done</Button></Flex>
            </Callout.Text>
          </Callout.Root>
        )}
        {keys.length > 0 && (
          <Table.Root size="1">
            <Table.Header>
              <Table.Row>{['Name', 'Role', 'Created', 'Expires', 'Last used', ''].map((h, i) => <Table.ColumnHeaderCell key={i}>{h}</Table.ColumnHeaderCell>)}</Table.Row>
            </Table.Header>
            <Table.Body>
              {keys.map((k) => {
                const expired = Boolean(k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now());
                return (
                  <Table.Row key={k.id} align="center">
                    <Table.Cell>{k.name}</Table.Cell>
                    <Table.Cell>{k.role === 'admin' ? 'Admin' : 'Read only'}</Table.Cell>
                    <Table.Cell>{fmtTime(k.createdAt)} by {k.createdBy}</Table.Cell>
                    <Table.Cell>{k.expiresAt ? <Text color={expired ? 'red' : undefined}>{expired ? 'expired ' : ''}{fmtTime(k.expiresAt)}</Text> : 'never'}</Table.Cell>
                    <Table.Cell>{k.lastUsedAt ? fmtTime(k.lastUsedAt) : 'never'}</Table.Cell>
                    <Table.Cell><Button size="1" variant="soft" color="red" onClick={() => revoke(k)}>Revoke</Button></Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        )}
        <Flex gap="3" align="end" wrap="wrap">
          <Field label="Name"><TextField.Root value={form.name} maxLength={40} placeholder="e.g. Home Assistant" onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Role"><RoleSelect value={form.role} onChange={(r) => setForm({ ...form, role: r })} /></Field>
          <Field label="Expires">
            <Select.Root value={form.expiresDays} onValueChange={(v) => setForm({ ...form, expiresDays: v })}>
              <Select.Trigger />
              <Select.Content>{[['0', 'Never'], ['30', 'In 30 days'], ['90', 'In 90 days'], ['365', 'In 1 year']].map(([v, l]) => <Select.Item key={v} value={v}>{l}</Select.Item>)}</Select.Content>
            </Select.Root>
          </Field>
          <Button onClick={create}>Create API key</Button>
          <Text size="2" color="gray">{info}</Text>
        </Flex>
      </Flex>
    </Card>
  );
}

// Deletes everything this app stores about the gate (database rows for every user and the gate's folder), after a
// warning. Nothing on the gate changes. Afterwards the gate is gone from every list, so the page returns to the list.
function DeleteGateData({ phone, gapi, onDeleted }: { phone: string; gapi: GateApi; onDeleted: () => void }) {
  const [dialog, confirm] = useConfirm();
  const [info, setInfo] = useState('');
  const remove = async () => {
    if (!await confirm({ title: `Delete everything stored about gate ${phone}?`, action: 'Delete all gate data', color: 'red',
      body: 'This permanently deletes, for every account on this computer: the gate and everyone\'s access to it (with its DKS login and master code), '
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

// System Settings: gate login and users (admins), gate configuration, gate settings (working copy), working copy
// files, device association, cameras, debug logs and deleting the gate's stored data. Relay names are on the
// Relays page; dark mode is in User Settings. Read-only users see the gate's configuration and settings, disabled.
export function SystemSettings({ phone, gapi, prefs, defaults, list, cameras, user, emailEnabled, onReload, onSessionChange, onJobStarted }: {
  phone: string; gapi: GateApi; prefs: GatePrefs; defaults: Config; list: ResidentsReply | null; cameras: CameraSettings | null;
  user: string; emailEnabled: boolean; onReload: () => Promise<void>; onSessionChange: () => void; onJobStarted: () => void;
}) {
  const gs = useGateSettings(gapi);
  const readOnly = useReadOnly();
  const reloadAll = async () => { await onReload(); await gs.load(); };
  const shared = (
    <>
      <GateConfig key={`${JSON.stringify(prefs.gateConfig)}-${list?.dirDigits}`} prefs={prefs} defaults={defaults} list={list} gapi={gapi}
        onSaved={async () => { onSessionChange(); await reloadAll(); }} />
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">Gate settings</Heading>
          <GateSettingsEditor gs={gs} view="prefs" gapi={gapi} onReload={onReload} onJobStarted={onJobStarted} />
        </Flex>
      </Card>
    </>
  );
  if (readOnly) {
    return (
      <Flex direction="column" gap="4">
        <Heading>System Settings</Heading>
        <fieldset disabled className="readonly-page"><Flex direction="column" gap="4">
          {shared}
          <DeviceAssociation key={JSON.stringify(prefs.deviceAssociation)} prefs={prefs} gapi={gapi} onSaved={onReload} />
        </Flex></fieldset>
      </Flex>
    );
  }
  return (
    <Flex direction="column" gap="4">
      <Heading>System Settings</Heading>
      <GateLoginCard gapi={gapi} onJobStarted={onJobStarted} />
      <GateUsersCard gapi={gapi} me={user} emailEnabled={emailEnabled} onSessionChange={onSessionChange} />
      <ApiKeysCard phone={phone} gapi={gapi} />
      {shared}
      <WorkingCopyFiles phone={phone} available={Boolean(gs.reply)} />
      <DeviceAssociation key={JSON.stringify(prefs.deviceAssociation)} prefs={prefs} gapi={gapi} onSaved={onReload} />
      <CameraForm key={JSON.stringify(cameras)} settings={cameras} phone={phone} gapi={gapi} onSaved={onReload} />
      <DebugLogs />
      <DeleteGateData phone={phone} gapi={gapi} onDeleted={onSessionChange} />
    </Flex>
  );
}
