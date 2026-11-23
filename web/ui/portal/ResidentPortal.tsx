/**
 * @module web/ui/portal/ResidentPortal
 *
 * Mobile-first Resident Self-Service Portal & "Buzz Me In" PWA shell rendered when a signed-in user opens a gate
 * with `role === 'resident'`. Delegates state/polling to `usePortalData` and renders focused tab components.
 */
import { useState } from 'react';
import {
  Alert, AppBar, BottomNavigation, BottomNavigationAction, Box, Button, Container, Paper, Stack, Toolbar, Typography,
} from '@mui/material';
import DoorFrontIcon from '@mui/icons-material/DoorFront';
import EditNoteIcon from '@mui/icons-material/EditNote';
import HistoryIcon from '@mui/icons-material/History';
import PersonIcon from '@mui/icons-material/Person';
import type { GateInfo, ResidentRequest, TransactionRow } from '../../../src/types.ts';
import { api, errorText, lsGet, lsSet } from '../api.ts';
import { useBackLayer } from '../back.ts';
import { useConfirm } from '../Confirm.tsx';
import { UserSettings } from '../account/UserSettings.tsx';
import type { SignedIn } from '../App.tsx';
import { PortalActivityTab } from './PortalActivityTab.tsx';
import { PortalGateTab } from './PortalGateTab.tsx';
import { PortalRequestsTab } from './PortalRequestsTab.tsx';
import { clearPortalCache, portalUrl, usePortalData } from './usePortalData.ts';

interface ResidentPortalProps {
  session: SignedIn;
  gate: GateInfo;
  onChange: () => void;
  onSessionReload?: () => void;
  onBackToStaff?: () => void;
}

type PortalTab = 'gate' | 'activity' | 'requests' | 'account';

function installTipForBrowser(): string {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return '';
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (standalone) return '';
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad/i.test(ua)) return 'Install on your iPhone: tap Share → Add to Home Screen in Safari, then open the new icon for 1-tap access and push notifications.';
  if (/Android/i.test(ua)) return 'Install on Android: tap the browser menu (⋮) → Install app for 1-tap Home Screen access and push notifications.';
  return '';
}

export function ResidentPortal({ session, gate, onChange, onSessionReload, onBackToStaff }: ResidentPortalProps) {
  const [tab, setTab] = useState<PortalTab>('gate');
  const [selectedCode, setSelectedCode] = useState('');
  const [copied, setCopied] = useState('');
  const [buzzingRelay, setBuzzingRelay] = useState<number | null>(null);
  const [rerolling, setRerolling] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [submittingRequest, setSubmittingRequest] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [installTip, setInstallTip] = useState(() => (lsGet('dk-hide-install-tip', false) ? '' : installTipForBrowser()));
  const [dialog, confirm] = useConfirm();

  useBackLayer(tab !== 'gate', () => setTab('gate'));

  const data = usePortalData({
    gatePhone: gate.phoneNumber,
    username: session.user,
    activeTab: tab,
    selectedCode,
    onSelectCode: setSelectedCode,
    fastPollRequested: buzzingRelay !== null || rerolling,
    onError: setError,
  });

  const buzzOpen = async (relay: number, relayName: string) => {
    if (!data.me || data.offline) return;
    if (!await confirm({
      title: `Open ${relayName}?`,
      action: `Open ${relayName}`,
      color: 'blue',
      body: `This will momentarily open ${relayName} now and log a "Portal Open" entry for unit ${data.me.unit.directoryCode}.`,
    })) return;
    setBuzzingRelay(relay);
    setNotice('');
    setError('');
    try {
      const reply = await api<{ ok: boolean; alreadyOpen: boolean }>('POST', portalUrl(gate.phoneNumber, '/buzz'), {
        relay, code: data.me.unit.directoryCode,
      });
      setNotice(reply.alreadyOpen ? `${relayName} is already open.` : `${relayName} opened.`);
      await Promise.all([data.loadStatus(), tab === 'activity' ? data.loadActivity() : Promise.resolve()]);
    } catch (err) {
      setError(errorText(err));
      await data.loadStatus();
    } finally {
      setBuzzingRelay(null);
    }
  };

  const rerollCode = async () => {
    if (!data.me || data.offline) return;
    if (!await confirm({
      title: 'Get a new 4-digit gate code?',
      action: 'Get a new gate code',
      color: 'blue',
      body: `Your current entry code will be replaced with a new random 4-digit code (${data.me.reroll.remainingToday} of ${data.me.reroll.maxPerDay} daily changes left).`
        + (data.me.reroll.nextScheduledSend
          ? ` Changes are scheduled to sync to the gate at ${new Date(data.me.reroll.nextScheduledSend).toLocaleString()}, or sooner if management sends manually.`
          : ' Management will be notified to send your new code to the gate.'),
    })) return;
    setRerolling(true);
    setNotice('');
    setError('');
    try {
      const reply = await api<{ entryCode: string; syncedToGate: boolean | 'sending'; nextScheduledSend: string | null }>(
        'POST', portalUrl(gate.phoneNumber, '/reroll-code'), { code: data.me.unit.directoryCode },
      );
      if (reply.syncedToGate === 'sending') {
        setNotice('New gate code generated and sending to the gate now…');
      } else if (reply.nextScheduledSend) {
        setNotice(`New gate code saved. It will update on the gate automatically around ${new Date(reply.nextScheduledSend).toLocaleString()} (or sooner if management sends it).`);
      } else {
        setNotice('New gate code saved. Management has been notified to send it to the gate.');
      }
      await Promise.all([data.loadMe(), data.loadStatus()]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRerolling(false);
    }
  };

  const downloadPdf = async () => {
    if (!data.me) return;
    setDownloadingPdf(true);
    setError('');
    try {
      const res = await fetch(portalUrl(gate.phoneNumber, '/instructions.pdf'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: data.me.unit.directoryCode }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }).error || `HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ResidentInstructions-${data.me.unit.directoryCode}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`PDF download failed: ${errorText(err)}`);
    } finally {
      setDownloadingPdf(false);
    }
  };

  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(''), 2000);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const submitReport = async (row: TransactionRow, note: string): Promise<boolean> => {
    if (!data.me || data.offline) return false;
    setReporting(true);
    try {
      await api('POST', portalUrl(gate.phoneNumber, '/activity/report'), {
        code: data.me.unit.directoryCode,
        txSource: row.source || 'gate',
        txKey: row.txKey,
        note: note.trim(),
      });
      setNotice('Reported as suspicious. Community administrators have been alerted.');
      await data.loadActivity();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setReporting(false);
    }
  };

  const submitRequest = async ({ kind, phone, note }: { kind: ResidentRequest['kind']; phone: string; note: string }): Promise<boolean> => {
    if (!data.me || data.offline) return false;
    setSubmittingRequest(true);
    setError('');
    try {
      await api('POST', portalUrl(gate.phoneNumber, '/requests'), {
        code: data.me.unit.directoryCode,
        kind,
        payload: kind === 'phone' ? { phone } : {},
        note,
      });
      setNotice('Request sent to management.');
      await data.loadRequests();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setSubmittingRequest(false);
    }
  };

  const switchGate = async () => {
    await api('DELETE', '/api/session/gate').catch(() => {});
    onChange();
  };

  const signOut = async () => {
    clearPortalCache();
    await api('DELETE', '/api/session').catch(() => {});
    onChange();
  };

  return (
    <Box sx={{ minHeight: '100dvh', pb: 'calc(76px + env(safe-area-inset-bottom))', bgcolor: 'background.default' }}>
      {dialog}
      <AppBar position="sticky" color="default" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar sx={{ gap: 1, justifyContent: 'space-between' }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" noWrap sx={{ fontWeight: 700 }}>
              {data.me?.gate.siteName || gate.siteName || `Gate ${gate.phoneNumber}`}
            </Typography>
            {data.me && (
              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
                Unit #{data.me.unit.directoryCode}{data.me.unit.name ? ` · ${data.me.unit.name}` : ''}
              </Typography>
            )}
          </Box>
          <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
            {onBackToStaff && (
              <Button size="small" variant="outlined" onClick={onBackToStaff}>Staff view</Button>
            )}
            <Button size="small" variant="outlined" color="inherit" onClick={switchGate}>Gates</Button>
          </Stack>
        </Toolbar>
      </AppBar>

      <Container maxWidth="sm" sx={{ py: 2 }}>
        <Stack spacing={2}>
          {data.offline && (
            <Alert severity="warning">You&apos;re offline. Showing cached unit details (entry code hidden while offline).</Alert>
          )}
          {installTip && (
            <Alert
              severity="info"
              onClose={() => { lsSet('dk-hide-install-tip', true); setInstallTip(''); }}
            >
              {installTip}
            </Alert>
          )}
          {notice && <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>}
          {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}

          {tab === 'gate' && (
            <PortalGateTab
              me={data.me}
              loading={data.loadingMe}
              offline={data.offline}
              status={data.status}
              buzzingRelay={buzzingRelay}
              rerolling={rerolling}
              downloadingPdf={downloadingPdf}
              copied={copied}
              onSelectUnit={setSelectedCode}
              onBuzz={buzzOpen}
              onReroll={rerollCode}
              onDownloadPdf={downloadPdf}
              onCopy={copyText}
            />
          )}

          {tab === 'activity' && (
            <PortalActivityTab
              gatePhone={gate.phoneNumber}
              unitCode={data.me?.unit.directoryCode || ''}
              activity={data.activity}
              loading={data.loadingActivity}
              offline={data.offline}
              reporting={reporting}
              onRefresh={data.loadActivity}
              onSubmitReport={submitReport}
            />
          )}

          {tab === 'requests' && (
            <PortalRequestsTab
              me={data.me}
              loadingMe={data.loadingMe}
              requests={data.requests}
              loadingRequests={data.loadingRequests}
              offline={data.offline}
              submitting={submittingRequest}
              onRefresh={data.loadRequests}
              onSubmit={submitRequest}
            />
          )}

          {tab === 'account' && (
            <UserSettings session={session} onSaved={onSessionReload || onChange} resident onSignOut={signOut} />
          )}
        </Stack>
      </Container>

      <Paper
        elevation={4}
        sx={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 1100,
          pb: 'env(safe-area-inset-bottom)',
          borderTop: 1,
          borderColor: 'divider',
        }}
      >
        <BottomNavigation showLabels value={tab} onChange={(_, value: PortalTab) => setTab(value)}>
          <BottomNavigationAction label="Gate" value="gate" icon={<DoorFrontIcon />} />
          <BottomNavigationAction label="Activity" value="activity" icon={<HistoryIcon />} />
          <BottomNavigationAction label="Requests" value="requests" icon={<EditNoteIcon />} />
          <BottomNavigationAction label="Account" value="account" icon={<PersonIcon />} />
        </BottomNavigation>
      </Paper>
    </Box>
  );
}
