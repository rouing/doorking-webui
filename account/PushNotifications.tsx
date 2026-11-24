/**
 * @module web/ui/account/PushNotifications
 *
 * Manages per-device Web Push alert subscriptions for the signed-in user inside User Settings.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Paper, Stack,
  TextField, Typography,
} from '@mui/material';
import type { PushSubscriptionInfo } from '../types.ts';
import { api, errorText } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { fmtTime } from '../format.ts';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function defaultDeviceLabel(): string {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad/.test(ua)) return 'iOS device';
  if (/Android/.test(ua)) return 'Android device';
  if (/Macintosh/.test(ua)) return 'Mac browser';
  if (/Windows/.test(ua)) return 'Windows browser';
  if (/Linux/.test(ua)) return 'Linux browser';
  return 'Browser';
}

/**
 * Push notification settings card: lets users enable/disable Web Push on this device, test delivery, and remove
 * subscribed devices.
 *
 * @returns Rendered React element.
 */
export function PushNotificationsCard() {
  const supported = typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
  const [publicKey, setPublicKey] = useState('');
  const [subscriptions, setSubscriptions] = useState<PushSubscriptionInfo[]>([]);
  const [subscribedHere, setSubscribedHere] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>(
    () => (supported ? Notification.permission : 'default'),
  );
  const [label, setLabel] = useState(() => (typeof navigator !== 'undefined' ? defaultDeviceLabel() : 'Browser'));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ severity: 'info' | 'success' | 'error'; text: string } | null>(null);
  const [dialog, confirm] = useConfirm();

  const load = useCallback(async () => {
    try {
      const reply = await api<{ publicKey: string; subscriptions: PushSubscriptionInfo[] }>('GET', '/api/me/push');
      setPublicKey(reply.publicKey);
      setSubscriptions(reply.subscriptions);
    } catch (err) {
      setFeedback({ severity: 'error', text: errorText(err) });
    }
    if (supported) {
      setPermission(Notification.permission);
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        setSubscribedHere(Boolean(sub));
      } catch {
        setSubscribedHere(false);
      }
    }
  }, [supported]);

  useEffect(() => { void load(); }, [load]);

  const enableOnThisDevice = async () => {
    if (!supported || !publicKey) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        setFeedback({ severity: 'error', text: 'Browser notification permission was not granted.' });
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const sub = existing || await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const json = sub.toJSON();
      const reply = await api<{ subscriptions: PushSubscriptionInfo[] }>('POST', '/api/me/push', {
        endpoint: json.endpoint,
        keys: json.keys,
        label: label.trim() || defaultDeviceLabel(),
      });
      setSubscriptions(reply.subscriptions);
      setSubscribedHere(true);
      setFeedback({ severity: 'success', text: 'Push notifications enabled on this device.' });
    } catch (err) {
      setFeedback({ severity: 'error', text: `Could not enable push: ${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const disableOnThisDevice = async () => {
    if (!supported) return;
    setBusy(true);
    setFeedback(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api('DELETE', `/api/me/push/${encodeURIComponent(sub.endpoint)}`).catch(() => {});
        await sub.unsubscribe();
      }
      setSubscribedHere(false);
      await load();
      setFeedback({ severity: 'success', text: 'Push notifications disabled on this device.' });
    } catch (err) {
      setFeedback({ severity: 'error', text: `Could not disable push: ${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (sub: PushSubscriptionInfo) => {
    if (!await confirm({
      title: `Remove "${sub.label}"?`,
      action: 'Remove',
      color: 'red',
      body: 'This device will no longer receive push notifications until you re-enable them on it.',
    })) return;
    setBusy(true);
    setFeedback(null);
    try {
      const reply = await api<{ subscriptions: PushSubscriptionInfo[] }>('DELETE', `/api/me/push/${encodeURIComponent(sub.id)}`);
      setSubscriptions(reply.subscriptions);
      setFeedback({ severity: 'success', text: `Removed "${sub.label}".` });
    } catch (err) {
      setFeedback({ severity: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    setFeedback({ severity: 'info', text: 'Sending test notification…' });
    try {
      const reply = await api<{ sent: number; failed: number; removed: number }>('POST', '/api/me/push/test', {});
      if (reply.sent > 0) setFeedback({ severity: 'success', text: `Sent to ${reply.sent} device${reply.sent === 1 ? '' : 's'}.` });
      else setFeedback({ severity: 'error', text: 'No active push devices received the test notification.' });
      if (reply.removed > 0) await load();
    } catch (err) {
      setFeedback({ severity: 'error', text: `Test failed: ${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      {dialog}
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="h6" component="h2">Push notifications</Typography>
            {subscribedHere && <Chip size="small" color="success" label="Enabled on this device" />}
          </Stack>
          <Typography variant="body2" color="text.secondary">
            Receive instant browser or home-screen alerts when important gate or account events occur.
            On iOS 16.4+, install this app via Share → Add to Home Screen first.
          </Typography>
          {!supported ? (
            <Alert severity="warning">
              Push notifications are not supported in this browser context (requires HTTPS, a supported browser, or iOS Add to Home Screen).
            </Alert>
          ) : permission === 'denied' ? (
            <Alert severity="warning">
              Notifications are currently blocked for this site. To re-enable them, open your browser&apos;s site settings
              (tap the lock or settings icon in the address bar, or open device Settings → Notifications for this app),
              allow notifications, and reload this page.
            </Alert>
          ) : (
            <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              {!subscribedHere && (
                <TextField
                  size="small"
                  label="Device label"
                  value={label}
                  slotProps={{ htmlInput: { maxLength: 60 } }}
                  onChange={(event) => setLabel(event.target.value)}
                  sx={{ width: '14rem' }}
                />
              )}
              {!subscribedHere ? (
                <Button variant="contained" disabled={busy || !publicKey} onClick={enableOnThisDevice}
                  startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
                  Enable push on this device
                </Button>
              ) : (
                <Button variant="outlined" color="inherit" disabled={busy} onClick={disableOnThisDevice}>
                  Disable on this device
                </Button>
              )}
              {subscriptions.length > 0 && (
                <Button variant="outlined" disabled={busy} onClick={sendTest}>
                  Send test notification
                </Button>
              )}
            </Stack>
          )}
          {subscriptions.length > 0 && (
            <Stack spacing={1.25}>
              {subscriptions.map((sub) => (
                <Paper key={sub.id} elevation={0} sx={{ p: 1.5, borderRadius: 2, bgcolor: 'action.hover' }}>
                  <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }} useFlexGap>
                    <Box sx={{ minWidth: 0, flex: '1 1 12rem' }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{sub.label}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        Added {fmtTime(sub.createdAt)} · Last alert {sub.lastUsedAt ? fmtTime(sub.lastUsedAt) : 'never'}
                      </Typography>
                    </Box>
                    <Button size="small" variant="text" color="error" disabled={busy} onClick={() => removeDevice(sub)}>
                      Remove
                    </Button>
                  </Stack>
                </Paper>
              ))}
            </Stack>
          )}
          {feedback && (
            <Alert severity={feedback.severity} role={feedback.severity === 'error' ? 'alert' : undefined}>
              {feedback.text}
            </Alert>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}
