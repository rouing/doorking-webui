/**
 * @module web/ui/account/Passkeys
 *
 * Passkeys: the step-up dialog for sensitive actions and the user's passkey list.
 */
import { useEffect, useState, type FormEvent } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogContentText, DialogTitle, Paper, Stack,
  TextField, Tooltip, Typography,
} from '@mui/material';
import { browserSupportsWebAuthn, getBrowserCapabilities, sendSignal, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PasskeyInfo } from '../types.ts';
import { api, errorText, onStepUp } from '../api.ts';
import { useBackLayer } from '../back.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';
import { Field } from '../panes/fields.tsx';
import { ApproveDevice, APPROVAL_KEY } from './ApproveDevice.tsx';

/**
 * A readable message for a failed passkey step (the browser's "not allowed" also means the user cancelled).
 *
 * @param err - Caught error value.
 * @returns `string` result.
 */
export function passkeyError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'The passkey request was cancelled or timed out.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  return errorText(err);
}

interface PasskeysReply { passkeys: PasskeyInfo[]; userHandle: string | null }

/**
 * Tells the browser which of the account's passkeys still work on this site, so the phone or password manager stops
 * offering removed ones (Chrome 132 and later; other browsers skip it).
 *
 * @param reply - API `PasskeysReply` payload (`{ passkeys, userHandle }`).
 */
function syncWithBrowser(reply: PasskeysReply): void {
  if (!reply.userHandle) return;
  const rpID = window.location.hostname;
  sendSignal({
    signalName: 'allAcceptedCredentials',
    rpID,
    userID: reply.userHandle,
    allAcceptedCredentialIDs: reply.passkeys.filter((passkey) => passkey.site === rpID).map((passkey) => passkey.id),
  }).catch(() => { /* not supported */ });
}

/**
 * Right after a password sign-in: lets the password manager that filled in the password save a passkey by itself,
 * without a prompt (Chrome 136 and later, where the browser supports it). Only the account's first passkey; the
 * server refuses otherwise, and any failure is ignored.
 */
export async function savePasskeyAfterSignIn(): Promise<void> {
  try {
    if (!browserSupportsWebAuthn() || (await getBrowserCapabilities()).conditionalCreate !== 'supported') return;
    const optionsJSON = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('POST', '/api/me/passkeys/options', { auto: true });
    const response = await startRegistration({ optionsJSON, useAutoRegister: true });
    syncWithBrowser(await api<PasskeysReply>('POST', '/api/me/passkeys', { name: 'Saved after sign-in', response, auto: true }));
  } catch { /* not this time */ }
}

/**
 * The "Confirm it's you" dialog for sensitive actions (a 403 { stepUp } reply, see api.ts onStepUp): confirms with
 * one of the user's passkeys, then the action is retried. Without a passkey it says to add one. Render once.
 *
 * @returns Rendered React element.
 */
export function StepUpDialog() {
  const [ask, setAsk] = useState<{ hasPasskey: boolean; resolve: (ok: boolean) => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ severity: 'info' | 'error'; text: string } | null>(null);
  useEffect(() => {
    onStepUp((reply) => new Promise<boolean>((resolve) => {
      setFeedback(null);
      setAsk({ hasPasskey: reply.hasPasskey === true, resolve });
    }));
    return () => onStepUp(async () => false);
  }, []);
  const close = (ok: boolean) => { ask?.resolve(ok); setAsk(null); setBusy(false); };
  useBackLayer(ask !== null, () => close(false));
  async function confirmIt() {
    setBusy(true);
    setFeedback({ severity: 'info', text: 'Follow your browser\'s prompt…' });
    try {
      const optionsJSON = await api<Parameters<typeof startAuthentication>[0]['optionsJSON']>('POST', '/api/me/step-up/options', {});
      await api('POST', '/api/me/step-up', { response: await startAuthentication({ optionsJSON }) });
      close(true);
    } catch (err) {
      setFeedback({ severity: 'error', text: passkeyError(err) });
      setBusy(false);
    }
  }
  return (
    <Dialog open={ask !== null} onClose={() => close(false)} maxWidth="sm" fullWidth slotProps={{ paper: { sx: { maxWidth: 480 } } }}>
      <DialogTitle>{ask?.hasPasskey ? 'Confirm it\'s you' : 'A passkey is needed'}</DialogTitle>
      <DialogContent>
        <DialogContentText>
          {ask?.hasPasskey
            ? 'Changes like this one need a quick confirmation with your passkey (fingerprint, face or device PIN). It covers your next changes for a few hours. No passkey on this device? In the browser\'s prompt, choose a phone or tablet and scan its QR code with the phone that has your passkey.'
            : 'Changes like this one need a passkey. Add one in User Settings, under Passkeys, then try again.'}
        </DialogContentText>
        {feedback && (
          <Alert severity={feedback.severity} role={feedback.severity === 'error' ? 'alert' : undefined} sx={{ mt: 2 }}>
            {feedback.text}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={() => close(false)}>{ask?.hasPasskey ? 'Cancel' : 'Close'}</Button>
        {ask?.hasPasskey && (
          <Button variant="contained" onClick={confirmIt} disabled={busy || !browserSupportsWebAuthn()}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
            Confirm with passkey
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

interface PasskeysProps {
  askPassword: boolean;
  stepUpMinutes: number;
}

/**
 * The user's passkeys: add (after confirming the password, when the account has one), rename, remove. Passkeys work on the
 * site name they were made on: the public HTTPS name, or localhost on the server.
 *
 * @param props - Component props.
 * @param props.askPassword - Ask password.
 * @param props.stepUpMinutes - Step up minutes.
 * @returns Rendered React element.
 */
export function Passkeys({ askPassword, stepUpMinutes }: PasskeysProps) {
  const [list, setList] = useState<PasskeyInfo[]>([]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [approval, setApproval] = useState(() => sessionStorage.getItem(APPROVAL_KEY) || ''); // a code from another device
  const [feedback, setFeedback] = useState<{ severity: 'info' | 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<PasskeyInfo | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingBusy, setRenamingBusy] = useState(false);
  const [renameError, setRenameError] = useState('');
  const [dialog, confirm] = useConfirm();

  const show = (reply: PasskeysReply) => { setList(reply.passkeys); syncWithBrowser(reply); };
  const load = () => api<PasskeysReply>('GET', '/api/me/passkeys')
    .then(show, (err) => setFeedback({ severity: 'error', text: errorText(err) }));
  useEffect(() => { load(); }, []);

  const closeRename = () => {
    if (renamingBusy) return;
    setRenaming(null);
    setRenameError('');
  };
  useBackLayer(renaming !== null, closeRename);

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFeedback({ severity: 'info', text: 'Follow your browser\'s prompt…' });
    try {
      const optionsJSON = await api<Parameters<typeof startRegistration>[0]['optionsJSON']>('POST', '/api/me/passkeys/options',
        approval.trim() ? { approval } : { password });
      setPassword('');
      const response = await startRegistration({ optionsJSON });
      show(await api<PasskeysReply>('POST', '/api/me/passkeys', { name: name.trim(), response }));
      setName('');
      setApproval('');
      sessionStorage.removeItem(APPROVAL_KEY);
      setFeedback({ severity: 'success', text: 'Passkey added. You can now use "Sign in with a passkey".' });
    } catch (err) {
      setFeedback({ severity: 'error', text: passkeyError(err) });
    }
    setBusy(false);
  }

  const openRename = (passkey: PasskeyInfo) => {
    setRenaming(passkey);
    setRenameValue(passkey.name);
    setRenameError('');
  };

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    if (!renaming) return;
    const next = renameValue.trim();
    if (!next || next === renaming.name) { closeRename(); return; }
    setRenamingBusy(true);
    setRenameError('');
    try {
      show(await api<PasskeysReply>('PUT', `/api/me/passkeys/${encodeURIComponent(renaming.id)}`, { name: next }));
      setRenaming(null);
      setFeedback({ severity: 'success', text: `Renamed passkey to "${next}".` });
    } catch (err) {
      setRenameError(errorText(err));
    } finally {
      setRenamingBusy(false);
    }
  }

  const remove = async (passkey: PasskeyInfo) => {
    if (!await confirm({
      title: `Remove the passkey "${passkey.name}"?`,
      action: 'Remove',
      color: 'red',
      body: 'It will no longer sign you in. Also delete it from the device or password manager that holds it.',
    })) return;
    try {
      show(await api<PasskeysReply>('DELETE', `/api/me/passkeys/${encodeURIComponent(passkey.id)}`));
      setFeedback({ severity: 'success', text: `Removed "${passkey.name}".` });
    } catch (err) {
      setFeedback({ severity: 'error', text: errorText(err) });
    }
  };

  return (
    <Card>
      {dialog}
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Passkeys</Typography>
          <Typography variant="body2" color="text.secondary">
            Sign in with your fingerprint, face or device PIN instead of typing your password. Your other ways to sign in keep working too. A
            passkey works on the address it was added on ({window.location.host}).
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Sending changes to a gate, scheduled transfers, gate users, API keys, the gate&apos;s DKS login and linking a sign-in need a passkey: you
            confirm with it, and that covers your changes for {stepUpMinutes % 60 ? `${stepUpMinutes} minutes` : `${stepUpMinutes / 60} hours`}.
          </Typography>
          {list.length > 0 && (
            <Stack spacing={1.25}>
              {list.map((passkey) => (
                <Paper key={passkey.id} elevation={0} sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }} useFlexGap>
                    <Box sx={{ minWidth: 0, flex: '1 1 12rem' }}>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{passkey.name}</Typography>
                        {passkey.synced && (
                          <Tooltip title="Backed up by your passkey provider, so it is on your other devices too">
                            <Chip size="small" label="synced" variant="outlined" />
                          </Tooltip>
                        )}
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {passkey.site} · Added {fmtTime(passkey.createdAt)} · Last used {passkey.lastUsedAt ? fmtTime(passkey.lastUsedAt) : 'never'}
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
                      <Button size="small" variant="outlined" onClick={() => openRename(passkey)}>Rename</Button>
                      <Button size="small" variant="text" color="error" onClick={() => remove(passkey)}>Remove</Button>
                    </Stack>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
          {browserSupportsWebAuthn() ? (
            <form onSubmit={add} autoComplete="off">
              <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Field label="Name (e.g. iPhone, YubiKey)">
                  <TextField size="small" value={name} slotProps={{ htmlInput: { maxLength: 40 } }} onChange={(event) => setName(event.target.value)} />
                </Field>
                {list.length > 0 && (
                  <Field label="Approval code (from another device)" help="approvalCode">
                    <TextField size="small" value={approval} placeholder="ABCD-EFGH" autoComplete="one-time-code"
                      slotProps={{ htmlInput: { maxLength: 12 } }} onChange={(event) => setApproval(event.target.value)} />
                  </Field>
                )}
                {askPassword && !approval.trim() && (
                  <Field label="Your current password">
                    <TextField type="password" size="small" value={password} required={!list.length}
                      autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
                  </Field>
                )}
                <Button type="submit" variant="contained" disabled={busy}
                  startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
                  Add a passkey
                </Button>
              </Stack>
            </form>
          ) : (
            <Typography variant="body2" color="text.secondary">This browser doesn&apos;t support passkeys.</Typography>
          )}
          {feedback && (
            <Alert severity={feedback.severity} role={feedback.severity === 'error' ? 'alert' : undefined}>
              {feedback.text}
            </Alert>
          )}
          {list.length > 0 && <ApproveDevice />}
        </Stack>
      </CardContent>

      <Dialog open={renaming !== null} onClose={closeRename} maxWidth="xs" fullWidth>
        <form onSubmit={submitRename} autoComplete="off">
          <DialogTitle>Rename passkey</DialogTitle>
          <DialogContent>
            <DialogContentText sx={{ mb: 2 }}>
              Choose a new name for <strong>{renaming?.name}</strong>.
            </DialogContentText>
            <TextField
              autoFocus
              fullWidth
              size="small"
              label="Passkey name"
              value={renameValue}
              slotProps={{ htmlInput: { maxLength: 40 } }}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            {renameError && <Alert severity="error" role="alert" sx={{ mt: 2 }}>{renameError}</Alert>}
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button color="inherit" onClick={closeRename} disabled={renamingBusy}>Cancel</Button>
            <Button type="submit" variant="contained"
              disabled={renamingBusy || !renameValue.trim() || renameValue.trim() === renaming?.name}
              startIcon={renamingBusy ? <CircularProgress size={16} color="inherit" /> : undefined}>
              Save
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Card>
  );
}
