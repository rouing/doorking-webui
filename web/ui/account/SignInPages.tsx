/**
 * @module web/ui/account/SignInPages
 *
 * Pages shown before a normal sign-in: email links, forgotten password, first setup, forced password change.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert, Button, Card, CardContent, CircularProgress, Container, Stack, TextField, Typography,
} from '@mui/material';
import type { SsoProviderInfo } from '../../../src/types.ts';
import { api, errorText } from '../api.ts';
import { Field } from '../panes/fields.tsx';
import { startSso } from './SingleSignOn.tsx';
import { PasswordForm, passwordProblem } from './passwords.tsx';
import { PASSWORD_MIN } from '../../../src/shared.ts';

const authContainerSx = {
  pt: 'calc(env(safe-area-inset-top) + 32px)',
  pb: 'calc(env(safe-area-inset-bottom) + 32px)',
  pl: 'calc(env(safe-area-inset-left) + 16px)',
  pr: 'calc(env(safe-area-inset-right) + 16px)',
};

interface EmailLinkProps {
  kind: 'verify' | 'reset' | 'invite';
  token: string;
  onDone: () => void;
  sso?: SsoProviderInfo[];
}

/**
 * The page an email link opens (#verify=, #reset=, #invite= in the address): confirms the email, or asks for a new
 * password (reset) or the first one (invitation, which also signs in; or accept it with a single sign-on provider, sso).
 * onDone clears the link and reloads the session.
 *
 * @param props - Component props.
 * @param props.kind - Item or operation kind.
 * @param props.token - One-time link token or session token.
 * @param props.onDone - Callback invoked when the action completes.
 * @param [props.sso] - Per-server SSO providers.
 * @returns Rendered React element.
 */
export function EmailLink({ kind, token, onDone, sso = [] }: EmailLinkProps) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [isResident, setIsResident] = useState(false);
  const [state, setState] = useState<{ ok?: string; error?: string }>({});
  const [busy, setBusy] = useState(kind !== 'reset');
  useEffect(() => {
    if (kind === 'verify') {
      api<{ email: string }>('POST', '/api/email/verify', { token })
        .then((reply) => setState({ ok: `Your email ${reply.email} is confirmed.` }), (err) => setState({ error: errorText(err) }))
        .finally(() => setBusy(false));
      return;
    }
    if (kind === 'invite') {
      api<{ username: string; email?: string; isResident?: boolean }>('POST', '/api/invite/check', { token })
        .then((reply) => { setUsername(reply.username); setEmail(reply.email || ''); setIsResident(Boolean(reply.isResident)); },
          (err) => setState({ error: errorText(err) }))
        .finally(() => setBusy(false));
    }
  }, [kind, token]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = passwordProblem(password, again);
    if (problem) { setState({ error: problem }); return; }
    setBusy(true);
    try {
      if (kind === 'invite') { await api('POST', '/api/invite', { token, password }); onDone(); return; }
      const reply = await api<{ username: string }>('POST', '/api/password-reset', { token, password });
      setState({ ok: `Your password is changed, ${reply.username}. You were signed out everywhere; sign in with the new password.` });
    } catch (err) { setState({ error: errorText(err) }); }
    setBusy(false);
  }
  const title = kind === 'verify' ? 'Confirm your email' : kind === 'reset' ? 'Choose a new password' : 'Welcome';
  const asksPassword = !state.ok && (kind === 'reset' || (kind === 'invite' && username));
  return (
    <Container maxWidth="xs" sx={authContainerSx}>
      <Card>
        <CardContent sx={{ p: { xs: 2.5, sm: 3.5 } }}>
          <form onSubmit={submit} autoComplete="off">
            <Stack spacing={2}>
              <Typography variant="h5" component="h1">{title}</Typography>
              {kind === 'invite' && username && !state.ok && (
                isResident
                  ? <Typography variant="body2" color="text.secondary">Welcome! You will sign in with <strong>{email || username}</strong>. Choose a password to activate your Resident Portal.</Typography>
                  : <Typography variant="body2" color="text.secondary">Your username is <strong>{username}</strong>. Choose a password to finish setting up your account.</Typography>
              )}
              {asksPassword && (
                <>
                  <Field label={`New password (at least ${PASSWORD_MIN} characters)`}>
                    <TextField type="password" size="small" fullWidth value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" />
                  </Field>
                  <Field label="New password again">
                    <TextField type="password" size="small" fullWidth value={again} onChange={(event) => setAgain(event.target.value)} required autoComplete="new-password" />
                  </Field>
                  <Button type="submit" variant="contained" fullWidth disabled={busy}
                    startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
                    {kind === 'invite' ? 'Save and sign in' : 'Save new password'}
                  </Button>
                  {kind === 'invite' && !isResident && sso.length > 0 && (
                    <>
                      <Typography variant="body2" color="text.secondary">Or skip the password and sign in with your work account:</Typography>
                      {sso.map((provider) => (
                        <Button key={provider.id} type="button" variant="outlined" fullWidth disabled={busy}
                          onClick={() => startSso('/api/sso/start', { provider: provider.id, invite: token }).catch((err) => setState({ error: errorText(err) }))}>
                          Accept with {provider.name}
                        </Button>
                      ))}
                    </>
                  )}
                </>
              )}
              {busy && kind !== 'reset' && !username && (
                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
                  <CircularProgress size={18} />
                  <Typography variant="body2" color="text.secondary">Checking the link…</Typography>
                </Stack>
              )}
              {state.ok && <Alert severity="success">{state.ok}</Alert>}
              {state.error && <Alert severity="error" role="alert">{state.error}</Alert>}
              {(state.ok || state.error) && (
                <Stack direction="row">
                  <Button type="button" variant="outlined" onClick={onDone}>Continue</Button>
                </Stack>
              )}
            </Stack>
          </form>
        </CardContent>
      </Card>
    </Container>
  );
}

interface ForgotPasswordProps {
  onBack: () => void;
}

/**
 * "Forgot your password?": sends a reset link to the account's confirmed email. The reply never says whether the
 * account exists.
 *
 * @param props - Component props.
 * @param props.onBack - Callback to return to sign-in.
 * @returns Rendered React element.
 */
export function ForgotPassword({ onBack }: ForgotPasswordProps) {
  const [id, setId] = useState('');
  const [feedback, setFeedback] = useState<{ severity: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const reply = await api<{ message: string }>('POST', '/api/password-reset/request', { identifier: id });
      setFeedback({ severity: 'info', text: reply.message });
    } catch (err) {
      setFeedback({ severity: 'error', text: errorText(err) });
    }
    setBusy(false);
  }
  return (
    <form onSubmit={submit} autoComplete="off">
      <Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">
          Enter your username or confirmed email. We&apos;ll email you a link to choose a new password.
        </Typography>
        <TextField size="small" fullWidth value={id} onChange={(event) => setId(event.target.value)} required placeholder="Username or email" />
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button type="submit" variant="contained" disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
            Send reset link
          </Button>
          <Button type="button" variant="outlined" color="inherit" onClick={onBack}>Back to sign in</Button>
        </Stack>
        {feedback && (
          <Alert severity={feedback.severity} role={feedback.severity === 'error' ? 'alert' : undefined}>
            {feedback.text}
          </Alert>
        )}
      </Stack>
    </form>
  );
}

interface FirstSetupProps {
  onDone: () => void;
}

/**
 * First start: no account exists yet. The first account becomes admin of every gate already on this server.
 *
 * @param props - Component props.
 * @param props.onDone - Callback invoked when the action completes.
 * @returns Rendered React element.
 */
export function FirstSetup({ onDone }: FirstSetupProps) {
  const [setupCode, setSetupCode] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = passwordProblem(password, again);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError('');
    try { await api('POST', '/api/setup', { setupCode, username, password, email }); onDone(); } catch (err) { setError(errorText(err)); }
    setBusy(false);
  }
  return (
    <Container maxWidth="xs" sx={authContainerSx}>
      <Card>
        <CardContent sx={{ p: { xs: 2.5, sm: 3.5 } }}>
          <form onSubmit={submit} autoComplete="off">
            <Stack spacing={2}>
              <Typography variant="h5" component="h1">Create the first account</Typography>
              <Typography variant="body2" color="text.secondary">
                No account exists on this server yet. This first account becomes the admin of every gate already here. After that,
                gate admins create accounts for the people who use their gates.
              </Typography>
              <Field label="Setup code (printed in the server's log when it starts)">
                <TextField size="small" fullWidth value={setupCode} onChange={(event) => setSetupCode(event.target.value)} required autoComplete="off" />
              </Field>
              <Field label="Username">
                <TextField size="small" fullWidth value={username} onChange={(event) => setUsername(event.target.value)} required autoComplete="username" />
              </Field>
              <Field label="Email (optional)">
                <TextField type="email" size="small" fullWidth value={email} onChange={(event) => setEmail(event.target.value)} />
              </Field>
              <Field label={`Password (at least ${PASSWORD_MIN} characters)`}>
                <TextField type="password" size="small" fullWidth value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="new-password" />
              </Field>
              <Field label="Password again">
                <TextField type="password" size="small" fullWidth value={again} onChange={(event) => setAgain(event.target.value)} required autoComplete="new-password" />
              </Field>
              <Button type="submit" variant="contained" fullWidth disabled={busy}
                startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
                Create account
              </Button>
              {error && <Alert severity="error" role="alert">{error}</Alert>}
            </Stack>
          </form>
        </CardContent>
      </Card>
    </Container>
  );
}

interface ForcedPasswordChangeProps {
  user: string;
  onDone: () => void;
}

/**
 * After a gate admin (or the server's operator) set this account's password: the user picks their own first.
 *
 * @param props - Component props.
 * @param props.user - Local account username.
 * @param props.onDone - Callback invoked when the action completes.
 * @returns Rendered React element.
 */
export function ForcedPasswordChange({ user, onDone }: ForcedPasswordChangeProps) {
  const signOut = async () => { await api('DELETE', '/api/session').catch(() => {}); onDone(); };
  return (
    <Container maxWidth="xs" sx={authContainerSx}>
      <Card>
        <CardContent sx={{ p: { xs: 2.5, sm: 3.5 } }}>
          <Stack spacing={2}>
            <Typography variant="h5" component="h1">Choose your password</Typography>
            <Typography variant="body2" color="text.secondary">
              Signed in as <strong>{user}</strong> with a password someone else set. Choose your own to continue. Nobody else can see or change it.
            </Typography>
            <PasswordForm submitLabel="Save my password" onChanged={onDone} />
            <Stack direction="row">
              <Button variant="text" color="inherit" onClick={signOut}>Sign out</Button>
            </Stack>
          </Stack>
        </CardContent>
      </Card>
    </Container>
  );
}
