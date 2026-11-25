/**
 * @module web/ui/account/UserSettings
 *
 * The signed-in user's own settings page.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert, Button, Card, CardContent, Chip, CircularProgress, FormControlLabel, Stack, Switch,
  TextField, Typography,
} from '@mui/material';
import LogoutIcon from '@mui/icons-material/Logout';
import { api, errorText } from '../api.ts';
import { fmtIntlPhone } from '../format.ts';
import type { SignedIn } from '../App.tsx';
import { Field } from '../panes/fields.tsx';
import { Passkeys } from './Passkeys.tsx';
import { PushNotificationsCard } from './PushNotifications.tsx';
import { SingleSignOn } from './SingleSignOn.tsx';
import { PasswordForm } from './passwords.tsx';

interface UserSettingsProps {
  session: SignedIn;
  onSaved: () => void;
  resident?: boolean;
  onSignOut?: () => void;
}

/**
 * The signed-in user's own settings: dark mode, email, phone, notifications, passkeys, and password.
 * `onSaved` reloads the session (including dark mode).
 *
 * @param props - Component props.
 * @param props.session - Authenticated user or API-key session.
 * @param props.onSaved - Callback invoked after settings are saved.
 * @param [props.resident] - Resident-portal mode: hides admin-only options and SSO, shows Sign out.
 * @param [props.onSignOut] - Optional Sign out handler rendered at the bottom when provided.
 * @returns Rendered React element.
 */
export function UserSettings({ session, onSaved, resident = false, onSignOut }: UserSettingsProps) {
  const [email, setEmail] = useState(session.pendingEmail || session.email);
  const [emailPassword, setEmailPassword] = useState('');
  const [phone, setPhone] = useState(fmtIntlPhone(session.phone));
  const [appearanceError, setAppearanceError] = useState('');
  const [notifyError, setNotifyError] = useState('');
  const [relayError, setRelayError] = useState('');
  const [portalRelays, setPortalRelays] = useState<Array<{ phone: string; siteName: string; relays: Array<{ relay: number; name: string; hidden: boolean }> }>>([]);
  const [hiddenRelays, setHiddenRelays] = useState<Record<string, number[]>>({});
  const [emailFeedback, setEmailFeedback] = useState<{ severity: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [phoneFeedback, setPhoneFeedback] = useState<{ severity: 'success' | 'error'; text: string } | null>(null);
  const [savingEmail, setSavingEmail] = useState(false);
  const [savingPhone, setSavingPhone] = useState(false);

  useEffect(() => {
    let alive = true;
    void api<{
      hiddenRelays?: Record<string, number[]>;
      portalRelays?: Array<{ phone: string; siteName: string; relays: Array<{ relay: number; name: string; hidden: boolean }> }>;
    }>('GET', '/api/me').then((me) => {
      if (!alive) return;
      setHiddenRelays(me.hiddenRelays || {});
      setPortalRelays(me.portalRelays || []);
    }).catch(() => {});
    return () => { alive = false; };
  }, [session.user]);

  const toggleRelayVisibility = async (gatePhone: string, relay: number, visible: boolean) => {
    setRelayError('');
    const prevHidden = hiddenRelays;
    const prevPortal = portalRelays;
    const nextMap: Record<string, number[]> = { ...hiddenRelays };
    const set = new Set(nextMap[gatePhone] || []);
    if (visible) set.delete(relay); else set.add(relay);
    if (set.size) nextMap[gatePhone] = [...set].sort((a, b) => a - b);
    else delete nextMap[gatePhone];
    setHiddenRelays(nextMap);
    setPortalRelays((prev) => prev.map((g) => (
      g.phone !== gatePhone ? g : { ...g, relays: g.relays.map((r) => (r.relay === relay ? { ...r, hidden: !visible } : r)) }
    )));
    try {
      await api('PUT', '/api/me', { hiddenRelays: nextMap });
      onSaved();
    } catch (err) {
      setHiddenRelays(prevHidden);
      setPortalRelays(prevPortal);
      setRelayError(`Not saved: ${errorText(err)}`);
    }
  };

  const toggleSetting = async (body: Record<string, unknown>, setErr: (msg: string) => void) => {
    setErr('');
    try {
      await api('PUT', '/api/me', body);
      onSaved();
    } catch (err) {
      setErr(`Not saved: ${errorText(err)}`);
    }
  };

  const next = email.trim().toLowerCase();
  const emailChanges = next !== session.email && next !== session.pendingEmail; // needs the current password

  const saveEmail = async (event: FormEvent) => {
    event.preventDefault();
    setSavingEmail(true);
    setEmailFeedback(null);
    const done = !next
      ? 'Email removed.'
      : next === session.email
        ? 'Saved.'
        : `Saved. Open the link we sent to ${next} to confirm it.`;
    try {
      const reply = await api<{ warning?: string }>('PUT', '/api/me', {
        email: next,
        ...(emailChanges && { password: emailPassword }),
      });
      setEmailPassword('');
      setEmailFeedback(reply.warning ? { severity: 'warning', text: reply.warning } : { severity: 'success', text: done });
      onSaved();
    } catch (err) {
      setEmailFeedback({ severity: 'error', text: `Not saved: ${errorText(err)}` });
    } finally {
      setSavingEmail(false);
    }
  };

  const resend = async () => {
    setEmailFeedback(null);
    try {
      await api('POST', '/api/me/email/resend', {});
      setEmailFeedback({ severity: 'success', text: `Confirmation link sent again to ${session.pendingEmail}.` });
    } catch (err) {
      setEmailFeedback({ severity: 'error', text: errorText(err) });
    }
  };

  const savePhone = async (event: FormEvent) => {
    event.preventDefault();
    setSavingPhone(true);
    setPhoneFeedback(null);
    try {
      const reply = await api<{
        phone: string;
        gatePhoneSync?: { updatedUnits: string[]; nextScheduledSend: string | null };
      }>('PUT', '/api/me', { phone: phone.trim() });
      setPhone(fmtIntlPhone(reply.phone));
      if (reply.gatePhoneSync?.updatedUnits?.length) {
        const unitsLabel = reply.gatePhoneSync.updatedUnits.map((c) => `#${c}`).join(', ');
        const syncNote = reply.gatePhoneSync.nextScheduledSend
          ? ` It will sync to the gate around ${new Date(reply.gatePhoneSync.nextScheduledSend).toLocaleString()}.`
          : ' Management has been notified to send it to the gate.';
        setPhoneFeedback({
          severity: 'success',
          text: `Saved as ${fmtIntlPhone(reply.phone)} and updated call-box unit ${unitsLabel}.${syncNote}`,
        });
      } else {
        setPhoneFeedback({ severity: 'success', text: reply.phone ? `Saved as ${fmtIntlPhone(reply.phone)}.` : 'Phone number removed.' });
      }
      onSaved();
    } catch (err) {
      setPhoneFeedback({ severity: 'error', text: `Not saved: ${errorText(err)}` });
    } finally {
      setSavingPhone(false);
    }
  };

  return (
    <Stack spacing={2.5}>
      <Stack spacing={0.5}>
        <Typography variant="h5" component="h1">{resident ? 'Account' : 'User Settings'}</Typography>
        <Typography variant="body2" color="text.secondary">
          Settings for your account, <strong>{session.email || session.user}</strong>. They follow you to any browser you sign in from.
        </Typography>
      </Stack>

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="h6" component="h2">Appearance</Typography>
            <FormControlLabel
              control={
                <Switch
                  checked={session.dark}
                  onChange={(_, checked) => toggleSetting({ dark: checked }, setAppearanceError)}
                />
              }
              label="Dark mode"
            />
            {appearanceError && <Alert severity="error" role="alert">{appearanceError}</Alert>}
          </Stack>
        </CardContent>
      </Card>

      {portalRelays.length > 0 && (
        <Card>
          <CardContent>
            <Stack spacing={1.5}>
              <Typography variant="h6" component="h2">Visible gate relays</Typography>
              <Typography variant="body2" color="text.secondary">
                Choose which gate open buttons appear in Resident View, the Android app, and Android Auto.
              </Typography>
              {portalRelays.map((group) => (
                <Stack key={group.phone} spacing={0.5}>
                  {portalRelays.length > 1 && (
                    <Typography variant="subtitle2" color="text.secondary">{group.siteName || group.phone}</Typography>
                  )}
                  {group.relays.map((opt) => (
                    <FormControlLabel
                      key={opt.relay}
                      control={
                        <Switch
                          size="small"
                          checked={!opt.hidden}
                          onChange={(_, checked) => toggleRelayVisibility(group.phone, opt.relay, checked)}
                        />
                      }
                      label={opt.name || `Relay ${opt.relay}`}
                    />
                  ))}
                </Stack>
              ))}
              {relayError && <Alert severity="error" role="alert">{relayError}</Alert>}
            </Stack>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <form onSubmit={saveEmail} autoComplete="off">
            <Stack spacing={2} sx={{ maxWidth: 480 }}>
              <Typography variant="h6" component="h2">Email</Typography>
              <Typography variant="body2" color="text.secondary">
                Used for password resets, security alerts and notifications. Each email can belong to one account only. A new address works
                once you open the confirmation link sent to it.
              </Typography>
              {session.email && (
                <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography variant="body2">Confirmed: <strong>{session.email}</strong></Typography>
                  <Chip size="small" color="success" label="confirmed" />
                </Stack>
              )}
              {session.pendingEmail && (
                <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <Typography variant="body2">Waiting for confirmation: <strong>{session.pendingEmail}</strong></Typography>
                  <Chip size="small" color="warning" label="check your inbox" />
                  {session.emailEnabled && (
                    <Button size="small" variant="outlined" onClick={resend}>Send the link again</Button>
                  )}
                </Stack>
              )}
              {!session.emailEnabled && (
                <Alert severity="warning">This server can&apos;t send email yet, so addresses can&apos;t be confirmed for now.</Alert>
              )}
              <TextField type="email" size="small" fullWidth value={email} onChange={(event) => setEmail(event.target.value)}
                slotProps={{ htmlInput: { 'aria-label': 'Email address' } }} />
              {session.hasPassword && emailChanges && (
                <Field label="Your current password">
                  <TextField type="password" size="small" fullWidth value={emailPassword} autoComplete="current-password"
                    onChange={(event) => setEmailPassword(event.target.value)} />
                </Field>
              )}
              <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Button type="submit" variant="contained" disabled={savingEmail}
                  startIcon={savingEmail ? <CircularProgress size={16} color="inherit" /> : undefined}>
                  Save email
                </Button>
              </Stack>
              {emailFeedback && (
                <Alert severity={emailFeedback.severity} role={emailFeedback.severity === 'error' ? 'alert' : undefined}>
                  {emailFeedback.text}
                </Alert>
              )}
            </Stack>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <form onSubmit={savePhone} autoComplete="off">
            <Stack spacing={2} sx={{ maxWidth: 480 }}>
              <Typography variant="h6" component="h2">{resident ? 'Call-box phone number' : 'Phone'}</Typography>
              <Typography variant="body2" color="text.secondary">
                {resident
                  ? 'Linked to your gate directory listing. Updating your 10-digit US/Canada phone number here updates your unit\'s call-box number and syncs to the gate on the next send.'
                  : 'Optional. Admins of your gates can see it, to reach you. A 10-digit number is taken as US/Canada; for other countries start with + and the country code.'}
              </Typography>
              <TextField type="tel" size="small" fullWidth value={phone} placeholder="(214) 555-0100 or +44 20 7946 0958"
                slotProps={{ htmlInput: { inputMode: 'tel', 'aria-label': 'Phone number' } }}
                onChange={(event) => setPhone(event.target.value)} />
              <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Button type="submit" variant="contained" disabled={savingPhone}
                  startIcon={savingPhone ? <CircularProgress size={16} color="inherit" /> : undefined}>
                  Save phone
                </Button>
              </Stack>
              {phoneFeedback && (
                <Alert severity={phoneFeedback.severity} role={phoneFeedback.severity === 'error' ? 'alert' : undefined}>
                  {phoneFeedback.text}
                </Alert>
              )}
            </Stack>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="h6" component="h2">Email notifications</Typography>
            <Typography variant="body2" color="text.secondary">
              Sent to your confirmed email. Security emails (password or passkey changes, password resets) are always sent.
            </Typography>
            <FormControlLabel
              control={
                <Switch
                  checked={session.notifyAccess}
                  onChange={(_, checked) => toggleSetting({ notifyAccess: checked }, setNotifyError)}
                />
              }
              label="When I'm given access to a gate, removed from one, or my role changes"
            />
            {!resident && (
              <FormControlLabel
                control={
                  <Switch
                    checked={session.notifyAlerts}
                    onChange={(_, checked) => toggleSetting({ notifyAlerts: checked }, setNotifyError)}
                  />
                }
                label="Gate alerts for gates I'm admin of (a send or scheduled transfer failed)"
              />
            )}
            {notifyError && <Alert severity="error" role="alert">{notifyError}</Alert>}
          </Stack>
        </CardContent>
      </Card>

      <PushNotificationsCard />
      {!resident && <SingleSignOn session={session} />}
      <Passkeys askPassword={session.hasPassword} stepUpMinutes={session.stepUpMinutes} />

      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="h6" component="h2">Password</Typography>
            {!session.passwordAllowed ? (
              <Typography variant="body2" color="text.secondary">
                Password sign-in is turned off for your account: you sign in with single sign-on (or a passkey).
              </Typography>
            ) : !session.hasPassword ? (
              <Typography variant="body2" color="text.secondary">
                Your account has no password: you sign in with single sign-on (or a passkey). To set one, use &ldquo;Forgot your password?&rdquo; on the
                sign-in page; it needs a confirmed email.
              </Typography>
            ) : (
              <>
                <Typography variant="body2" color="text.secondary">
                  Only you can change your password. Changing it signs you out on every other browser.
                </Typography>
                <PasswordForm submitLabel="Change password" onChanged={() => {}} />
              </>
            )}
          </Stack>
        </CardContent>
      </Card>

      {onSignOut && (
        <Card>
          <CardContent>
            <Button variant="contained" color="error" fullWidth startIcon={<LogoutIcon />} onClick={onSignOut}>
              Sign out
            </Button>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}
