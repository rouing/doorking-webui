import { useState, type FormEvent } from 'react';
import {
  Alert, Button, Checkbox, Container, Divider, FormControlLabel, Link, Paper, Stack, TextField, Typography,
} from '@mui/material';
import { browserSupportsWebAuthn, sendSignal, startAuthentication, type AuthenticationResponseJSON } from '@simplewebauthn/browser';
import type { SsoProviderInfo } from './types.ts';
import { api, ApiError, errorText, lsGet, lsSet } from './api.ts';
import { passkeyError, savePasskeyAfterSignIn } from './account/Passkeys.tsx';
import { usePasskeyAutofill, type PasskeyOptions } from './account/passkeyAutofill.ts';
import { ForgotPassword } from './account/SignInPages.tsx';
import { startSso } from './account/SingleSignOn.tsx';

interface LoginProps {
  onSignedIn: () => void;
  emailEnabled: boolean;
  sso: SsoProviderInfo[];
}

/**
 * Sign in with a local account (gate admins create them), a passkey, or a single sign-on provider. "Remember user"
 * keeps only the username in this browser. Passkeys are also offered in the username box's suggestions (autofill),
 * and after a password sign-in the browser may save one by itself (savePasskeyAfterSignIn).
 *
 * @param props - Component props.
 * @param props.onSignedIn - On signed in.
 * @param props.emailEnabled - Email enabled.
 * @param props.sso - Per-server SSO flow and discovery cache.
 * @returns Rendered React element.
 */
export function Login({ onSignedIn, emailEnabled, sso }: LoginProps) {
  const [forgot, setForgot] = useState(false);
  const [remember, setRemember] = useState(() => lsGet('dk-remember-user', false));
  const [user, setUser] = useState(() => (remember ? lsGet('dk-user', '') : ''));
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /**
   * Signs in with the browser's passkey answer. A passkey the server doesn't know (removed here) is reported to the
   * browser, which then stops offering it (Chrome 132 and later).
   *
   * @param optionsJSON - `PasskeyOptions` value.
   * @param response - WebAuthn browser response payload.
   * @throws Error when validation or the underlying operation fails.
   */
  async function passkeySession(optionsJSON: PasskeyOptions, response: AuthenticationResponseJSON) {
    try {
      await api('POST', '/api/passkey/session', { response });
    } catch (err) {
      if (err instanceof ApiError && err.body.unknownCredential) {
        sendSignal({ signalName: 'unknownCredential', rpID: optionsJSON.rpId || window.location.hostname, credentialID: response.id })
          .catch(() => { /* not supported */ });
      }
      throw err;
    }
    onSignedIn();
  }

  const autofill = usePasskeyAutofill({
    enabled: !forgot,
    onAnswer: async (optionsJSON, response) => { setBusy(true); setError(''); await passkeySession(optionsJSON, response); },
    onError: (err) => { setError(passkeyError(err)); setBusy(false); },
  });

  /**
   * Passkey sign-in with the button: no username needed, the browser offers this site's passkeys.
   *
   * @returns Computed result.
   */
  const withPasskey = () => autofill.whilePaused(async () => {
    setBusy(true);
    setError('');
    try {
      const optionsJSON = await api<PasskeyOptions>('POST', '/api/passkey/options', {});
      await passkeySession(optionsJSON, await startAuthentication({ optionsJSON }));
    } catch (err) { setError(passkeyError(err)); }
    setBusy(false);
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('POST', '/api/session', { user, password });
      lsSet('dk-remember-user', remember);
      lsSet('dk-user', remember ? user : '');
      setPassword('');
      onSignedIn();
      savePasskeyAfterSignIn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Container maxWidth="xs" sx={{ px: { xs: 2, sm: 3 }, pt: { xs: 4, sm: 6 }, pb: 4 }}>
      <Paper
        elevation={0}
        sx={{
          p: { xs: 2.5, sm: 3.5 },
          border: 'none',
          borderRadius: '16px',
          bgcolor: 'var(--md-surface-high)',
        }}
      >
        {forgot ? (
          <>
            <Typography variant="h5" component="h1" sx={{ mb: 2 }}>Reset your password</Typography>
            <ForgotPassword onBack={() => setForgot(false)} />
          </>
        ) : (
          <form onSubmit={submit} autoComplete="off">
            <Stack spacing={2}>
              <Typography variant="h5" component="h1">DoorKing Gate Portal</Typography>
              <Typography variant="body2" color="text.secondary">
                <strong>Residents:</strong> sign in with your email and password (or passkey).{' '}
                <strong>Administrators &amp; staff:</strong> sign in with your account{sso.length > 0 ? ' or work sign-in below' : ''}.{' '}
                <Link href="/help" target="_blank" rel="noopener">User guide</Link>
              </Typography>
              <TextField
                label="Email or username"
                value={user}
                placeholder="you@example.com"
                onChange={(event) => setUser(event.target.value)}
                required
                fullWidth
                autoComplete="username webauthn"
              />
              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                fullWidth
                autoComplete="current-password"
              />
              <FormControlLabel
                control={<Checkbox size="small" checked={remember} onChange={(event) => setRemember(event.target.checked)} />}
                label={<Typography variant="body2">Remember email / username</Typography>}
                sx={{ mt: '-8px !important' }}
              />
              <Button type="submit" variant="contained" fullWidth loading={busy}>Sign in</Button>
              {browserSupportsWebAuthn() && (
                <Button type="button" variant="outlined" fullWidth disabled={busy} onClick={withPasskey}>
                  Sign in with a passkey
                </Button>
              )}
              {sso.length > 0 && (
                <>
                  <Divider sx={{ my: 0.5 }} />
                  <Typography variant="caption" color="text.secondary">Staff &amp; administrators only</Typography>
                  {sso.map((provider) => (
                    <Button
                      key={provider.id}
                      type="button"
                      variant="outlined"
                      fullWidth
                      disabled={busy}
                      onClick={() => { setError(''); startSso('/api/sso/start', { provider: provider.id }).catch((err) => setError(errorText(err))); }}
                    >
                      Sign in with {provider.name}
                    </Button>
                  ))}
                </>
              )}
              {emailEnabled && (
                <Link href="#" variant="body2" onClick={(event) => { event.preventDefault(); setForgot(true); }}>
                  Forgot your password?
                </Link>
              )}
              {error && <Alert severity="error">{error}</Alert>}
            </Stack>
          </form>
        )}
      </Paper>
    </Container>
  );
}
