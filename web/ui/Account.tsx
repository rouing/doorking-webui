import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Badge, Button, Callout, Card, Checkbox, Container, Flex, Heading, Table, Text, TextField } from '@radix-ui/themes';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import type { PasskeyInfo, SessionReply } from '../../src/types.ts';
import { api, errorText } from './api.ts';
import { useConfirm } from './Confirm.tsx';
import { fmtTime } from './format.ts';

const MIN = 12;

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return <label><Text size="2" weight="medium">{label}</Text>{children}</label>;
}

// A readable message for a failed passkey step (the browser's "not allowed" also means the user cancelled).
export function passkeyError(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'The passkey request was cancelled or timed out.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  return errorText(e);
}

// The user's passkeys: add (after confirming the password), rename, remove. Passkeys work on the site name they were
// made on: the public HTTPS name, or localhost on the server.
function Passkeys() {
  const [list, setList] = useState<PasskeyInfo[]>([]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, confirm] = useConfirm();
  const load = () => api<{ passkeys: PasskeyInfo[] }>('GET', '/api/me/passkeys').then((r) => setList(r.passkeys), (e) => setInfo(errorText(e)));
  useEffect(() => { load(); }, []);
  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setInfo('Follow your browser\'s prompt…');
    try {
      const optionsJSON = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('POST', '/api/me/passkeys/options', { password });
      setPassword('');
      const response = await startRegistration({ optionsJSON });
      setList((await api<{ passkeys: PasskeyInfo[] }>('POST', '/api/me/passkeys', { name: name.trim(), response })).passkeys);
      setName('');
      setInfo('Passkey added. You can now use "Sign in with a passkey".');
    } catch (err) { setInfo(passkeyError(err)); }
    setBusy(false);
  }
  const rename = async (p: PasskeyInfo) => {
    const next = window.prompt('Name for this passkey', p.name);
    if (next === null || !next.trim() || next.trim() === p.name) return;
    try { setList((await api<{ passkeys: PasskeyInfo[] }>('PUT', `/api/me/passkeys/${encodeURIComponent(p.id)}`, { name: next.trim() })).passkeys); } catch (e) { setInfo(errorText(e)); }
  };
  const remove = async (p: PasskeyInfo) => {
    if (!await confirm({ title: `Remove the passkey "${p.name}"?`, action: 'Remove', color: 'red',
      body: 'It will no longer sign you in. Also delete it from the device or password manager that holds it.' })) return;
    try { setList((await api<{ passkeys: PasskeyInfo[] }>('DELETE', `/api/me/passkeys/${encodeURIComponent(p.id)}`)).passkeys); setInfo(`Removed "${p.name}".`); } catch (e) { setInfo(errorText(e)); }
  };
  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3">Passkeys</Heading>
        <Text size="2" color="gray">
          Sign in with your fingerprint, face or device PIN instead of typing your password. Your password keeps working too. A passkey works
          on the address it was added on ({window.location.host}).
        </Text>
        {list.length > 0 && (
          <Table.Root size="1">
            <Table.Header>
              <Table.Row>{['Name', 'Works on', 'Added', 'Last used', ''].map((h, i) => <Table.ColumnHeaderCell key={i}>{h}</Table.ColumnHeaderCell>)}</Table.Row>
            </Table.Header>
            <Table.Body>
              {list.map((p) => (
                <Table.Row key={p.id} align="center">
                  <Table.Cell>{p.name}{p.synced && <Badge ml="2" color="gray" title="Backed up by your passkey provider, so it is on your other devices too">synced</Badge>}</Table.Cell>
                  <Table.Cell>{p.site}</Table.Cell>
                  <Table.Cell>{fmtTime(p.createdAt)}</Table.Cell>
                  <Table.Cell>{p.lastUsedAt ? fmtTime(p.lastUsedAt) : 'never'}</Table.Cell>
                  <Table.Cell><Flex gap="2">
                    <Button size="1" variant="soft" color="gray" onClick={() => rename(p)}>Rename</Button>
                    <Button size="1" variant="soft" color="red" onClick={() => remove(p)}>Remove</Button>
                  </Flex></Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        )}
        {browserSupportsWebAuthn() ? (
          <form onSubmit={add} autoComplete="off">
            <Flex gap="3" align="end" wrap="wrap">
              <Labelled label="Name (e.g. iPhone, YubiKey)"><TextField.Root value={name} maxLength={40} onChange={(e) => setName(e.target.value)} /></Labelled>
              <Labelled label="Your current password"><TextField.Root type="password" value={password} required autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)} /></Labelled>
              <Button type="submit" loading={busy}>Add a passkey</Button>
            </Flex>
          </form>
        ) : <Text size="2" color="gray">This browser doesn't support passkeys.</Text>}
        {info && <Text size="2" color="gray">{info}</Text>}
      </Flex>
    </Card>
  );
}

// New password twice; returns an error message, or '' when they are fine.
const passwordProblem = (pw: string, again: string) => (pw.length < MIN ? `The password must be at least ${MIN} characters.`
  : pw !== again ? 'The two passwords differ.' : '');

// The page an email link opens (#verify=, #reset=, #invite= in the address): confirms the email, or asks for a new
// password (reset) or the first one (invitation, which also signs in). onDone clears the link and reloads the session.
export function EmailLink({ kind, token, onDone }: { kind: 'verify' | 'reset' | 'invite'; token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [username, setUsername] = useState('');
  const [state, setState] = useState<{ ok?: string; error?: string }>({});
  const [busy, setBusy] = useState(kind !== 'reset');
  useEffect(() => {
    if (kind === 'verify') {
      api<{ email: string }>('POST', '/api/email/verify', { token })
        .then((r) => setState({ ok: `Your email ${r.email} is confirmed.` }), (e) => setState({ error: errorText(e) })).finally(() => setBusy(false));
    } else if (kind === 'invite') {
      api<{ username: string }>('POST', '/api/invite/check', { token }).then((r) => setUsername(r.username), (e) => setState({ error: errorText(e) }))
        .finally(() => setBusy(false));
    }
  }, [kind, token]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = passwordProblem(password, again);
    if (problem) { setState({ error: problem }); return; }
    setBusy(true);
    try {
      if (kind === 'invite') { await api('POST', '/api/invite', { token, password }); onDone(); return; }
      const r = await api<{ username: string }>('POST', '/api/password-reset', { token, password });
      setState({ ok: `Your password is changed, ${r.username}. You were signed out everywhere; sign in with the new password.` });
    } catch (err) { setState({ error: errorText(err) }); }
    setBusy(false);
  }
  const title = kind === 'verify' ? 'Confirm your email' : kind === 'reset' ? 'Choose a new password' : 'Welcome';
  const asksPassword = !state.ok && (kind === 'reset' || (kind === 'invite' && username));
  return (
    <Container size="1" p="6">
      <Card size="3">
        <form onSubmit={submit} autoComplete="off">
          <Flex direction="column" gap="3">
            <Heading>{title}</Heading>
            {kind === 'invite' && username && !state.ok && <Text color="gray">Your username is <strong>{username}</strong>. Choose a password to finish setting up your account.</Text>}
            {asksPassword && (
              <>
                <Labelled label={`New password (at least ${MIN} characters)`}>
                  <TextField.Root type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
                </Labelled>
                <Labelled label="New password again">
                  <TextField.Root type="password" value={again} onChange={(e) => setAgain(e.target.value)} required autoComplete="new-password" />
                </Labelled>
                <Button type="submit" loading={busy}>{kind === 'invite' ? 'Save and sign in' : 'Save new password'}</Button>
              </>
            )}
            {busy && kind !== 'reset' && !username && <Text color="gray">Checking the link…</Text>}
            {state.ok && <Callout.Root color="green"><Callout.Text>{state.ok}</Callout.Text></Callout.Root>}
            {state.error && <Callout.Root color="red"><Callout.Text>{state.error}</Callout.Text></Callout.Root>}
            {(state.ok || state.error) && <Flex><Button type="button" variant="soft" onClick={onDone}>Continue</Button></Flex>}
          </Flex>
        </form>
      </Card>
    </Container>
  );
}

// "Forgot your password?": sends a reset link to the account's confirmed email. The reply never says whether the
// account exists.
export function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [id, setId] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { setInfo((await api<{ message: string }>('POST', '/api/password-reset/request', { identifier: id })).message); } catch (err) { setInfo(errorText(err)); }
    setBusy(false);
  }
  return (
    <form onSubmit={submit} autoComplete="off">
      <Flex direction="column" gap="3">
        <Text color="gray">Enter your username or confirmed email. We'll email you a link to choose a new password.</Text>
        <TextField.Root value={id} onChange={(e) => setId(e.target.value)} required placeholder="Username or email" />
        <Flex gap="3"><Button type="submit" loading={busy}>Send reset link</Button><Button type="button" variant="soft" color="gray" onClick={onBack}>Back to sign in</Button></Flex>
        {info && <Callout.Root><Callout.Text>{info}</Callout.Text></Callout.Root>}
      </Flex>
    </form>
  );
}

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
type SignedIn = Extract<SessionReply, { loggedIn: true }>;

export function UserSettings({ session, onSaved }: { session: SignedIn; onSaved: () => void }) {
  const [email, setEmail] = useState(session.pendingEmail || session.email);
  const [info, setInfo] = useState('');
  const save = async (body: Record<string, unknown>, done: string) => {
    try { await api('PUT', '/api/me', body); setInfo(done); onSaved(); } catch (e) { setInfo(`Not saved: ${errorText(e)}`); }
  };
  const resend = async () => {
    try { await api('POST', '/api/me/email/resend', {}); setInfo(`Confirmation link sent again to ${session.pendingEmail}.`); } catch (e) { setInfo(errorText(e)); }
  };
  const next = email.trim().toLowerCase();
  return (
    <Flex direction="column" gap="4">
      <Heading>User Settings</Heading>
      <Text size="2" color="gray">Settings for your account, <strong>{session.user}</strong>. They follow you to any browser you sign in from.</Text>
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">Appearance</Heading>
          <Text as="label" size="2"><Flex gap="2" align="center">
            <Checkbox checked={session.dark} onCheckedChange={(v) => save({ dark: v === true }, '')} /> Dark mode
          </Flex></Text>
        </Flex>
      </Card>
      <Card>
        <Flex direction="column" gap="3" style={{ maxWidth: 480 }}>
          <Heading size="3">Email</Heading>
          <Text size="2" color="gray">
            Used for password resets, security alerts and notifications. Each email can belong to one account only. A new address works
            once you open the confirmation link sent to it.
          </Text>
          {session.email && <Text size="2">Confirmed: <strong>{session.email}</strong> <Badge color="green">confirmed</Badge></Text>}
          {session.pendingEmail && (
            <Flex gap="2" align="center" wrap="wrap">
              <Text size="2">Waiting for confirmation: <strong>{session.pendingEmail}</strong> <Badge color="amber">check your inbox</Badge></Text>
              {session.emailEnabled && <Button size="1" variant="soft" onClick={resend}>Send the link again</Button>}
            </Flex>
          )}
          {!session.emailEnabled && <Text size="2" color="amber">This server can't send email yet, so addresses can't be confirmed for now.</Text>}
          <TextField.Root type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Flex gap="3" align="center">
            <Button onClick={() => save({ email: next }, !next ? 'Email removed.' : next === session.email ? 'Saved.' : `Saved. Open the link we sent to ${next} to confirm it.`)}>Save email</Button>
            <Text size="2" color="gray">{info}</Text>
          </Flex>
        </Flex>
      </Card>
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="3">Email notifications</Heading>
          <Text size="2" color="gray">Sent to your confirmed email. Security emails (password or passkey changes, password resets) are always sent.</Text>
          <Text as="label" size="2"><Flex gap="2" align="center">
            <Checkbox checked={session.notifyAccess} onCheckedChange={(v) => save({ notifyAccess: v === true }, '')} />
            When I'm given access to a gate, removed from one, or my role changes
          </Flex></Text>
          <Text as="label" size="2"><Flex gap="2" align="center">
            <Checkbox checked={session.notifyAlerts} onCheckedChange={(v) => save({ notifyAlerts: v === true }, '')} />
            Gate alerts for gates I'm admin of (a send or scheduled transfer failed)
          </Flex></Text>
        </Flex>
      </Card>
      <Passkeys />
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
