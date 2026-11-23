/**
 * @module web/ui/account/ApproveDevice
 *
 * Approving another device to add a passkey: for when the account's passkey is on a device that can't confirm for
 * another one (a laptop can't scan a QR code). This device confirms with its passkey (the step-up dialog) and gets a
 * one-time code; the new device signs in and enters it under Passkeys, or scans the QR code, which opens the page
 * there with the code filled in (App keeps it as APPROVAL_KEY).
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import QRCode from 'qrcode';
import { api, errorText } from '../api.ts';

export const APPROVAL_KEY = 'dk-approve'; // sessionStorage: a code from a scanned QR code

interface Approval { code: string; expiresAt: string }

const shown = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

interface ApprovalQrProps {
  code: string;
}

/**
 * The QR code of the page's address with the code (drawn on a canvas: the page's content policy allows no data: images).
 *
 * @param props - Component props.
 * @param props.code - One-time device approval code.
 * @returns Rendered React element.
 */
function ApprovalQr({ code }: ApprovalQrProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current) QRCode.toCanvas(canvas.current, `${window.location.origin}/#approve=${code}`, { width: 180, margin: 1 }).catch(() => {});
  }, [code]);
  return <canvas ref={canvas} aria-label="QR code with the approval code" style={{ borderRadius: 8, background: '#fff' }} />;
}

/**
 * ApproveDevice React component.
 *
 * @returns Rendered React element.
 */
export function ApproveDevice() {
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setError('');
    setBusy(true);
    try { setApproval(await api<Approval>('POST', '/api/me/passkeys/approval', {})); } catch (err) { setError(errorText(err)); }
    setBusy(false);
  };
  return (
    <Stack spacing={1.5}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Add a passkey on another device</Typography>
      <Typography variant="body2" color="text.secondary">
        If your new phone or computer has no passkey for this site yet, approve it from here: you get a code for it, valid for 10 minutes.
        (If your passkey is on a phone, you can also confirm on the new device by choosing a phone or tablet in its browser&apos;s prompt.)
      </Typography>
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="outlined" disabled={busy} onClick={create}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}>
          {approval ? 'New code' : 'Approve another device'}
        </Button>
      </Stack>
      {error && <Alert severity="error" role="alert">{error}</Alert>}
      {approval && (
        <Stack direction="row" spacing={3} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <ApprovalQr code={approval.code} />
          <Stack spacing={0.5}>
            <Box component="code" sx={{ fontFamily: 'monospace', fontSize: '1.75rem', fontWeight: 700, letterSpacing: '0.1em' }}>
              {shown(approval.code)}
            </Box>
            <Typography variant="body2" color="text.secondary">
              Valid until {new Date(approval.expiresAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
            </Typography>
            <Typography variant="body2" color="text.secondary">
              On the new device, scan the QR code with its camera, or sign in there and enter the code under User Settings → Passkeys.
            </Typography>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}
