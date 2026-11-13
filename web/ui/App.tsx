import { useCallback, useEffect, useState } from 'react';
import { Callout, Flex, Spinner, Theme } from '@radix-ui/themes';
import type { SessionReply } from '../../src/types.ts';
import { api, errorText, lsGet, lsSet, onSignedOut } from './api.ts';
import { Login } from './Login.tsx';
import { Gates } from './Gates.tsx';
import { GateApp } from './GateApp.tsx';
import { UpdateNotice } from './UpdateNotice.tsx';

export type SignedIn = Extract<SessionReply, { loggedIn: true }>;

// Sign-in, then the gate list, then the open gate. The open gate is kept in the server session, so a reload
// opens the same gate.
export function App() {
  const [dark, setDark] = useState(() => lsGet('dk-theme', false));
  const [session, setSession] = useState<SessionReply | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try { setSession(await api<SessionReply>('GET', '/api/session')); setError(''); } catch (e) { setError(errorText(e)); }
  }, []);

  useEffect(() => {
    onSignedOut(() => setSession({ loggedIn: false }));
    reload();
  }, [reload]);

  const toggleDark = () => { lsSet('dk-theme', !dark); setDark(!dark); };

  let page;
  if (error && !session) {
    page = <Callout.Root color="red" m="6"><Callout.Text>Server not reachable: {error}</Callout.Text></Callout.Root>;
  } else if (!session) {
    page = <Flex justify="center" p="9"><Spinner size="3" /></Flex>;
  } else if (!session.loggedIn) {
    page = <Login onSignedIn={reload} />;
  } else if (!session.gate) {
    page = <Gates session={session} onChange={reload} />;
  } else {
    page = <GateApp key={session.gate.phoneNumber} session={session} gate={session.gate} onChange={reload}
      dark={dark} onToggleDark={toggleDark} />;
  }
  return <Theme appearance={dark ? 'dark' : 'light'} accentColor="blue" radius="medium">{page}<UpdateNotice /></Theme>;
}
