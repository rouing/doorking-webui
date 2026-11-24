import { Alert, Button, Snackbar } from '@mui/material';
import { useRegisterSW } from 'virtual:pwa-register/react';

const CHECK_MS = 60000;

/**
 * Registers the service worker (vite.config.mts) and shows a notice when the server has a newer build of the page
 * than the one open (after `npm run build`). Checks every minute and when the tab gets focus. None under
 * `npm run dev`, which has no service worker.
 *
 * @returns Rendered React element.
 */
export function UpdateNotice() {
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      const check = () => { if (navigator.onLine) registration.update().catch(() => { /* server not reachable: try again later */ }); };
      setInterval(check, CHECK_MS);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    },
  });
  return (
    <Snackbar open={needRefresh} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
      <Alert
        severity="info"
        variant="filled"
        action={
          <>
            <Button color="inherit" size="small" variant="outlined" onClick={() => updateServiceWorker(true)} sx={{ mr: 0.5 }}>
              Reload
            </Button>
            <Button color="inherit" size="small" onClick={() => setNeedRefresh(false)}>
              Later
            </Button>
          </>
        }
      >
        A new version of this page is available. Unsaved edits on the page are lost when it reloads.
      </Alert>
    </Snackbar>
  );
}
