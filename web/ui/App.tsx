import { useCallback, useEffect, useState } from 'react';
import { Callout, Flex, Spinner, Theme } from '@radix-ui/themes';
import type { SessionReply } from '../../src/types.ts';
import { api, errorText, lsGet, lsSet, onSignedOut } from './api.ts';
import { EmailLink, FirstSetup, ForcedPasswordChange } from './Account.tsx';
import { Login } from './Login.tsx';
import { Gates } from './Gates.tsx';
import { GateApp } from './GateApp.tsx';
import { UpdateNotice } from './UpdateNotice.tsx';

export type SignedIn = Extract<SessionReply, { loggedIn: true }>;

// First-account setup, sign-in, a forced password change, then the gate list, then the open gate. The open gate is
// kept in the server session, so a reload opens the same gate. Dark mode is an account setting; this browser
// remembers the last one for the sign-in page.
// An email link in the address (#verify=, #reset=, #invite=), read once when the page opens.
function linkInAddress(): { kind: 'verify' | 'reset' | 'invite'; token: string } | null {
  const m = /^#(verify|reset|invite)=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  return m ? { kind: m[1] as 'verify' | 'reset' | 'invite', token: m[2] } : null;
}

export function App() {
  const [link, setLink] = useState(linkInAddress);
  const [session, setSession] = useState<SessionReply | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const s = await api<SessionReply>('GET', '/api/session');
      if (s.loggedIn) lsSet('dk-theme', s.dark);
      setSession(s);
      setError('');
    } catch (e) { setError(errorText(e)); }
  }, []);

  useEffect(() => {
    onSignedOut(() => { reload(); });
    reload();
  }, [reload]);

  const dark = session && session.loggedIn ? session.dark : lsGet('dk-theme', false);

  const linkDone = () => { window.history.replaceState(null, '', window.location.pathname); setLink(null); reload(); };

  let page;
  if (link) {
    page = <EmailLink kind={link.kind} token={link.token} onDone={linkDone} />;
  } else if (error && !session) {
    page = <Callout.Root color="red" m="6"><Callout.Text>Server not reachable: {error}</Callout.Text></Callout.Root>;
  } else if (!session) {
    page = <Flex justify="center" p="9"><Spinner size="3" /></Flex>;
  } else if (!session.loggedIn) {
    page = session.setup ? <FirstSetup onDone={reload} /> : <Login onSignedIn={reload} emailEnabled={session.emailEnabled} />;
  } else if (session.mustChangePassword) {
    page = <ForcedPasswordChange user={session.user} onDone={reload} />;
  } else if (!session.gate) {
    page = <Gates session={session} onChange={reload} />;
  } else {
    page = <GateApp key={session.gate.phoneNumber} session={session} gate={session.gate} onChange={reload} />;
  }
  return <Theme appearance={dark ? 'dark' : 'light'} accentColor="blue" radius="medium">{page}<UpdateNotice /></Theme>;
}
