import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Alert,
  AppBar,
  Box,
  Button,
  ButtonBase,
  Chip,
  Container,
  Divider,
  Drawer,
  Fab,
  IconButton,
  Link,
  Paper,
  Stack,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import Brightness6OutlinedIcon from '@mui/icons-material/Brightness6Outlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import FenceOutlinedIcon from '@mui/icons-material/FenceOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import PersonOutlinedIcon from '@mui/icons-material/PersonOutlined';
import type { GateInfo, Job } from './types.ts';
import { api, errorText } from './api.ts';
import { useConfirm } from './Confirm.tsx';
import { usePhone } from './phone.ts';
import { fmtPhone } from './lib/shared.ts';
import { UserSettings } from './account/UserSettings.tsx';
import { Field } from './panes/fields.tsx';
import { ConfigFields } from './settings/GateConfig.tsx';
import { GATE_CONFIG_KEYS } from './lib/shared.ts';
import type { SignedIn } from './App.tsx';

/**
 * Gate label.
 *
 * @param gate - Gate summary (`phoneNumber`, `siteName`, `role`).
 * @returns Computed result.
 */
export const gateLabel = (gate: GateInfo) => gate.siteName || `Gate ${gate.phoneNumber}`;
/**
 * Role label.
 *
 * @param role - Gate access role (`admin` or `readonly`).
 * @returns Rendered React element.
 */
export const roleLabel = (role: GateInfo['role']) => (role === 'admin' ? 'Admin' : role === 'editor' ? 'Editor' : role === 'resident' ? 'Resident' : 'Read only');

interface AddGateProps {
  session: SignedIn;
  onAdded: () => void;
}

/**
 * Adds a gate: its phone, master code, DKS login and gate configuration. The server checks the DKS login, then pulls
 * residents with these values; the gate is added (with this user as its admin) only when that pull succeeds.
 *
 * @param props - Component props.
 * @param props.session - Authenticated user or API-key session.
 * @param props.onAdded - Callback invoked after a gate is added.
 * @returns Rendered React element.
 */
function AddGate({ session, onAdded }: AddGateProps) {
  const [form, setForm] = useState({ phoneNumber: '', masterCode: '', dksUser: '', dksPassword: '' });
  const [cfg, setCfg] = useState<Record<string, string>>(() => Object.fromEntries(GATE_CONFIG_KEYS.map((key) => [key, session.defaults[key] || ''])));
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const set = (key: keyof typeof form, value: string) => setForm({ ...form, [key]: value });

  const mounted = useRef(true);
  const checking = useRef(false); // a gate add was started or seen running: a failed check is tried again
  /**
   * Polls the checking pull every 3 s while it runs. Stops when the form closes (a check still on its way then
   * doesn't start polling again).
   */
  const poll = async () => {
    clearTimeout(timer.current);
    const reply = await api<{ job: Job | null }>('GET', '/api/gate-add').catch(() => undefined);
    if (!mounted.current) return;
    if (reply === undefined) {
      if (checking.current) timer.current = setTimeout(poll, 3000);
      else setBusy(false);
      return;
    }
    const latest = reply.job;
    setJob(latest);
    if (latest && latest.state === 'running') { checking.current = true; timer.current = setTimeout(poll, 3000); return; }
    checking.current = false;
    setBusy(false);
    if (latest && latest.state === 'done') { setForm({ phoneNumber: '', masterCode: '', dksUser: '', dksPassword: '' }); onAdded(); }
  };
  useEffect(() => {
    mounted.current = true;
    poll();
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);

  async function add(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('POST', '/api/gates', { ...form, gateConfig: cfg });
      setJob(null);
      checking.current = true;
      poll();
    } catch (err) { setError(errorText(err)); setBusy(false); }
  }

  const running = job && job.state === 'running';
  return (
    <form onSubmit={add} autoComplete="off">
      <Stack spacing={2}>
        <Typography variant="h6" component="h2">Add a gate</Typography>
        <Typography variant="body2" color="text.secondary">
          Enter the gate's details. The app signs in to DKS Cloud with the gate's DKS login and pulls the residents; only when that works is the
          gate added, with you as its admin. If the gate is already managed here, ask one of its gate admins to add you instead.
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
          <Field label="System phone" help="systemPhone">
            <TextField
              value={form.phoneNumber}
              onChange={(event) => set('phoneNumber', event.target.value)}
              required
              fullWidth
              slotProps={{ htmlInput: { inputMode: 'tel' } }}
              disabled={busy}
            />
          </Field>
          <Field label="Master code" help="gateMasterCode">
            <TextField
              type="password"
              value={form.masterCode}
              onChange={(event) => set('masterCode', event.target.value)}
              required
              fullWidth
              slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 4 } }}
              autoComplete="off"
              disabled={busy}
            />
          </Field>
          <Field label="DKS user" help="dksLogin">
            <TextField
              value={form.dksUser}
              onChange={(event) => set('dksUser', event.target.value)}
              required
              fullWidth
              autoComplete="off"
              disabled={busy}
            />
          </Field>
          <Field label="DKS password" help="dksLogin">
            <TextField
              type="password"
              value={form.dksPassword}
              onChange={(event) => set('dksPassword', event.target.value)}
              required
              fullWidth
              autoComplete="new-password"
              disabled={busy}
            />
          </Field>
        </Box>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>Gate configuration (must match the gate)</Typography>
        <ConfigFields config={cfg} onChange={setCfg} disabled={busy} />
        <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Button type="submit" variant="contained" loading={busy}>Add gate</Button>
        </Stack>
        {error && <Alert severity="error">{error}</Alert>}
        {job && (
          <Alert severity={running ? 'info' : job.state === 'done' ? 'success' : 'error'}>
            {running ? `Checking gate ${job.phoneNumber}: ${job.log.length ? job.log[job.log.length - 1].replace(/^\S+\s+\S+\s+/, '') : 'starting…'}`
              : job.state === 'done' ? `Gate ${job.phoneNumber} added. You are its admin.`
                : `Gate ${job.phoneNumber} was not added: ${job.error || 'the check failed'}`}
          </Alert>
        )}
      </Stack>
    </form>
  );
}

interface GatesProps {
  session: SignedIn;
  autoOpen?: boolean;
  onChange: () => void;
}

/**
 * The signed-in user's gates (open or leave one), User Settings, and adding a gate.
 *
 * @param props - Component props.
 * @param props.session - Authenticated user or API-key session.
 * @param [props.autoOpen] - Automatically open the single gate for resident-only users right after sign-in.
 * @param props.onChange - Callback invoked when the value changes.
 * @returns Rendered React element.
 */
export function Gates({ session, autoOpen = false, onChange }: GatesProps) {
  const [gates, setGates] = useState<GateInfo[] | null>(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const autoOpened = useRef(false);
  const [dialog, confirm] = useConfirm();
  const phone = usePhone();

  const load = () => api<{ gates: GateInfo[] }>('GET', '/api/gates').then((reply) => setGates(reply.gates), (err) => setError(errorText(err)));
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!autoOpen || autoOpened.current || !session.isResidentOnly || !gates || gates.length !== 1) return;
    autoOpened.current = true;
    api('PUT', '/api/session/gate', { phoneNumber: gates[0].phoneNumber }).then(onChange, (err) => setError(errorText(err)));
  }, [autoOpen, session.isResidentOnly, gates, onChange]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); } catch (err) { setError(errorText(err)); }
  };

  const open = (gate: GateInfo) => run(async () => { await api('PUT', '/api/session/gate', { phoneNumber: gate.phoneNumber }); onChange(); });

  const leave = async (gate: GateInfo) => {
    if (!await confirm({ title: `Leave ${gateLabel(gate)}?`, action: 'Leave', color: 'red',
      body: 'You will no longer see this gate. Its data stays for its other users. A gate admin can add you again.' })) return;
    await run(() => api('DELETE', `/api/gates/${encodeURIComponent(gate.phoneNumber)}`));
    load();
  };

  const signOut = () => run(async () => { await api('DELETE', '/api/session'); onChange(); });
  const toggleTheme = () => run(async () => { await api('PUT', '/api/me', { dark: !session.dark }); onChange(); });

  const roleColor = (role: GateInfo['role']) =>
    role === 'admin' ? 'primary' : role === 'editor' ? 'warning' : role === 'resident' ? 'success' : 'default';

  if (phone) {
    return (
      <Box sx={{ minHeight: '100dvh', bgcolor: 'var(--md-surface)' }}>
        {dialog}
        <AppBar
          position="sticky"
          color="default"
          elevation={0}
          sx={{ bgcolor: 'var(--md-surface)', color: 'text.primary', borderBottom: 'none', pt: 'env(safe-area-inset-top)' }}
        >
          <Toolbar sx={{ minHeight: '64px !important', px: settings ? 0.5 : 2, gap: 0.5 }}>
            {settings && (
              <IconButton aria-label="Back to gates" onClick={() => setSettings(false)} sx={{ color: 'text.primary' }}>
                <ArrowBackIcon />
              </IconButton>
            )}
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography noWrap sx={{ fontSize: '1.375rem', lineHeight: 1.25, fontWeight: 500 }}>
                {settings ? 'User Settings' : 'Your Gates'}
              </Typography>
              <Typography noWrap sx={{ fontSize: '0.75rem', lineHeight: 1.33, fontWeight: 500, color: 'text.secondary' }}>
                {session.user}
              </Typography>
            </Box>
            {!settings && (
              <>
                <IconButton aria-label="User settings" onClick={() => setSettings(true)} sx={{ color: 'text.primary' }}>
                  <PersonOutlinedIcon />
                </IconButton>
                <IconButton aria-label="Toggle dark mode" onClick={toggleTheme} sx={{ color: 'text.primary' }}>
                  <Brightness6OutlinedIcon />
                </IconButton>
                <IconButton aria-label="Sign out" onClick={signOut} sx={{ color: 'text.primary' }}>
                  <LogoutOutlinedIcon />
                </IconButton>
              </>
            )}
          </Toolbar>
        </AppBar>

        <Box sx={{ px: 2, pt: 1.5, pb: 'calc(env(safe-area-inset-bottom) + 96px)' }}>
          {settings ? (
            <UserSettings session={session} onSaved={onChange} />
          ) : (
            <Stack spacing={1.5}>
              {error && <Alert severity="error">{error}</Alert>}
              {gates && !gates.length && (
                <Paper elevation={0} sx={{ p: 2, borderRadius: '12px', bgcolor: 'var(--md-surface-low)' }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 500, mb: 0.5 }}>No gates yet</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {session.isResidentOnly
                      ? 'Ask your property manager to enable Resident Portal access for your unit.'
                      : 'Tap + Add gate below using the gate phone number, master code, and DKS Cloud login.'}
                  </Typography>
                </Paper>
              )}
              {(gates || []).map((gate) => (
                <Paper
                  key={gate.phoneNumber}
                  elevation={0}
                  sx={{ borderRadius: '12px', bgcolor: 'var(--md-surface-low)', overflow: 'hidden' }}
                >
                  <ButtonBase
                    type="button"
                    onClick={() => open(gate)}
                    sx={{ width: '100%', textAlign: 'left', p: 2, display: 'flex', alignItems: 'center', gap: 1.5 }}
                  >
                    <FenceOutlinedIcon sx={{ color: 'primary.main', flexShrink: 0 }} />
                    <Stack spacing={0.75} sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontSize: '1rem', fontWeight: 500, lineHeight: 1.35 }} noWrap>
                        {gateLabel(gate)}
                      </Typography>
                      <Stack direction="row" sx={{ gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                        <Chip size="small" label={fmtPhone(gate.phoneNumber)} sx={{ height: 26, fontSize: '0.75rem', fontWeight: 500 }} />
                        <Chip size="small" color={roleColor(gate.role)} label={roleLabel(gate.role)} sx={{ height: 26, fontSize: '0.75rem', fontWeight: 500 }} />
                      </Stack>
                    </Stack>
                    <ChevronRightIcon sx={{ color: 'text.secondary', flexShrink: 0 }} />
                  </ButtonBase>
                </Paper>
              ))}
            </Stack>
          )}
        </Box>

        {!settings && !session.isResidentOnly && (
          <>
            <Fab
              variant="extended"
              onClick={() => setAddSheetOpen(true)}
              sx={{
                position: 'fixed',
                right: 'calc(env(safe-area-inset-right) + 16px)',
                bottom: 'calc(env(safe-area-inset-bottom) + 20px)',
                zIndex: 1050,
                height: 56,
                borderRadius: '16px',
                bgcolor: 'var(--md-primary-container)',
                color: 'var(--md-on-primary-container)',
                textTransform: 'none',
                fontWeight: 600,
                px: 2.25,
                boxShadow: 3,
                '&:hover': { bgcolor: 'var(--md-primary-container)', filter: 'brightness(0.96)' },
              }}
            >
              <AddIcon sx={{ mr: 1 }} />
              Add gate
            </Fab>
            <Drawer
              anchor="bottom"
              open={addSheetOpen}
              onClose={() => setAddSheetOpen(false)}
              slotProps={{
                paper: {
                  sx: {
                    maxHeight: '92dvh',
                    overflowY: 'auto',
                    borderTopLeftRadius: 28,
                    borderTopRightRadius: 28,
                    bgcolor: 'var(--md-surface-low)',
                    pb: 'env(safe-area-inset-bottom)',
                  },
                },
              }}
            >
              <Box sx={{ width: 32, height: 4, borderRadius: 2, bgcolor: 'text.disabled', mx: 'auto', mt: 1.5, mb: 0.5, opacity: 0.4 }} />
              <Box sx={{ px: 2.5, py: 1.5 }}>
                <AddGate session={session} onAdded={() => { setAddSheetOpen(false); load(); }} />
              </Box>
            </Drawer>
          </>
        )}
      </Box>
    );
  }

  return (
    <Container maxWidth="md" sx={{ px: { xs: 2, sm: 3 }, pt: { xs: 3, sm: 5 }, pb: 4 }}>
      {dialog}
      <Paper elevation={0} sx={{
        p: { xs: 0, sm: 3 },
        border: 'none',
        borderRadius: '16px',
        bgcolor: { xs: 'transparent', sm: 'var(--md-surface-high)' },
      }}>
        <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mb: 3 }}>
          <Typography variant="h5" component="h1">{settings ? 'User Settings' : 'Your gates'}</Typography>
          <Typography variant="body2" color="text.secondary">{session.user}</Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Link href="/help" target="_blank" rel="noopener" variant="body2">Help</Link>
          <Button variant="outlined" color="inherit" size="small" onClick={() => setSettings(!settings)}>
            {settings ? 'Back to gates' : 'User settings'}
          </Button>
          <Button variant="outlined" color="inherit" size="small" onClick={signOut}>Sign out</Button>
        </Stack>
        {settings ? <UserSettings session={session} onSaved={onChange} /> : (
          <>
            {gates && !gates.length && (
              <Typography color="text.secondary">No gates yet. Add one below, or ask a gate admin to add you to theirs.</Typography>
            )}
            <Stack spacing={1.5}>
              {(gates || []).map((gate) => (
                <Stack key={gate.phoneNumber} direction={{ xs: 'column', sm: 'row' }} spacing={0.75} sx={{ alignItems: { xs: 'stretch', sm: 'stretch' } }}>
                  <Paper elevation={0} sx={{ flex: 1, minWidth: 0, borderRadius: '12px', bgcolor: 'var(--md-surface-lowest)', overflow: 'hidden' }}>
                    <ButtonBase
                      type="button"
                      onClick={() => open(gate)}
                      sx={{ width: '100%', textAlign: 'left', p: 2, display: 'flex', alignItems: 'center', gap: 1.5 }}
                    >
                      <FenceOutlinedIcon sx={{ color: 'primary.main', flexShrink: 0 }} />
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{gateLabel(gate)}</Typography>
                        <Typography variant="body2" color="text.secondary">{fmtPhone(gate.phoneNumber)}</Typography>
                      </Box>
                      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexShrink: 0 }}>
                        <Chip size="small" label={roleLabel(gate.role)} color={roleColor(gate.role)} />
                        <ChevronRightIcon color="action" aria-hidden="true" />
                      </Stack>
                    </ButtonBase>
                  </Paper>
                  {gate.role !== 'resident' && (
                    <Button variant="text" color="error" size="small"
                      sx={{ alignSelf: { xs: 'flex-end', sm: 'center' }, flexShrink: 0 }} onClick={() => leave(gate)}>
                      Leave
                    </Button>
                  )}
                </Stack>
              ))}
            </Stack>
            {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
            {!session.isResidentOnly && (
              <>
                <Divider sx={{ my: 3 }} />
                <AddGate session={session} onAdded={load} />
              </>
            )}
          </>
        )}
      </Paper>
    </Container>
  );
}
