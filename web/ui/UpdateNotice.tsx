import { useEffect, useState } from 'react';
import { Button, Callout, Flex } from '@radix-ui/themes';

const CHECK_MS = 60000;
const BUILD = /\/assets\/index-[\w-]+\.js/;

// This page's build: the hashed script it was loaded from (none under `npm run dev`, which has no build).
const loaded = () => [...document.scripts].map((s) => BUILD.exec(s.src)?.[0]).find(Boolean) || null;

// Shows a notice when the server has a newer build of the page than the one open (after `npm run build`). Checks
// every minute and when the tab gets focus.
export function UpdateNotice() {
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    const mine = loaded();
    if (!mine) return undefined;
    const check = async () => {
      try {
        const res = await fetch('/', { cache: 'no-store' });
        const served = BUILD.exec(await res.text())?.[0];
        if (res.ok && served && served !== mine) setNewer(true);
      } catch { /* server not reachable: try again later */ }
    };
    const timer = setInterval(check, CHECK_MS);
    const onFocus = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onFocus); window.removeEventListener('focus', onFocus); };
  }, []);
  if (!newer) return null;
  return (
    <Callout.Root color="blue" style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 20,
      boxShadow: 'var(--shadow-4)' }}>
      <Flex align="center" gap="3">
        <Callout.Text>A new version of this page is available. Unsaved edits on the page are lost when it reloads.</Callout.Text>
        <Button size="1" onClick={() => location.reload()}>Reload</Button>
      </Flex>
    </Callout.Root>
  );
}
