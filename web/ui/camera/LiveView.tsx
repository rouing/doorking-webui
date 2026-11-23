import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, IconButton, Paper, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import RemoveIcon from '@mui/icons-material/Remove';
import { Choice } from '../panes/fields.tsx';
import type { CameraSettings } from '../../../src/types.ts';
import { gateUrl } from '../api.ts';
import { useBackLayer } from '../back.ts';

const PAUSE_MS = 10 * 60000;
type Status = { kind: 'connecting' | 'playing' } | { kind: 'stopped'; text: string; retry: boolean; isError?: boolean };

interface LiveViewProps {
  phone: string;
  settings: CameraSettings;
}

/**
 * Live camera: the top-right camera button opens a window with the server's MJPEG stream in an <img>.
 * Closing or minimizing the window ends the stream, and it pauses after 10 minutes.
 *
 * @param props - Component props.
 * @param props.phone - Gate system phone number (digits or formatted).
 * @param props.settings - Settings map or configuration.
 * @returns Rendered React element.
 */
export function LiveView({ phone, settings }: LiveViewProps) {
  const [dock, setDock] = useState<'closed' | 'min' | 'open'>('closed');
  useBackLayer(dock === 'open', () => setDock('closed'));
  const [channel, setChannel] = useState(String(settings.channels[0]?.channel ?? 1));
  const [quality, setQuality] = useState('low');
  const [status, setStatus] = useState<Status>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (!settings.channels.some((saved) => String(saved.channel) === channel)) setChannel(String(settings.channels[0]?.channel ?? 1));
  }, [settings, channel]);

  useEffect(() => {
    if (dock === 'closed') return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDock('closed');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dock]);

  // While connecting, watch for the first picture; while streaming, pause after PAUSE_MS.
  useEffect(() => {
    if (dock !== 'open' || status.kind === 'stopped') return undefined;
    const watch = setInterval(() => {
      if (img.current && img.current.naturalWidth) { clearInterval(watch); setStatus({ kind: 'playing' }); }
    }, 300);
    const pause = setTimeout(() => setStatus({ kind: 'stopped', text: 'Live view paused after 10 minutes.', retry: true }), PAUSE_MS);
    return () => { clearInterval(watch); clearTimeout(pause); };
  }, [dock, attempt, status.kind === 'stopped']);

  const start = () => { setStatus({ kind: 'connecting' }); setAttempt(Date.now()); };
  const streaming = dock === 'open' && status.kind !== 'stopped';
  const src = streaming ? gateUrl(phone, `/cameras/live/${channel}?quality=${quality}&t=${attempt}`) : undefined;

  const toggleOpen = () => {
    if (dock === 'open') { setDock('closed'); return; }
    setDock('open');
    start();
  };

  return (
    <>
      <IconButton
        color="primary"
        title="View Camera"
        aria-label="View Camera"
        onClick={toggleOpen}
        className="live-toggle"
        sx={{
          bgcolor: 'background.paper',
          border: 1,
          borderColor: 'divider',
          boxShadow: 2,
          '&:hover': { bgcolor: 'action.hover' },
        }}
      >
        <PhotoCameraIcon />
      </IconButton>
      {dock !== 'closed' && (
        <Paper
          elevation={6}
          className="live-window"
          sx={{
            top: 56,
            right: 14,
            width: 420,
            maxWidth: 'calc(100vw - 28px)',
            p: 1.5,
            border: 1,
            borderColor: 'divider',
          }}
        >
          <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', mb: dock === 'open' ? 1 : 0 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>View Camera</Typography>
            {settings.channels.length > 1 && (
              <Choice
                size="1"
                title="Channel"
                ariaLabel="Channel"
                value={channel}
                onChange={(value) => { setChannel(value); start(); }}
                options={settings.channels.map((ch) => [String(ch.channel), ch.name || `Channel ${ch.channel}`] as const)}
              />
            )}
            <Choice
              size="1"
              title="Quality"
              ariaLabel="Quality"
              value={quality}
              onChange={(value) => { setQuality(value); start(); }}
              options={[['low', 'Low quality'], ['high', 'High quality']]}
            />
            <Box sx={{ flexGrow: 1 }} />
            <IconButton
              size="small"
              aria-label={dock === 'min' ? 'Restore' : 'Minimize'}
              title={dock === 'min' ? 'Restore' : 'Minimize'}
              onClick={() => { setDock(dock === 'min' ? 'open' : 'min'); if (dock === 'min') start(); }}
            >
              {dock === 'min' ? <OpenInFullIcon fontSize="small" /> : <RemoveIcon fontSize="small" />}
            </IconButton>
            <IconButton size="small" aria-label="Close" title="Close" onClick={() => setDock('closed')}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>
          {dock === 'open' && (
            <div className="live-body">
              {src && (
                <img
                  ref={img}
                  src={src}
                  alt="Live camera view"
                  hidden={status.kind !== 'playing'}
                  onError={() => setStatus({
                    kind: 'stopped',
                    text: 'Could not show the live view. The recorder may be offline or busy.',
                    retry: true,
                    isError: true,
                  })}
                />
              )}
              {status.kind === 'connecting' && <Typography variant="body2">Connecting to the recorder…</Typography>}
              {status.kind === 'stopped' && (
                <Stack spacing={1.5} sx={{ alignItems: 'center', p: 2, maxWidth: '100%' }}>
                  <Alert severity={status.isError ? 'error' : 'info'}>{status.text}</Alert>
                  {status.retry && <Button variant="contained" size="small" onClick={start}>Try again</Button>}
                </Stack>
              )}
            </div>
          )}
        </Paper>
      )}
    </>
  );
}
