import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';
import { useBackLayer } from './back.ts';

interface Ask { title: string; body?: ReactNode; action: string; color?: 'red' | 'blue'; maxWidth?: string }

/**
 * A confirmation dialog: `confirm({ title, body, action })` resolves true when the action button is clicked.
 * Render `dialog` once in the component.
 *
 * @returns `[ReactNode, (ask: Ask) => Promise<boolean>]` result.
 */
export function useConfirm(): [ReactNode, (ask: Ask) => Promise<boolean>] {
  const [ask, setAsk] = useState<Ask | null>(null);
  const resolve = useRef<(ok: boolean) => void>(() => {});
  const confirm = useCallback((next: Ask) => new Promise<boolean>((res) => { resolve.current = res; setAsk(next); }), []);
  const close = (ok: boolean) => { setAsk(null); resolve.current(ok); };
  useBackLayer(ask !== null, () => close(false));
  const dialog = (
    <Dialog open={ask !== null} onClose={() => close(false)} maxWidth="sm" fullWidth
      slotProps={ask?.maxWidth ? { paper: { sx: { maxWidth: ask.maxWidth } } } : undefined}>
      <DialogTitle>{ask?.title}</DialogTitle>
      {ask?.body && (
        <DialogContent>
          <DialogContentText component="div" sx={{ color: 'text.primary' }}>{ask.body}</DialogContentText>
        </DialogContent>
      )}
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={() => close(false)}>Cancel</Button>
        <Button variant="contained" color={ask?.color === 'red' ? 'error' : 'primary'} onClick={() => close(true)}>
          {ask?.action}
        </Button>
      </DialogActions>
    </Dialog>
  );
  return [dialog, confirm];
}
