/**
 * @module web/ui/settings/Webhooks
 *
 * System Settings card for managing per-gate outbound webhooks, testing delivery, and viewing recent delivery results.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  FormControlLabel,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import type { WebhookDelivery, WebhookEvent, WebhookInfo } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';

interface WebhooksCardProps {
  gapi: GateApi;
}

const DEFAULT_EVENTS: WebhookEvent[] = ['send.completed', 'send.failed', 'relay.changed', 'pull.completed'];

/**
 * Outbound Webhooks management card (admin-only, under System Settings).
 *
 * @param props - Component props.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @returns Rendered React element.
 */
export function WebhooksCard({ gapi }: WebhooksCardProps) {
  const [webhooks, setWebhooks] = useState<WebhookInfo[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [available, setAvailable] = useState<WebhookEvent[]>(DEFAULT_EVENTS);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>(DEFAULT_EVENTS);
  const [newSecret, setNewSecret] = useState('');
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, confirm] = useConfirm();

  const load = useCallback(async () => {
    try {
      const reply = await gapi<{ webhooks: WebhookInfo[]; deliveries: WebhookDelivery[]; availableEvents: WebhookEvent[] }>('GET', '/webhooks');
      setWebhooks(reply.webhooks);
      setDeliveries(reply.deliveries);
      setAvailable(reply.availableEvents);
      setError('');
    } catch (err) { setError(errorText(err)); }
  }, [gapi]);
  useEffect(() => { load(); }, [load]);

  const toggleEvent = (event: WebhookEvent) => {
    setEvents((cur) => (cur.includes(event) ? cur.filter((e) => e !== event) : [...cur, event]));
  };

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setInfo('');
    setError('');
    setNewSecret('');
    try {
      const reply = await gapi<{ webhook: WebhookInfo; secret: string }>('POST', '/webhooks', { name, url, events });
      setNewSecret(reply.secret);
      setName('');
      setUrl('');
      await load();
    } catch (err) { setError(errorText(err)); }
    setBusy(false);
  }

  async function toggleEnabled(hook: WebhookInfo) {
    setBusy(true);
    setError('');
    try {
      await gapi('PUT', `/webhooks/${encodeURIComponent(hook.id)}`, { enabled: !hook.enabled });
      await load();
    } catch (err) { setError(errorText(err)); }
    setBusy(false);
  }

  async function testHook(hook: WebhookInfo) {
    setBusy(true);
    setError('');
    setInfo(`Testing "${hook.name}"…`);
    try {
      const res = await gapi<{ ok: boolean; status: number; error?: string }>('POST', `/webhooks/${encodeURIComponent(hook.id)}/test`, {});
      setInfo(`Test "${hook.name}": HTTP ${res.status} OK`);
    } catch (err) {
      setInfo('');
      setError(`Test "${hook.name}" failed: ${errorText(err)}`);
    }
    setBusy(false);
  }

  async function remove(hook: WebhookInfo) {
    if (!await confirm({ title: `Delete webhook "${hook.name}"?`, action: 'Delete', color: 'red',
      body: 'Stops sending events to this URL and deletes its delivery log.' })) return;
    setBusy(true);
    setError('');
    try {
      await gapi('DELETE', `/webhooks/${encodeURIComponent(hook.id)}`);
      await load();
    } catch (err) { setError(errorText(err)); }
    setBusy(false);
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(newSecret);
      setError('');
      setInfo('Signing secret copied.');
    } catch {
      setError('Copy failed: select the signing secret and copy it.');
    }
  }

  return (
    <Card>
      {dialog}
      <CardContent>
        <Stack spacing={2}>
          <Typography variant="h6" component="h2">Outbound webhooks</Typography>
          <Typography variant="body2" color="text.secondary">
            Send HMAC-SHA256 signed JSON notifications (<code>X-DoorKing-Signature</code>) to Slack, Home Assistant, or
            your own HTTPS endpoint when pulls, sends, or live relay changes happen.
          </Typography>
          {newSecret && (
            <Alert severity="success">
              <Stack spacing={1}>
                <Typography variant="body2">
                  Webhook signing secret (shown once — copy it now):
                </Typography>
                <Box component="code" sx={{ display: 'block', wordBreak: 'break-all', userSelect: 'all', fontFamily: 'monospace' }}>
                  {newSecret}
                </Box>
                <Stack direction="row" spacing={1}>
                  <Button size="small" variant="contained" onClick={copySecret}>Copy</Button>
                  <Button size="small" variant="outlined" color="inherit" onClick={() => setNewSecret('')}>Dismiss</Button>
                </Stack>
              </Stack>
            </Alert>
          )}
          {info && <Typography variant="body2" color="text.secondary">{info}</Typography>}
          {error && <Alert severity="error">{error}</Alert>}
          {webhooks.length > 0 && (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>URL</TableCell>
                    <TableCell>Events</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {webhooks.map((hook) => (
                    <TableRow key={hook.id}>
                      <TableCell>{hook.name}</TableCell>
                      <TableCell><Typography variant="caption" sx={{ wordBreak: 'break-all' }}>{hook.url}</Typography></TableCell>
                      <TableCell><Typography variant="caption">{hook.events.join(', ')}</Typography></TableCell>
                      <TableCell>
                        <Chip size="small" label={hook.enabled ? 'On' : 'Off'} color={hook.enabled ? 'success' : 'default'} variant={hook.enabled ? 'filled' : 'outlined'} />
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                          <Button size="small" variant="outlined" disabled={busy} onClick={() => testHook(hook)}>Test</Button>
                          <Button size="small" variant="outlined" color="inherit" disabled={busy} onClick={() => toggleEnabled(hook)}>
                            {hook.enabled ? 'Pause' : 'Enable'}
                          </Button>
                          <Button size="small" variant="outlined" color="error" disabled={busy} onClick={() => remove(hook)}>Delete</Button>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          <Box component="form" onSubmit={add}>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <TextField
                  size="small"
                  placeholder="Name (e.g. Home Assistant)"
                  value={name}
                  required
                  slotProps={{ htmlInput: { 'aria-label': 'Webhook name' } }}
                  onChange={(e) => setName(e.target.value)}
                  sx={{ flex: '1 1 180px' }}
                />
                <TextField
                  size="small"
                  placeholder="https://example.com/webhook"
                  value={url}
                  required
                  slotProps={{ htmlInput: { 'aria-label': 'Webhook URL' } }}
                  onChange={(e) => setUrl(e.target.value)}
                  sx={{ flex: '2 1 280px' }}
                />
                <Button type="submit" variant="contained" disabled={busy || !events.length}>Add webhook</Button>
              </Stack>
              <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap' }}>
                {available.map((event) => (
                  <FormControlLabel
                    key={event}
                    sx={{ mr: 0 }}
                    control={<Checkbox size="small" checked={events.includes(event)} onChange={() => toggleEvent(event)} />}
                    label={<Typography variant="caption">{event}</Typography>}
                  />
                ))}
              </Stack>
            </Stack>
          </Box>
          {deliveries.length > 0 && (
            <Stack spacing={1}>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>Recent deliveries</Typography>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Time</TableCell>
                      <TableCell>Event</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Details</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {deliveries.slice(0, 10).map((d) => (
                      <TableRow key={d.id}>
                        <TableCell>{fmtTime(d.createdAt)}</TableCell>
                        <TableCell>{d.event}</TableCell>
                        <TableCell>
                          <Chip
                            size="small"
                            color={d.status === 'sent' ? 'success' : d.status === 'failed' ? 'error' : 'warning'}
                            label={`${d.status}${d.lastStatus ? ` (${d.lastStatus})` : ''}`}
                          />
                        </TableCell>
                        <TableCell><Typography variant="caption" color="text.secondary">{d.lastError || `${d.attempts} try`}</Typography></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Stack>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
