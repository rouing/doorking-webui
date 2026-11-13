import { useEffect, useState, type FormEvent } from 'react';
import { Button, Callout, Card, Container, Flex, Heading, Link, Separator, Text, TextField } from '@radix-ui/themes';
import { HelpTip } from './HelpTip.tsx';
import type { GateInfo } from '../../src/types.ts';
import { api, errorText } from './api.ts';
import { useConfirm } from './Confirm.tsx';
import type { SignedIn } from './App.tsx';

export const gateLabel = (g: GateInfo) => g.siteName || `Gate ${g.phoneNumber}`;

// The signed-in user's gate list: open, remove, or add a gate (system phone + master code).
export function Gates({ session, onChange }: { session: SignedIn; onChange: () => void }) {
  const [gates, setGates] = useState<GateInfo[] | null>(null);
  const [error, setError] = useState('');
  const [phoneNumber, setPhone] = useState('');
  const [masterCode, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, confirm] = useConfirm();

  const load = () => api<{ gates: GateInfo[] }>('GET', '/api/gates').then((r) => setGates(r.gates), (e) => setError(errorText(e)));
  useEffect(() => { load(); }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); } catch (e) { setError(errorText(e)); }
  };

  const open = (g: GateInfo) => run(async () => { await api('PUT', '/api/session/gate', { phoneNumber: g.phoneNumber }); onChange(); });

  const remove = async (g: GateInfo) => {
    if (!await confirm({ title: `Remove ${gateLabel(g)} from your list?`, body: 'Its downloaded files and preferences are kept.',
      action: 'Remove', color: 'red' })) return;
    await run(() => api('DELETE', `/api/gates/${encodeURIComponent(g.phoneNumber)}`));
    load();
  };

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await run(async () => { await api('POST', '/api/gates', { phoneNumber, masterCode }); setPhone(''); setCode(''); await load(); });
    setBusy(false);
  }

  const signOut = () => run(async () => { await api('DELETE', '/api/session'); onChange(); });

  return (
    <Container size="2" p="6">
      {dialog}
      <Card size="3">
        <Flex align="center" gap="3" mb="4">
          <Heading>Your gates</Heading>
          <Text color="gray">{session.user}</Text>
          <Flex flexGrow="1" />
          <Link href="/help" target="_blank" rel="noopener" size="2">Help</Link>
          <Button variant="soft" color="gray" onClick={signOut}>Sign out</Button>
        </Flex>
        {gates && !gates.length && <Text color="gray">No gates yet. Add one with its system phone number and master code.</Text>}
        <Flex direction="column" gap="2">
          {(gates || []).map((g) => (
            <Flex key={g.phoneNumber} align="center" gap="3">
              <Flex direction="column" flexGrow="1">
                <Text weight="medium">{gateLabel(g)}</Text>
                <Text size="1" color="gray">{g.verified ? g.phoneNumber : `${g.phoneNumber} · not connected yet`}</Text>
              </Flex>
              <Button onClick={() => open(g)}>Open</Button>
              <Button variant="soft" color="gray" onClick={() => remove(g)}>Remove</Button>
            </Flex>
          ))}
        </Flex>
        {error && <Callout.Root color="red" mt="3"><Callout.Text>{error}</Callout.Text></Callout.Root>}
        <Separator size="4" my="4" />
        <form onSubmit={add} autoComplete="off">
          <Flex direction="column" gap="3">
            <Heading size="3">Add a gate</Heading>
            <label>
              <Text size="2" weight="medium">System phone<HelpTip of="systemPhone" /></Text>
              <TextField.Root value={phoneNumber} onChange={(e) => setPhone(e.target.value)} required inputMode="tel" />
            </label>
            <label>
              <Text size="2" weight="medium">Master code<HelpTip of="gateMasterCode" /></Text>
              <TextField.Root type="password" value={masterCode} onChange={(e) => setCode(e.target.value)} required
                inputMode="numeric" maxLength={4} autoComplete="off" />
            </label>
            <Text size="1" color="gray">The gate is listed under its Site name from System Settings → Gate configuration.</Text>
            <Flex><Button type="submit" loading={busy}>Add gate</Button></Flex>
          </Flex>
        </form>
      </Card>
    </Container>
  );
}
