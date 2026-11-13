import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Callout, Card, Checkbox, Container, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import { api, errorText } from './api.ts';

const MIN = 12;

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return <label><Text size="2" weight="medium">{label}</Text>{children}</label>;
}

// New password twice; returns an error message, or '' when they are fine.
const passwordProblem = (pw: string, again: string) => (pw.length < MIN ? `The password must be at least ${MIN} characters.`
  : pw !== again ? 'The two passwords differ.' : '');

// First start: no account exists yet. The first account becomes admin of every gate already on this server.
export function FirstSetup({ onDone }: { onDone: () => void }) {
  const [setupCode, setSetupCode] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(password, again);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError('');
    try { await api('POST', '/api/setup', { setupCode, username, password, email }); onDone(); } catch (err) { setError(errorText(err)); }
    setBusy(false);
  }
  return (
    <Container size="1" p="6">
      <Card size="3">
        <form onSubmit={submit} autoComplete="off">
          <Flex direction="column" gap="3">
            <Heading>Create the first account</Heading>
            <Text color="gray">
              No account exists on this server yet. This first account becomes the admin of every gate already here. After that,
              gate admins create accounts for the people who use their gates.
            </Text>
            <Labelled label="Setup code (printed in the server's log when it starts)">
              <TextField.Root value={setupCode} onChange={(e) => setSetupCode(e.target.value)} required autoComplete="off" />
            </Labelled>
            <Labelled label="Username"><TextField.Root value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" /></Labelled>
            <Labelled label="Email (optional)"><TextField.Root type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Labelled>
            <Labelled label={`Password (at least ${MIN} characters)`}>
              <TextField.Root type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
            </Labelled>
            <Labelled label="Password again">
              <TextField.Root type="password" value={again} onChange={(e) => setAgain(e.target.value)} required autoComplete="new-password" />
            </Labelled>
            <Button type="submit" loading={busy}>Create account</Button>
            {error && <Callout.Root color="red"><Callout.Text>{error}</Callout.Text></Callout.Root>}
          </Flex>
        </form>
      </Card>
    </Container>
  );
}

// Current password and a new one twice. onChanged runs after the server accepted it.
function PasswordForm({ onChanged, submitLabel }: { onChanged: () => void; submitLabel: string }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(password, again);
    if (problem) { setInfo(problem); return; }
    setBusy(true);
    try {
      await api('PUT', '/api/me/password', { current, password });
      setCurrent(''); setPassword(''); setAgain('');
      setInfo('Password changed. You were signed out everywhere else.');
      onChanged();
    } catch (err) { setInfo(errorText(err)); }
    setBusy(false);
  }
  return (
    <form onSubmit={submit} autoComplete="off">
      <Flex direction="column" gap="3" style={{ maxWidth: 360 }}>
        <Labelled label="Current password">
          <TextField.Root type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
        </Labelled>
        <Labelled label={`New password (at least ${MIN} characters)`}>
          <TextField.Root type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
        </Labelled>
        <Labelled label="New password again">
          <TextField.Root type="password" value={again} onChange={(e) => setAgain(e.target.value)} required autoComplete="new-password" />
        </Labelled>
        <Flex gap="3" align="center"><Button type="submit" loading={busy}>{submitLabel}</Button><Text size="2" color="gray">{info}</Text></Flex>
      </Flex>
    </form>
  );
}

// After a gate admin (or the server's operator) set this account's password: the user picks their own first.
export function ForcedPasswordChange({ user, onDone }: { user: string; onDone: () => void }) {
  const signOut = async () => { await api('DELETE', '/api/session').catch(() => {}); onDone(); };
  return (
    <Container size="1" p="6">
      <Card size="3">
        <Flex direction="column" gap="3">
          <Heading>Choose your password</Heading>
          <Text color="gray">
            Signed in as <strong>{user}</strong> with a password someone else set. Choose your own to continue. Nobody else can see or change it.
          </Text>
          <PasswordForm submitLabel="Save my password" onChanged={onDone} />
          <Flex><Button variant="ghost" color="gray" onClick={signOut}>Sign out</Button></Flex>
        </Flex>
      </Card>
    </Container>
  );
}

// The signed-in user's own settings: dark mode, email and password. onSaved reloads the session (dark mode).
export function UserSettings({ user, email: savedEmail, dark, onSaved }: { user: string; email: string; dark: boolean; onSaved: () => void }) {
  const [email, setEmail] = useState(savedEmail);
  const [info, setInfo] = useState('');
  const save = async (body: { email?: string; dark?: boolean }, done: string) => {
    try { await api('PUT', '/api/me', body); setInfo(done); onSaved(); } catch (e) { setInfo(`Not saved: ${errorText(e)}`); }
  };
  return (
    <Flex direction="column" gap="4">
      <Heading>User Settings</Heading>
      <Text size="2" color="gray">Settings for your account, <strong>{user}</strong>. They follow you to any browser you sign in from.</Text>
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">Appearance</Heading>
          <Text as="label" size="2"><Flex gap="2" align="center">
            <Checkbox checked={dark} onCheckedChange={(v) => save({ dark: v === true }, '')} /> Dark mode
          </Flex></Text>
        </Flex>
      </Card>
      <Card>
        <Flex direction="column" gap="3" style={{ maxWidth: 360 }}>
          <Heading size="3">Email</Heading>
          <Text size="2" color="gray">Optional. Each email can belong to one account only. It will be used to recover a forgotten password once that is available.</Text>
          <TextField.Root type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Flex gap="3" align="center">
            <Button onClick={() => save({ email: email.trim() }, email.trim() ? 'Email saved.' : 'Email removed.')}>Save email</Button>
            <Text size="2" color="gray">{info}</Text>
          </Flex>
        </Flex>
      </Card>
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">Password</Heading>
          <Text size="2" color="gray">Only you can change your password. Changing it signs you out on every other browser.</Text>
          <PasswordForm submitLabel="Change password" onChanged={() => {}} />
        </Flex>
      </Card>
    </Flex>
  );
}
