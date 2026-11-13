import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Badge, Button, Callout, Card, Container, Flex, Grid, Heading, Link, Select, Separator, Text, TextField } from '@radix-ui/themes';
import type { GateInfo, Job } from '../../src/types.ts';
import { api, errorText } from './api.ts';
import { useConfirm } from './Confirm.tsx';
import { UserSettings } from './Account.tsx';
import { Field } from './panes/fields.tsx';
import { CONFIG_KEYS, CONFIG_LABELS, CONFIG_OPTIONS } from './settings/GateConfig.tsx';
import type { SignedIn } from './App.tsx';

export const gateLabel = (g: GateInfo) => g.siteName || `Gate ${g.phoneNumber}`;
export const roleLabel = (r: GateInfo['role']) => (r === 'admin' ? 'Admin' : 'Read only');

// Adds a gate: its phone, master code, DKS login and gate configuration. The server checks the DKS login, then pulls
// residents with these values; the gate is added (with this user as its admin) only when that pull succeeds.
function AddGate({ session, onAdded }: { session: SignedIn; onAdded: () => void }) {
  const [f, setF] = useState({ phoneNumber: '', masterCode: '', dksUser: '', dksPassword: '' });
  const [cfg, setCfg] = useState<Record<string, string>>(() => Object.fromEntries(CONFIG_KEYS.map((k) => [k, session.defaults[k] || ''])));
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  // Polls the checking pull every 3 s while it runs.
  const poll = async () => {
    clearTimeout(timer.current);
    const r = await api<{ job: Job | null }>('GET', '/api/gate-add').catch(() => null);
    const j = r ? r.job : null;
    setJob(j);
    if (j && j.state === 'running') { timer.current = setTimeout(poll, 3000); return; }
    setBusy(false);
    if (j && j.state === 'done') { setF({ phoneNumber: '', masterCode: '', dksUser: '', dksPassword: '' }); onAdded(); }
  };
  useEffect(() => { poll(); return () => clearTimeout(timer.current); }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('POST', '/api/gates', { ...f, gateConfig: cfg });
      setJob(null);
      poll();
    } catch (err) { setError(errorText(err)); setBusy(false); }
  }

  const running = job && job.state === 'running';
  return (
    <form onSubmit={add} autoComplete="off">
      <Flex direction="column" gap="3">
        <Heading size="3">Add a gate</Heading>
        <Text size="2" color="gray">
          Enter the gate's details. The app signs in to DKS Cloud with the gate's DKS login and pulls the residents; only when that works is the
          gate added, with you as its admin. If the gate is already managed here, ask one of its gate admins to add you instead.
        </Text>
        <Grid columns={{ initial: '1', sm: '2' }} gap="3">
          <Field label="System phone" help="systemPhone">
            <TextField.Root value={f.phoneNumber} onChange={(e) => set('phoneNumber', e.target.value)} required inputMode="tel" disabled={busy} />
          </Field>
          <Field label="Master code" help="gateMasterCode">
            <TextField.Root type="password" value={f.masterCode} onChange={(e) => set('masterCode', e.target.value)} required inputMode="numeric"
              maxLength={4} autoComplete="off" disabled={busy} />
          </Field>
          <Field label="DKS user" help="dksLogin">
            <TextField.Root value={f.dksUser} onChange={(e) => set('dksUser', e.target.value)} required autoComplete="off" disabled={busy} />
          </Field>
          <Field label="DKS password" help="dksLogin">
            <TextField.Root type="password" value={f.dksPassword} onChange={(e) => set('dksPassword', e.target.value)} required
              autoComplete="new-password" disabled={busy} />
          </Field>
        </Grid>
        <Text size="2" weight="medium">Gate configuration (must match the gate)</Text>
        <Grid columns={{ initial: '1', sm: '2', md: '3' }} gap="3">
          {CONFIG_KEYS.map((k) => (
            <Field key={k} label={CONFIG_LABELS[k]} help={k}>
              {CONFIG_OPTIONS[k] ? (
                <Select.Root value={cfg[k]} onValueChange={(v) => setCfg({ ...cfg, [k]: v })} disabled={busy}>
                  <Select.Trigger />
                  <Select.Content>{CONFIG_OPTIONS[k]!.map((o) => <Select.Item key={o} value={o}>{o}</Select.Item>)}</Select.Content>
                </Select.Root>
              ) : <TextField.Root value={cfg[k]} maxLength={40} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} disabled={busy} />}
            </Field>
          ))}
        </Grid>
        <Flex gap="3" align="center"><Button type="submit" loading={busy}>Add gate</Button></Flex>
        {error && <Callout.Root color="red"><Callout.Text>{error}</Callout.Text></Callout.Root>}
        {job && (
          <Callout.Root color={running ? 'blue' : job.state === 'done' ? 'green' : 'red'}>
            <Callout.Text>
              {running ? `Checking gate ${job.phoneNumber}: ${job.log.length ? job.log[job.log.length - 1].replace(/^\S+\s+\S+\s+/, '') : 'starting…'}`
                : job.state === 'done' ? `Gate ${job.phoneNumber} added. You are its admin.`
                  : `Gate ${job.phoneNumber} was not added: ${job.error || 'the check failed'}`}
            </Callout.Text>
          </Callout.Root>
        )}
      </Flex>
    </form>
  );
}

// The signed-in user's gates (open or leave one), User Settings, and adding a gate.
export function Gates({ session, onChange }: { session: SignedIn; onChange: () => void }) {
  const [gates, setGates] = useState<GateInfo[] | null>(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [dialog, confirm] = useConfirm();

  const load = () => api<{ gates: GateInfo[] }>('GET', '/api/gates').then((r) => setGates(r.gates), (e) => setError(errorText(e)));
  useEffect(() => { load(); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); } catch (e) { setError(errorText(e)); }
  };

  const open = (g: GateInfo) => run(async () => { await api('PUT', '/api/session/gate', { phoneNumber: g.phoneNumber }); onChange(); });

  const leave = async (g: GateInfo) => {
    if (!await confirm({ title: `Leave ${gateLabel(g)}?`, action: 'Leave', color: 'red',
      body: 'You will no longer see this gate. Its data stays for its other users. A gate admin can add you again.' })) return;
    await run(() => api('DELETE', `/api/gates/${encodeURIComponent(g.phoneNumber)}`));
    load();
  };

  const signOut = () => run(async () => { await api('DELETE', '/api/session'); onChange(); });

  return (
    <Container size="3" p="6">
      {dialog}
      <Card size="3">
        <Flex align="center" gap="3" mb="4">
          <Heading>{settings ? 'User Settings' : 'Your gates'}</Heading>
          <Text color="gray">{session.user}</Text>
          <Flex flexGrow="1" />
          <Link href="/help" target="_blank" rel="noopener" size="2">Help</Link>
          <Button variant="soft" color="gray" onClick={() => setSettings(!settings)}>{settings ? 'Back to gates' : 'User settings'}</Button>
          <Button variant="soft" color="gray" onClick={signOut}>Sign out</Button>
        </Flex>
        {settings ? <UserSettings user={session.user} email={session.email} dark={session.dark} onSaved={onChange} /> : (
          <>
            {gates && !gates.length && <Text color="gray">No gates yet. Add one below, or ask a gate admin to add you to theirs.</Text>}
            <Flex direction="column" gap="2">
              {(gates || []).map((g) => (
                <Flex key={g.phoneNumber} align="center" gap="3">
                  <Flex direction="column" flexGrow="1">
                    <Text weight="medium">{gateLabel(g)}</Text>
                    <Text size="1" color="gray">{g.phoneNumber}</Text>
                  </Flex>
                  <Badge color={g.role === 'admin' ? 'blue' : 'gray'}>{roleLabel(g.role)}</Badge>
                  <Button onClick={() => open(g)}>Open</Button>
                  <Button variant="soft" color="gray" onClick={() => leave(g)}>Leave</Button>
                </Flex>
              ))}
            </Flex>
            {error && <Callout.Root color="red" mt="3"><Callout.Text>{error}</Callout.Text></Callout.Root>}
            <Separator size="4" my="4" />
            <AddGate session={session} onAdded={load} />
          </>
        )}
      </Card>
    </Container>
  );
}
