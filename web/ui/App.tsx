import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Box, Button, CircularProgress, CssBaseline, IconButton, Stack, ThemeProvider, Typography } from '@mui/material';
import { StyledEngineProvider } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import type { SessionReply } from '../../src/types.ts';
import { api, errorText, lsGet, lsSet, onSignedOut } from './api.ts';
import { createAppTheme } from './theme.ts';
import { StepUpDialog } from './account/Passkeys.tsx';
import { APPROVAL_KEY } from './account/ApproveDevice.tsx';
import { EmailLink, FirstSetup, ForcedPasswordChange } from './account/SignInPages.tsx';
import { Login } from './Login.tsx';
import { Gates } from './Gates.tsx';
import { GateApp } from './GateApp.tsx';
import { ResidentPortal } from './portal/ResidentPortal.tsx';
import { UpdateNotice } from './UpdateNotice.tsx';

export type SignedIn = Extract<SessionReply, { loggedIn: true }>;

/**
 * First-account setup, sign-in, a forced password change, then the gate list, then the open gate. The open gate is
 * kept in the server session, so a reload opens the same gate. Dark mode is an account setting; this browser
 * remembers the last one for the sign-in page.
 * An email link in the address (#verify=, #reset=, #invite=), read once when the page opens.
 *
 * @returns `{ kind: 'verify' | 'reset' | 'invite'; token: string } | null` result.
 */
function linkInAddress(): { kind: 'verify' | 'reset' | 'invite'; token: string } | null {
  const match = /^#(verify|reset|invite)=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  return match ? { kind: match[1] as 'verify' | 'reset' | 'invite', token: match[2] } : null;
}

/**
 * An approval code from a scanned QR code (#approve=<code>, account/ApproveDevice.tsx): kept for User Settings →
 * Passkeys and removed from the address. True when there was one.
 *
 * @returns True when the condition holds.
 */
function approvalInAddress(): boolean {
  const match = /^#approve=([A-Za-z0-9-]{8,12})$/.exec(window.location.hash);
  if (!match) return false;
  sessionStorage.setItem(APPROVAL_KEY, match[1]);
  window.history.replaceState(null, '', window.location.pathname);
  return true;
}

/**
 * The result of a single sign-on redirect in the address (#sso=linked, #sso-error=<message>), read once and removed.
 *
 * @returns `{ ok: boolean; text: string } | null` result.
 */
function ssoInAddress(): { ok: boolean; text: string } | null {
  const match = /^#sso(-error)?=(.*)$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(null, '', window.location.pathname);
  let text = match[2];
  try { text = decodeURIComponent(match[2]); } catch { /* shown as it is */ }
  return match[1] ? { ok: false, text } : { ok: true, text: 'The sign-in was linked to your account.' };
}

/**
 * App React component.
 *
 * @returns Rendered React element.
 */
export function App() {
  const [link, setLink] = useState(linkInAddress);
  const [ssoNotice, setSsoNotice] = useState(ssoInAddress);
  const [approvalNotice, setApprovalNotice] = useState(approvalInAddress);
  const [session, setSession] = useState<SessionReply | null>(null);
  const [error, setError] = useState('');
  const [portalMode, setPortalMode] = useState(false);
  const [choseGateList, setChoseGateList] = useState(false);

  const reload = useCallback(async () => {
    try {
      const reply = await api<SessionReply>('GET', '/api/session');
      if (reply.loggedIn) lsSet('dk-theme', reply.dark);
      setSession(reply);
      setError('');
    } catch (err) { setError(errorText(err)); }
  }, []);

  useEffect(() => {
    onSignedOut(() => { reload(); });
    reload();
  }, [reload]);
  // Not reached yet (offline, or the server restarting): try again when the connection comes back.
  useEffect(() => {
    if (!error || session) return undefined;
    window.addEventListener('online', reload);
    return () => window.removeEventListener('online', reload);
  }, [error, session, reload]);

  const dark = session && session.loggedIn ? session.dark : lsGet('dk-theme', false);
  const theme = useMemo(() => createAppTheme(dark), [dark]);
  // The phone's status bar and the page background follow the page's light or dark mode (index.html has the
  // system-based colours until now).
  useEffect(() => {
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta, i) => {
      if (i) { meta.remove(); return; }
      meta.removeAttribute('media');
      meta.setAttribute('content', theme.palette.background.paper);
    });
  }, [dark, theme.palette.background.paper]);

  const linkDone = () => { window.history.replaceState(null, '', window.location.pathname); setLink(null); reload(); };

  const renderPage = (): ReactNode => {
    if (link) return <EmailLink kind={link.kind} sso={session ? session.sso : []} token={link.token} onDone={linkDone} />;
    if (error && !session) {
      return (
        <Stack spacing={2} sx={{ alignItems: 'flex-start', m: { xs: 2, sm: 4 } }}>
          <Alert severity="error" role="alert">
            Can't reach the gate server. Check your internet connection, then try again. It tries again by itself when the connection
            comes back.
          </Alert>
          <Button variant="contained" onClick={() => { setError(''); reload(); }}>Try again</Button>
          <Typography variant="caption" color="text.secondary">Details: {error}</Typography>
        </Stack>
      );
    }
    if (!session) return <Box sx={{ display: 'flex', justifyContent: 'center', p: 8 }}><CircularProgress /></Box>;
    if (!session.loggedIn) {
      return session.setup ? <FirstSetup onDone={reload} /> : <Login onSignedIn={reload} emailEnabled={session.emailEnabled} sso={session.sso} />;
    }
    if (session.mustChangePassword) return <ForcedPasswordChange user={session.user} onDone={reload} />;
    if (!session.gate) return <Gates session={session} autoOpen={!choseGateList} onChange={() => { setChoseGateList(false); setPortalMode(false); reload(); }} />;
    if (session.gate.role === 'resident' || portalMode) {
      return (
        <ResidentPortal
          key={session.gate.phoneNumber}
          session={session}
          gate={session.gate}
          onChange={() => { setChoseGateList(true); setPortalMode(false); reload(); }}
          onSessionReload={reload}
          onBackToStaff={session.gate.role !== 'resident' ? () => setPortalMode(false) : undefined}
        />
      );
    }
    return (
      <GateApp
        key={session.gate.phoneNumber}
        session={session}
        gate={session.gate}
        onChange={reload}
        onOpenPortal={() => setPortalMode(true)}
      />
    );
  };
  return (
    <StyledEngineProvider enableCssLayer>
      <ThemeProvider theme={theme}>
        <CssBaseline />
      {ssoNotice && (
        <Alert
          severity={ssoNotice.ok ? 'success' : 'error'}
          role="alert"
          sx={{ m: 2 }}
          action={
            <IconButton size="small" color="inherit" aria-label="Dismiss" onClick={() => setSsoNotice(null)}>
              <CloseIcon fontSize="small" />
            </IconButton>
          }
        >
          {ssoNotice.text}
        </Alert>
      )}
      {approvalNotice && (
        <Alert
          severity="info"
          role="status"
          sx={{ m: 2 }}
          action={
            <IconButton size="small" color="inherit" aria-label="Dismiss" onClick={() => setApprovalNotice(false)}>
              <CloseIcon fontSize="small" />
            </IconButton>
          }
        >
          Approval code received. Sign in, then open User Settings → Passkeys and click Add a passkey (within 10 minutes).
        </Alert>
      )}
      {renderPage()}
      {session && session.loggedIn && <StepUpDialog />}
      <UpdateNotice />
      </ThemeProvider>
    </StyledEngineProvider>
  );
}
