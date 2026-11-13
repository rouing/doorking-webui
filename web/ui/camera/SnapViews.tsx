import type { MouseEvent } from 'react';
import { Button, Dialog, Flex, IconButton, Progress, Text } from '@radix-ui/themes';
import type { TransactionRow } from '../../../src/types.ts';
import { fileChannel, frameCaption, isVideo, posterOf, shiftedTime, snapFiles, type Snaps } from './snapshots.ts';

// One saved picture (or video), or a "?" box when it is missing, with a ↻ button that fetches it again.
// thumb: the small Transactions-table version; clicking it opens the viewer.
function SnapTile({ t, f, thumb, snaps, onOpen }: { t: TransactionRow; f: string; thumb: boolean; snaps: Snaps; onOpen?: () => void }) {
  const s = snaps.snapshots[t.minute];
  const key = `${t.minute}/${f}`;
  const video = isVideo(f);
  const saved = s.files.includes(f);
  const label = `${snaps.channelName(fileChannel(f))} · ${frameCaption(f)}`;
  const partial = saved && s.short ? s.short[f] : 0;
  const shift = saved && s.shifts ? s.shifts[f] : 0;
  const title = `${label}${saved ? '' : ` · no ${video ? 'video' : 'picture'}${s.error ? ` (${s.error})` : ''}`}`
    + `${partial ? ` · partial video: ${partial} s of 2 minutes (click ↻ to get it again)` : ''}`
    + `${shift ? ` · taken at ${shiftedTime(t.minute, f, shift)} (${shift > 0 ? '+' : ''}${shift} s, no recording at the planned time)` : ''}`
    + `${thumb ? ` · click to see ${video ? 'the videos' : 'every frame'}` : ''}`;
  const open = thumb ? (e: MouseEvent) => { e.stopPropagation(); onOpen?.(); } : undefined;
  const busy = Boolean(snaps.refreshing[key]);
  const failed = snaps.errors[key];
  return (
    <span className={`snap-tile${thumb ? ' thumb' : ''}`}>
      {!saved ? <span className="snap-missing" title={title} onClick={open}>?</span>
        : video && !thumb ? <video className="snap-video" controls preload="none" title={title}
          poster={snaps.src(t.minute, f, posterOf(f))} src={snaps.src(t.minute, f)} />
          : <img className={thumb ? 'snap-thumb' : ''} src={snaps.src(t.minute, f, video ? posterOf(f) : f)} loading="lazy" alt={label}
            title={title} onClick={open} />}
      {video && thumb && saved && <span className="snap-play">▶</span>}
      {partial ? <span className="snap-partial">Partial</span> : null}
      <button type="button" className={`snap-refresh${busy ? ' busy' : ''}${failed ? ' failed' : ''}`} disabled={busy}
        title={busy ? `Getting this ${video ? 'video' : 'picture'} again…` : failed ? `Not refreshed: ${failed}. Click to try again.`
          : `Get ${label} again from the recorder`}
        onClick={(e) => { e.stopPropagation(); snaps.refresh(t.minute, f); }}>↻</button>
    </span>
  );
}

// Progress for a transaction's minute while the snapshot run still has frames to fetch for it.
function SnapBar({ minute, snaps }: { minute: string; snaps: Snaps }) {
  const m = snaps.byMinute[minute];
  const now = minute === snaps.current;
  return (
    <Flex display="inline-flex" align="center" gap="1" title={now ? `Downloading ${snaps.noun}: ${m.done} of ${m.frames}`
      : 'Waiting for its turn in the snapshot run'}>
      <Progress size="1" value={(m.done / (m.frames || 1)) * 100} style={{ width: 60 }} />
      <Text size="1" color="gray">{now ? `${m.done} of ${m.frames}` : 'Waiting'}</Text>
    </Flex>
  );
}

// The Camera cell of a transaction: each channel's first saved frame, a progress bar while the run fetches its
// minute, or a button that gets that minute's pictures (or video) only.
export function SnapCell({ t, snaps, onOpen }: { t: TransactionRow; snaps: Snaps; onOpen: (t: TransactionRow) => void }) {
  if (!t.camera) return <Text size="1" color="gray" title="Gate data transfers, hold-open events and other gate commands don't get camera footage">—</Text>;
  const s = snaps.snapshots[t.minute];
  const bar = snaps.byMinute[t.minute] ? <SnapBar minute={t.minute} snaps={snaps} /> : null;
  if (s && s.status === 'removed') return bar || <Text size="1" color="gray" title={s.error || ''}>Removed</Text>;
  if (!s || (snaps.video && s.files.length && !s.files.some(isVideo))) {
    return bar || (
      <Button size="1" variant="soft" disabled={snaps.running} style={{ whiteSpace: 'nowrap' }}
        title={snaps.running ? 'Wait for the snapshot run to finish' : `Get the camera ${snaps.noun} for this minute only`}
        onClick={(e) => { e.stopPropagation(); snaps.runMinute(t.minute); }}>{snaps.video ? 'Get video' : 'Get pictures'}</Button>
    );
  }
  const firsts = new Map<number, string>(); // channel -> its first saved frame, or its first frame when none is saved
  for (const f of snapFiles(snaps.settings, s)) {
    const ch = fileChannel(f);
    if (!firsts.has(ch) || (!s.files.includes(firsts.get(ch)!) && s.files.includes(f))) firsts.set(ch, f);
  }
  return (
    <Flex gap="1" align="center" wrap="nowrap">
      {[...firsts.values()].map((f) => <SnapTile key={f} t={t} f={f} thumb snaps={snaps} onOpen={() => onOpen(t)} />)}
      {bar}
    </Flex>
  );
}

// Every frame (or video) of one transaction's minute, one row per channel.
export function SnapViewer({ t, snaps, onClose }: { t: TransactionRow | null; snaps: Snaps; onClose: () => void }) {
  const s = t && snaps.snapshots[t.minute];
  const byChannel = new Map<number, string[]>();
  if (s) for (const f of snapFiles(snaps.settings, s)) byChannel.set(fileChannel(f), [...(byChannel.get(fileChannel(f)) || []), f]);
  return (
    <Dialog.Root open={Boolean(t && s)} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog.Content maxWidth="96vw" aria-describedby={undefined}>
        <Flex align="center" mb="3">
          <Dialog.Title mb="0">{t && `${t.date} ${t.time} · ${t.name || t.eventType || ''}`}</Dialog.Title>
          <Flex flexGrow="1" />
          <Dialog.Close><IconButton variant="ghost" color="gray" title="Close">✕</IconButton></Dialog.Close>
        </Flex>
        <Flex direction="column" gap="3" className="snap-viewer">
          {t && [...byChannel].sort((a, b) => a[0] - b[0]).map(([ch, files]) => (
            <Flex key={ch} gap="2" wrap="wrap" align="start">
              {files.map((f) => (
                <figure key={f} className="snap-figure">
                  <SnapTile t={t} f={f} thumb={false} snaps={snaps} />
                  <figcaption>{snaps.channelName(ch)} · {frameCaption(f)}</figcaption>
                </figure>
              ))}
            </Flex>
          ))}
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
