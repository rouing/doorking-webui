/**
 * @module web/ui/portal/PortalGateTab
 *
 * Resident Portal "Gate" tab styled to match the native Android Material 3 Expressive design:
 * standalone root Open <Relay> button(s) carrying live status/color, borderless tonal My Gate Access block,
 * and M3 Expressive segmented Assigned remotes & cards list.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Divider, IconButton,
  Paper, Skeleton, Stack, Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CreditCardIcon from '@mui/icons-material/CreditCard';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import KeyIcon from '@mui/icons-material/Key';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import ScheduleIcon from '@mui/icons-material/Schedule';
import SensorsIcon from '@mui/icons-material/Sensors';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import type { PortalMeReply, PortalStatusReply } from '../types.ts';
import { buildWelcomeMessage, fmtPhone } from '../lib/shared.ts';

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
  onReroll: () => Promise<boolean>;
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
        <Skeleton variant="rounded" height={56} sx={{ borderRadius: 2 }} />
        <Card><CardContent><Stack spacing={1.5}><Skeleton variant="text" width="45%" height={30} /><Skeleton variant="rounded" height={80} /></Stack></CardContent></Card>
      </Stack>
    );
  }
  if (!me) return null;

  const isBusy = Boolean(status && !status.available);
  const isCooldown = !isBusy && Boolean(status && status.cooldownSeconds > 0);
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

      {me.portal.buzzEnabled && (me.portal.buzzRelayLabels || []).map(({ relay, name }) => {
        const isBuzzing = buzzingRelay === relay;
        const disabled = offline || isBusy || isCooldown || buzzingRelay !== null;
        const label = isBuzzing
          ? `Opening ${name}…`
          : isBusy
            ? (status?.percent != null ? `${name} · Busy ${status.percent}%` : `${name} · Busy`)
            : isCooldown
              ? `${name} · Wait ${status!.cooldownSeconds}s`
              : `Open ${name}`;
        const icon = isBuzzing
          ? <CircularProgress size={18} color="inherit" />
          : isBusy
            ? <HourglassTopIcon />
            : isCooldown
              ? <ScheduleIcon />
              : <LockOpenIcon />;
        return (
          <Button
            key={relay}
            variant="contained"
            size="large"
            fullWidth
            disabled={disabled}
            startIcon={icon}
            onClick={() => onBuzz(relay, name)}
            sx={(theme) => {
              const bg = isBusy
                ? theme.palette.warning.main
                : isCooldown
                  ? 'var(--md-surface-highest)'
                  : theme.palette.success.main;
              const fg = isBusy
                ? theme.palette.warning.contrastText
                : isCooldown
                  ? theme.palette.text.secondary
                  : theme.palette.success.contrastText;
              return {
                minHeight: 56,
                borderRadius: 2,
                fontWeight: 700,
                fontSize: '1rem',
                backgroundColor: bg,
                color: fg,
                '&:hover': { backgroundColor: bg, filter: 'brightness(1.06)' },
                '&.Mui-disabled': { backgroundColor: bg, color: fg, opacity: offline ? 0.6 : 1 },
              };
            }}
          >
            {label}
          </Button>
        );
      })}

      <Card sx={{ bgcolor: 'var(--md-surface-high)' }}>
        <CardContent>
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <Typography variant="h6" component="h2">My Gate Access</Typography>
              <Chip size="small" color="primary" label={`Unit #${me.unit.directoryCode}`} />
            </Stack>

            <Paper elevation={0} sx={{ p: 1.75, borderRadius: 2, bgcolor: 'var(--md-surface-lowest)' }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <Box>
                  <Typography variant="caption" color="text.secondary">Entry code</Typography>
                  <Typography variant="h5" sx={{ fontFamily: 'monospace', fontWeight: 700, letterSpacing: 2, fontVariantNumeric: 'tabular-nums' }}>
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

            <Stack spacing={1}>
              {me.portal.maxRerollsPerDay > 0 && (
                <Button
                  variant="outlined"
                  fullWidth
                  startIcon={rerolling ? <CircularProgress size={16} color="inherit" /> : <KeyIcon />}
                  disabled={offline || rerolling || me.reroll.remainingToday <= 0}
                  onClick={async () => {
                    if (await onReroll()) setShowCode(true);
                  }}
                >
                  Get a new gate code ({me.reroll.remainingToday}/{me.reroll.maxPerDay} left today)
                </Button>
              )}
              <Stack direction="row" spacing={1}>
                <Button
                  variant="outlined"
                  startIcon={downloadingPdf ? <CircularProgress size={16} color="inherit" /> : <PictureAsPdfIcon />}
                  disabled={offline || downloadingPdf}
                  onClick={onDownloadPdf}
                  sx={{ flex: 1 }}
                >
                  Instructions PDF
                </Button>
                <Button
                  variant="outlined"
                  color="inherit"
                  startIcon={copied === 'welcome' ? <CheckIcon color="success" /> : <ContentCopyIcon />}
                  onClick={() => onCopy('welcome', welcomeText)}
                  sx={{ flex: 1 }}
                >
                  {copied === 'welcome' ? 'Copied' : 'Copy text'}
                </Button>
              </Stack>
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
          </Stack>
        </CardContent>
      </Card>

      {me.unit.cards.length > 0 && (
        <Card sx={{ bgcolor: 'var(--md-surface-high)' }}>
          <CardContent>
            <Stack spacing={1.5}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="h6" component="h2">Assigned remotes &amp; cards</Typography>
                <Chip size="small" color="primary" label={me.unit.cards.length} />
              </Stack>
              <Stack spacing={0.5}>
                {me.unit.cards.map((card, index) => {
                  const topRadius = index === 0 ? 12 : 4;
                  const bottomRadius = index === me.unit.cards.length - 1 ? 12 : 4;
                  const isRemote = /click|remote|trans/i.test(card.device);
                  const isKey = /key|fob/i.test(card.device);
                  return (
                    <Paper
                      key={card.number}
                      elevation={0}
                      onClick={() => onCopy(`card-${card.number}`, card.number)}
                      sx={{
                        px: 1.5,
                        py: 1.25,
                        bgcolor: 'var(--md-surface-lowest)',
                        borderRadius: `${topRadius}px ${topRadius}px ${bottomRadius}px ${bottomRadius}px`,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1.5,
                      }}
                    >
                      <Box
                        sx={{
                          width: 34,
                          height: 34,
                          borderRadius: '50%',
                          bgcolor: 'var(--md-secondary-container)',
                          color: 'var(--md-on-secondary-container)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {isRemote ? <SensorsIcon fontSize="small" /> : isKey ? <KeyIcon fontSize="small" /> : <CreditCardIcon fontSize="small" />}
                      </Box>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography variant="subtitle2" sx={{ fontFamily: 'monospace', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                          #{card.number}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {card.device || 'Access Card'}
                        </Typography>
                      </Box>
                      {copied === `card-${card.number}`
                        ? <CheckIcon fontSize="small" color="success" />
                        : <ContentCopyIcon fontSize="small" sx={{ color: 'text.secondary' }} />}
                    </Paper>
                  );
                })}
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}
