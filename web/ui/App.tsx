import { useCallback, useEffect, useState } from 'react';
import { Callout, Flex, Spinner, Theme } from '@radix-ui/themes';
import type { SessionReply } from '../../src/types.ts';
import { api, errorText, lsGet, lsSet, onSignedOut } from './api.ts';
import { FirstSetup, ForcedPasswordChange } from './Account.tsx';
import { Login } from './Login.tsx';
import { Gates } from './Gates.tsx';
import { GateApp } from './GateApp.tsx';
import { UpdateNotice } from './UpdateNotice.tsx';

export type SignedIn = Extract<SessionReply, { loggedIn: true }>;

// First-account setup, sign-in, a forced password change, then the gate list, then the open gate. The open gate is
// kept in the server session, so a reload opens the same gate. Dark mode is an account setting; this browser
// remembers the last one for the sign-in page.
export function App() {
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

  let page;
  if (error && !session) {
    page = <Callout.Root color="red" m="6"><Callout.Text>Server not reachable: {error}</Callout.Text></Callout.Root>;
  } else if (!session) {
    page = <Flex justify="center" p="9"><Spinner size="3" /></Flex>;
  } else if (!session.loggedIn) {
    page = session.setup ? <FirstSetup onDone={reload} /> : <Login onSignedIn={reload} />;
  } else if (session.mustChangePassword) {
    page = <ForcedPasswordChange user={session.user} onDone={reload} />;
  } else if (!session.gate) {
    page = <Gates session={session} onChange={reload} />;
  } else {
    page = <GateApp key={session.gate.phoneNumber} session={session} gate={session.gate} onChange={reload} />;
  }
  return <Theme appearance={dark ? 'dark' : 'light'} accentColor="blue" radius="medium">{page}<UpdateNotice /></Theme>;
}
