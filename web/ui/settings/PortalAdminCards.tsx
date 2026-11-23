/**
 * @module web/ui/settings/PortalAdminCards
 *
 * Admin cards in System Settings for configuring the Resident Self-Service Portal & "Buzz Me In" PWA and viewing
 * the per-gate Login Audit Log.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { GatePrefs, LoginAuditEntry, ResidentPortalPrefs } from '../../../src/types.ts';
import { DEFAULT_RESIDENT_PORTAL_PREFS } from '../../../src/shared.ts';
import { errorText, type GateApi } from '../api.ts';
import { fmtTime } from '../format.ts';
import { Field } from '../panes/fields.tsx';

interface ResidentPortalSettingsCardProps {
  prefs: GatePrefs;
  gapi: GateApi;
  onSaved: () => Promise<void>;
}

export function ResidentPortalSettingsCard({ prefs, gapi, onSaved }: ResidentPortalSettingsCardProps) {
  const initial: ResidentPortalPrefs = { ...DEFAULT_RESIDENT_PORTAL_PREFS, ...(prefs.residentPortal || {}) };
  const [cfg, setCfg] = useState<ResidentPortalPrefs>(initial);
  const [pulseText, setPulseText] = useState(String(initial.pulseSeconds));
  const [rerollsText, setRerollsText] = useState(String(initial.maxRerollsPerDay));
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const labels = prefs.relayLabels || {};

  const parsedPulse = pulseText.trim() === '' ? NaN : Number(pulseText);
  const pulseInvalid = cfg.enabled && cfg.buzzEnabled && (!Number.isInteger(parsedPulse) || parsedPulse < 2 || parsedPulse > 15);
  const parsedRerolls = rerollsText.trim() === '' ? NaN : Number(rerollsText);
  const rerollsInvalid = cfg.enabled && (!Number.isInteger(parsedRerolls) || parsedRerolls < 0 || parsedRerolls > 10);

  const toggleRelay = (relay: number, checked: boolean) => {
    const next = checked
      ? [...new Set([...cfg.buzzRelays, relay])].sort((a, b) => a - b)
      : cfg.buzzRelays.filter((r) => r !== relay);
    setCfg({ ...cfg, buzzRelays: next.length ? next : [0] });
  };

  const buildPayload = (base: ResidentPortalPrefs): ResidentPortalPrefs => ({
    ...base,
    pulseSeconds: Number.isInteger(parsedPulse) && parsedPulse >= 2 && parsedPulse <= 15 ? parsedPulse : base.pulseSeconds,
    maxRerollsPerDay: Number.isInteger(parsedRerolls) && parsedRerolls >= 0 && parsedRerolls <= 10 ? parsedRerolls : base.maxRerollsPerDay,
  });

  const toggleEnabled = async (enabled: boolean) => {
    const prev = cfg;
    const next = buildPayload({ ...cfg, enabled });
    setCfg(next);
    setBusy(true);
    setError('');
    setInfo('Saving…');
    try {
      await gapi('PUT', '/prefs', { residentPortal: next });
      await onSaved();
      setInfo(enabled ? 'Resident Self-Service Portal enabled.' : 'Resident Self-Service Portal disabled.');
    } catch (err) {
      setCfg(prev);
      setInfo('');
      setError(`Not saved: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (pulseInvalid || rerollsInvalid) {
      setError('Fix the highlighted fields before saving.');
      return;
    }
    const payload = buildPayload(cfg);
    setCfg(payload);
    setPulseText(String(payload.pulseSeconds));
    setRerollsText(String(payload.maxRerollsPerDay));
    setBusy(true);
    setError('');
    setInfo('Saving…');
    try {
      await gapi('PUT', '/prefs', { residentPortal: payload });
      await onSaved();
      setInfo('Resident Portal settings saved.');
    } catch (err) {
      setInfo('');
      setError(`Not saved: ${errorText(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <Stack spacing={0.5} sx={{ flex: '1 1 20rem' }}>
              <Typography variant="h6" component="h2">Resident Self-Service Portal</Typography>
              <Typography variant="body2" color="text.secondary">
                Lets enabled residents sign in by email (password or passkey, no SSO) to view their own gate access, reroll
                their 4-digit code, inspect their own activity, report suspicious opens, and optionally buzz the gate open.
              </Typography>
            </Stack>
            <Switch
              checked={cfg.enabled}
              disabled={busy}
              onChange={(_, enabled) => toggleEnabled(enabled)}
              slotProps={{ input: { 'aria-label': 'Enable Resident Self-Service Portal' } }}
            />
          </Stack>
          {cfg.enabled && (
            <>
              <Stack spacing={1}>
                <FormControlLabel
                  control={<Switch size="small" checked={cfg.buzzEnabled} onChange={(_, checked) => setCfg({ ...cfg, buzzEnabled: checked })} />}
                  label="Enable “Buzz Me In” remote gate opening (momentary pulse backed by auto-release timer)"
                />
                {cfg.buzzEnabled && (
                  <Stack direction="row" spacing={3} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', pl: 3 }}>
                    <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                      <Typography variant="body2" color="text.secondary">Entrances:</Typography>
                      {[0, 1, 2].map((r) => (
                        <FormControlLabel
                          key={r}
                          sx={{ mr: 0 }}
                          control={<Switch size="small" checked={cfg.buzzRelays.includes(r)} onChange={(_, checked) => toggleRelay(r, checked)} />}
                          label={labels[String(r)] || `Relay ${r}`}
                        />
                      ))}
                    </Stack>
                    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                      <Typography variant="body2" color="text.secondary">Pulse (sec):</Typography>
                      <TextField
                        size="small"
                        type="number"
                        value={pulseText}
                        error={pulseInvalid}
                        helperText={pulseInvalid ? '2–15 sec' : undefined}
                        slotProps={{ htmlInput: { min: 2, max: 15, 'aria-label': 'Pulse duration in seconds' } }}
                        sx={{ width: '6rem' }}
                        onChange={(e) => setPulseText(e.target.value)}
                      />
                    </Stack>
                    <FormControlLabel
                      sx={{ mr: 0 }}
                      control={<Switch size="small" checked={cfg.requirePasskeyForBuzz} onChange={(_, checked) => setCfg({ ...cfg, requirePasskeyForBuzz: checked })} />}
                      label="Require passkey confirmation to buzz"
                    />
                  </Stack>
                )}
                <FormControlLabel
                  control={<Switch size="small" checked={cfg.autoSendReroll} onChange={(_, checked) => setCfg({ ...cfg, autoSendReroll: checked })} />}
                  label="Auto-send to gate immediately when a resident rerolls their entry code (off = save to working copy & notify admins / wait for scheduled send)"
                />
                <FormControlLabel
                  control={<Switch size="small" checked={cfg.showSnapshots} onChange={(_, checked) => setCfg({ ...cfg, showSnapshots: checked })} />}
                  label="Allow residents to view camera snapshots for their own unit's activity"
                />
                <FormControlLabel
                  control={<Switch size="small" checked={cfg.allowRequests} onChange={(_, checked) => setCfg({ ...cfg, allowRequests: checked })} />}
                  label="Allow residents to submit self-service change requests"
                />
              </Stack>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)' }, gap: 2, maxWidth: 420 }}>
                <Field label="Max entry code rerolls per 24h (0 = off)">
                  <TextField
                    size="small"
                    type="number"
                    value={rerollsText}
                    error={rerollsInvalid}
                    helperText={rerollsInvalid ? 'Enter 0–10' : undefined}
                    slotProps={{ htmlInput: { min: 0, max: 10, 'aria-label': 'Max entry code rerolls per 24h' } }}
                    onChange={(e) => setRerollsText(e.target.value)}
                  />
                </Field>
              </Box>
            </>
          )}
          <Stack direction="row" spacing={2} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="contained" disabled={busy || pulseInvalid || rerollsInvalid} onClick={save}>Save portal settings</Button>
            {info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
          </Stack>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </CardContent>
    </Card>
  );
}

interface LoginAuditCardProps {
  gapi: GateApi;
}

const AUDIT_PAGE = 10;

/**
 * Collapsible Admin Login Audit Log card (staff + resident sign-ins and failed attempts), rendered as paged compact
 * cards so long histories stay scannable on phones.
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
export function LoginAuditCard({ gapi }: LoginAuditCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<LoginAuditEntry[]>([]);
  const [filter, setFilter] = useState<'all' | 'failed'>('all');
  const [shown, setShown] = useState(AUDIT_PAGE);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const reply = await gapi<{ entries: LoginAuditEntry[] }>('GET', `/login-audit?limit=200${filter === 'failed' ? '&outcome=failed' : ''}`);
      setEntries(reply.entries);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [gapi, filter]);

  useEffect(() => {
    setShown(AUDIT_PAGE);
    if (expanded) void load();
  }, [expanded, load]);

  const visible = entries.slice(0, shown);

  return (
    <Accordion variant="outlined" expanded={expanded} onChange={(_, open) => setExpanded(open)} disableGutters>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', pr: 1 }} useFlexGap>
          <Typography variant="h6" component="h2">Login audit log</Typography>
          {entries.length > 0 && (
            <Chip size="small" label={`${entries.length} event${entries.length === 1 ? '' : 's'}`} />
          )}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <Typography variant="body2" color="text.secondary">
              Recent sign-in attempts for staff and residents on this gate (retained for 180 days).
            </Typography>
            <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={filter}
                aria-label="Filter login audit entries"
                onChange={(_, next) => { if (next) setFilter(next); }}
              >
                <ToggleButton value="all">All</ToggleButton>
                <ToggleButton value="failed">Failures</ToggleButton>
              </ToggleButtonGroup>
              <Button size="small" variant="outlined" disabled={loading} onClick={load}>Refresh</Button>
            </Stack>
          </Stack>
          {error && <Alert severity="error">{error}</Alert>}
          {loading && !entries.length ? (
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">Loading login events…</Typography>
            </Stack>
          ) : !entries.length ? (
            <Typography variant="body2" color="text.secondary">No login events recorded yet.</Typography>
          ) : (
            <Stack spacing={1}>
              {visible.map((entry) => (
                <Paper key={entry.id} elevation={0} sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
                  <Stack spacing={0.5}>
                    <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                      <Stack direction="row" spacing={0.75} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{entry.username || entry.identifier}</Typography>
                        {entry.role && (
                          <Chip
                            size="small"
                            label={entry.role}
                            color={entry.role === 'resident' ? 'success' : 'primary'}
                          />
                        )}
                      </Stack>
                      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
                        <Chip size="small" label={entry.method} />
                        <Chip
                          size="small"
                          label={entry.outcome}
                          color={entry.outcome === 'success' ? 'success' : entry.outcome === 'rate_limited' ? 'warning' : 'error'}
                        />
                      </Stack>
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {fmtTime(entry.createdAt)} · {entry.ip}
                    </Typography>
                    {entry.reason && (
                      <Typography variant="caption" color="error.main">{entry.reason}</Typography>
                    )}
                  </Stack>
                </Paper>
              ))}
              {entries.length > shown && (
                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', pt: 0.5 }}>
                  <Button size="small" variant="outlined" onClick={() => setShown((n) => n + AUDIT_PAGE)}>
                    Show {Math.min(AUDIT_PAGE, entries.length - shown)} more
                  </Button>
                  <Typography variant="caption" color="text.secondary">
                    Showing {shown} of {entries.length}
                  </Typography>
                </Stack>
              )}
            </Stack>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
