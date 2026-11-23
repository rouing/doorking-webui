/**
 * @module web/ui/portal/PortalGateTab
 *
 * Resident Portal "Gate" tab: unit switcher, Buzz Me In buttons, masked 4-digit entry code (30s auto-hide),
 * code reroll, instructions PDF download, welcome instructions copy, and assigned remotes/cards.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Divider, IconButton, LinearProgress,
  Paper, Skeleton, Stack, Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import KeyIcon from '@mui/icons-material/Key';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import type { PortalMeReply, PortalStatusReply } from '../../../src/types.ts';
import { buildWelcomeMessage, fmtPhone } from '../../../src/shared.ts';

const CODE_AUTO_HIDE_MS = 30_000;

interface PortalGateTabProps {
  me: PortalMeReply | null;
  loading: boolean;
  offline: boolean;
  status: PortalStatusReply | null;
  buzzingRelay: number | null;
  rerolling: boolean;
  downloadingPdf: boolean;
  copied: string;
  onSelectUnit: (code: string) => void;
  onBuzz: (relay: number, relayName: string) => void;
  onReroll: () => void;
  onDownloadPdf: () => void;
  onCopy: (label: string, text: string) => void;
}

export function PortalGateTab({
  me, loading, offline, status, buzzingRelay, rerolling, downloadingPdf, copied,
  onSelectUnit, onBuzz, onReroll, onDownloadPdf, onCopy,
}: PortalGateTabProps) {
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    if (!showCode) return undefined;
    const id = window.setTimeout(() => setShowCode(false), CODE_AUTO_HIDE_MS);
    return () => window.clearTimeout(id);
  }, [showCode]);

  if (loading && !me) {
    return (
      <Stack spacing={2}>
        <Card><CardContent><Stack spacing={1.5}><Skeleton variant="text" width="40%" height={30} /><Skeleton variant="rounded" height={56} /></Stack></CardContent></Card>
        <Card><CardContent><Stack spacing={1.5}><Skeleton variant="text" width="45%" height={30} /><Skeleton variant="rounded" height={80} /></Stack></CardContent></Card>
      </Stack>
    );
  }
  if (!me) return null;

  const gateBusy = Boolean(status && !status.available);
  const welcomeText = buildWelcomeMessage({
    siteName: me.gate.siteName,
    residentName: me.unit.name,
    directoryCode: me.unit.directoryCode,
    entryCode: me.unit.entryCode,
    grantAccessDigit: me.gate.grantAccessDigit,
    adminPhone: me.gate.adminPhone,
    hidden: me.unit.hidden,
    cards: me.unit.cards.map((c) => c.number),
  });

  return (
    <Stack spacing={2}>
      {me.units.length > 1 && (
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          {me.units.map((u) => (
            <Chip
              key={u.directoryCode}
              clickable
              color={u.directoryCode === me.unit.directoryCode ? 'primary' : 'default'}
              label={`Unit ${u.directoryCode}${u.name ? ` · ${u.name}` : ''}`}
              onClick={() => onSelectUnit(u.directoryCode)}
            />
          ))}
        </Stack>
      )}

      {me.portal.buzzEnabled && (
        <Card>
          <CardContent>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="h6" component="h2">Open Gate</Typography>
                {gateBusy ? (
                  <Chip size="small" color="warning" label={status?.percent != null ? `Busy · ${status.percent}%` : 'Busy'} />
                ) : status && status.cooldownSeconds > 0 ? (
                  <Chip size="small" label={`Wait ${status.cooldownSeconds}s`} />
                ) : (
                  <Chip size="small" color="success" label="Ready" />
                )}
              </Stack>
              {gateBusy && (
                <Stack spacing={0.5}>
                  <LinearProgress
                    variant={status?.percent != null ? 'determinate' : 'indeterminate'}
                    value={status?.percent ?? undefined}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {status?.phase || 'Gate connection in progress…'}
                  </Typography>
                </Stack>
              )}
              <Stack spacing={1}>
                {(me.portal.buzzRelayLabels || []).map(({ relay, name }) => {
                  const isBuzzing = buzzingRelay === relay;
                  const disabled = offline || gateBusy || Boolean(status && status.cooldownSeconds > 0) || buzzingRelay !== null;
                  return (
                    <Button
                      key={relay}
                      variant="contained"
                      color="success"
                      size="large"
                      fullWidth
                      disabled={disabled}
                      startIcon={isBuzzing ? <CircularProgress size={18} color="inherit" /> : <LockOpenIcon />}
                      onClick={() => onBuzz(relay, name)}
                      sx={{ py: 1.5, fontWeight: 700 }}
                    >
                      {isBuzzing ? `Opening ${name}…` : `Open ${name}`}
                    </Button>
                  );
                })}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <Typography variant="h6" component="h2">My Gate Access</Typography>
              <Chip size="small" color="primary" label={`Unit #${me.unit.directoryCode}`} />
            </Stack>

            <Paper variant="outlined" sx={{ p: 1.75 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <Box>
                  <Typography variant="caption" color="text.secondary">4-Digit Entry Code</Typography>
                  <Typography variant="h5" sx={{ fontFamily: 'monospace', fontWeight: 700, letterSpacing: 2 }}>
                    {me.unit.entryCode ? (showCode ? `#${me.unit.entryCode}` : '#••••') : (offline ? 'Hidden offline' : 'None assigned')}
                  </Typography>
                </Box>
                {me.unit.entryCode && (
                  <Stack direction="row" spacing={0.5}>
                    <IconButton
                      aria-label={showCode ? 'Hide entry code' : 'Show entry code'}
                      onClick={() => setShowCode((v) => !v)}
                    >
                      {showCode ? <VisibilityOffIcon /> : <VisibilityIcon />}
                    </IconButton>
                    <IconButton
                      aria-label="Copy entry code"
                      onClick={() => onCopy('code', me.unit.entryCode)}
                    >
                      {copied === 'code' ? <CheckIcon color="success" /> : <ContentCopyIcon />}
                    </IconButton>
                  </Stack>
                )}
              </Stack>
            </Paper>

            {me.reroll.pendingSend && (
              <Alert severity="info">
                Your new gate code is saved and waiting to sync to the gate
                {me.reroll.nextScheduledSend ? ` (scheduled around ${new Date(me.reroll.nextScheduledSend).toLocaleString()})` : ''}.
              </Alert>
            )}

            <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
              {me.portal.maxRerollsPerDay > 0 && (
                <Button
                  variant="outlined"
                  startIcon={rerolling ? <CircularProgress size={16} color="inherit" /> : <KeyIcon />}
                  disabled={offline || rerolling || me.reroll.remainingToday <= 0}
                  onClick={() => { setShowCode(true); onReroll(); }}
                >
                  New gate code ({me.reroll.remainingToday}/{me.reroll.maxPerDay} left)
                </Button>
              )}
              <Button
                variant="outlined"
                startIcon={downloadingPdf ? <CircularProgress size={16} color="inherit" /> : <PictureAsPdfIcon />}
                disabled={offline || downloadingPdf}
                onClick={onDownloadPdf}
              >
                Instructions PDF
              </Button>
              <Button
                variant="outlined"
                color="inherit"
                startIcon={copied === 'welcome' ? <CheckIcon color="success" /> : <ContentCopyIcon />}
                onClick={() => onCopy('welcome', welcomeText)}
              >
                {copied === 'welcome' ? 'Copied' : 'Copy instructions'}
              </Button>
            </Stack>

            <Divider />

            <Stack spacing={0.75}>
              <Typography variant="body2">
                <strong>Call-box phone:</strong> {me.unit.phone ? fmtPhone(me.unit.phone) : 'Not set'}
              </Typography>
              <Typography variant="body2">
                <strong>Directory listing:</strong> {me.unit.hidden ? 'Unlisted (dial code directly)' : 'Listed by name'}
              </Typography>
              {me.gate.adminPhone && (
                <Typography variant="body2">
                  <strong>Management phone:</strong> {fmtPhone(me.gate.adminPhone)}
                </Typography>
              )}
            </Stack>

            {me.unit.cards.length > 0 && (
              <>
                <Divider />
                <Stack spacing={1}>
                  <Typography variant="subtitle2">Assigned Remotes &amp; Cards ({me.unit.cards.length})</Typography>
                  <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                    {me.unit.cards.map((card) => (
                      <Chip key={card.number} size="small" label={`${card.device} #${card.number}`} />
                    ))}
                  </Stack>
                </Stack>
              </>
            )}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
