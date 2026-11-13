import { useState, type FormEvent } from 'react';
import { Button, Callout, Card, Checkbox, Container, Flex, Heading, Link, Text, TextField } from '@radix-ui/themes';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import type { SsoProviderInfo } from '../../src/types.ts';
import { api, errorText, lsGet, lsSet } from './api.ts';
import { ForgotPassword, passkeyError, startSso } from './Account.tsx';

// Sign in with a local account (gate admins create them), a passkey, or a single sign-on provider. "Remember user"
// keeps only the username in this browser.
export function Login({ onSignedIn, emailEnabled, sso }: { onSignedIn: () => void; emailEnabled: boolean; sso: SsoProviderInfo[] }) {
  const [forgot, setForgot] = useState(false);
  const [remember, setRemember] = useState(() => lsGet('dk-remember-user', false));
  const [user, setUser] = useState(() => (remember ? lsGet('dk-user', '') : ''));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Passkey sign-in: no username needed, the browser offers this site's passkeys.
  async function withPasskey() {
    setBusy(true);
    setError('');
    try {
      const optionsJSON = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>('POST', '/api/passkey/options', {});
      const response = await startAuthentication({ optionsJSON });
      await api('POST', '/api/passkey/session', { response });
      onSignedIn();
    } catch (err) { setError(passkeyError(err)); }
    setBusy(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', '/api/session', { user, password });
      lsSet('dk-remember-user', remember);
      lsSet('dk-user', remember ? user : '');
      setPassword('');
      onSignedIn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Container size="1" p="6">
      <Card size="3">
        {forgot ? <><Heading mb="3">Reset your password</Heading><ForgotPassword onBack={() => setForgot(false)} /></> : (
        <form onSubmit={submit} autoComplete="off">
          <Flex direction="column" gap="3">
            <Heading>DoorKing Gate Data</Heading>
            <Text color="gray">Sign in with the account a gate admin created for you. New here? Read the <Link href="/help" target="_blank" rel="noopener">user guide</Link>.</Text>
            <label>
              <Text size="2" weight="medium">Username</Text>
              <TextField.Root value={user} onChange={(e) => setUser(e.target.value)} required autoComplete="username" />
            </label>
            <Text as="label" size="2">
              <Flex gap="2" align="center">
                <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} /> Remember user
              </Flex>
            </Text>
            <label>
              <Text size="2" weight="medium">Password</Text>
              <TextField.Root type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
                autoComplete="current-password" />
            </label>
            <Button type="submit" loading={busy}>Sign in</Button>
            {browserSupportsWebAuthn() && <Button type="button" variant="soft" disabled={busy} onClick={withPasskey}>Sign in with a passkey</Button>}
            {sso.map((p) => (
              <Button key={p.id} type="button" variant="soft" disabled={busy}
                onClick={() => { setError(''); startSso('/api/sso/start', { provider: p.id }).catch((e) => setError(errorText(e))); }}>
                Sign in with {p.name}
              </Button>
            ))}
            {emailEnabled && <Link href="#" size="2" onClick={(e) => { e.preventDefault(); setForgot(true); }}>Forgot your password?</Link>}
            {error && <Callout.Root color="red"><Callout.Text>{error}</Callout.Text></Callout.Root>}
          </Flex>
        </form>
        )}
      </Card>
    </Container>
  );
}
