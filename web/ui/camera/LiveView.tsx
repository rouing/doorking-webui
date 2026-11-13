import { useEffect, useRef, useState } from 'react';
import { Button, Card, Flex, IconButton, Select, Text } from '@radix-ui/themes';
import type { CameraSettings } from '../../../src/types.ts';
import { gateUrl } from '../api.ts';

const PAUSE_MS = 10 * 60000;
type Status = { kind: 'connecting' | 'playing' } | { kind: 'stopped'; text: string; retry: boolean };

// Live camera: the top-right camera button opens a window with the server's MJPEG stream in an <img>.
// Closing or minimizing the window ends the stream, and it pauses after 10 minutes.
export function LiveView({ phone, settings }: { phone: string; settings: CameraSettings }) {
  const [dock, setDock] = useState<'closed' | 'min' | 'open'>('closed');
  const [channel, setChannel] = useState(String(settings.channels[0]?.channel ?? 1));
  const [quality, setQuality] = useState('low');
  const [status, setStatus] = useState<Status>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (!settings.channels.some((c) => String(c.channel) === channel)) setChannel(String(settings.channels[0]?.channel ?? 1));
  }, [settings, channel]);

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
      <IconButton size="3" variant="surface" title="View Camera" aria-label="View Camera" onClick={toggleOpen}
        style={{ position: 'fixed', top: 10, right: 16, zIndex: 11 }}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M9 4 7.2 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.2L15 4H9zm3 4.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" /></svg>
      </IconButton>
      {dock !== 'closed' && (
        <Card style={{ position: 'fixed', top: 58, right: 16, width: 'min(640px, calc(100vw - 32px))', zIndex: 11 }}>
          <Flex align="center" gap="2">
            <Text weight="bold">View Camera</Text>
            {settings.channels.length > 1 && (
              <Select.Root size="1" value={channel} onValueChange={(v) => { setChannel(v); start(); }}>
                <Select.Trigger title="Channel" />
                <Select.Content>
                  {settings.channels.map((c) => <Select.Item key={c.channel} value={String(c.channel)}>{c.name || `Channel ${c.channel}`}</Select.Item>)}
                </Select.Content>
              </Select.Root>
            )}
            <Select.Root size="1" value={quality} onValueChange={(v) => { setQuality(v); start(); }}>
              <Select.Trigger title="Quality" />
              <Select.Content>
                <Select.Item value="low">Low quality</Select.Item>
                <Select.Item value="high">High quality</Select.Item>
              </Select.Content>
            </Select.Root>
            <Flex flexGrow="1" />
            <IconButton size="1" variant="ghost" color="gray" title={dock === 'min' ? 'Restore' : 'Minimize'}
              onClick={() => { if (dock === 'min') { setDock('open'); start(); } else setDock('min'); }}>–</IconButton>
            <IconButton size="1" variant="ghost" color="gray" title="Close" onClick={() => setDock('closed')}>✕</IconButton>
          </Flex>
          {dock === 'open' && (
            <div className="live-body">
              {src && <img ref={img} src={src} alt="Live camera view" hidden={status.kind !== 'playing'}
                onError={() => setStatus({ kind: 'stopped', text: 'Could not show the live view. The recorder may be offline or busy.', retry: true })} />}
              {status.kind === 'connecting' && <p>Connecting to the recorder…</p>}
              {status.kind === 'stopped' && <p>{status.text}</p>}
              {status.kind === 'stopped' && status.retry && <Button variant="soft" mb="3" onClick={start}>Try again</Button>}
            </div>
          )}
        </Card>
      )}
    </>
  );
}
