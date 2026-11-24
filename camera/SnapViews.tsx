import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { TransactionRow } from '../types.ts';
import { useBackLayer } from '../back.ts';
import { fileChannel, frameCaption, isVideo, posterOf, shiftedTime, snapFiles, type Snaps } from './snapshots.ts';

interface SnapTileProps {
  transaction: TransactionRow;
  file: string;
  thumb: boolean;
  snaps: Snaps;
  onOpen?: () => void;
}

/**
 * One saved picture (or video), or a "?" box when it is missing.
 * `thumb`: the small Transactions-table version wrapped in an accessible button; clicking it opens the viewer.
 * Inside `SnapViewer` (`!thumb`), renders full-size media with a per-frame refresh button.
 *
 * @param props - Component props.
 * @param props.transaction - Transaction record or row.
 * @param props.file - File path or filename.
 * @param props.thumb - The small Transactions-table version.
 * @param props.snaps - Gate snapshot state and actions hook.
 * @param props.onOpen - On open.
 * @returns Rendered React element.
 */
function SnapTile({ transaction, file, thumb, snaps, onOpen }: SnapTileProps) {
  const snapshot = snaps.snapshots[transaction.minute];
  const key = `${transaction.minute}/${file}`;
  const video = isVideo(file);
  const saved = snapshot.files.includes(file);
  const label = `${snaps.channelName(fileChannel(file))} · ${frameCaption(file)}`;
  const partial = saved && snapshot.short ? snapshot.short[file] : 0;
  const shift = saved && snapshot.shifts ? snapshot.shifts[file] : 0;
  const title = `${label}${saved ? '' : ` · no ${video ? 'video' : 'picture'}${snapshot.error ? ` (${snapshot.error})` : ''}`}`
    + `${partial ? ` · partial video: ${partial} s of 2 minutes` : ''}`
    + `${shift ? ` · taken at ${shiftedTime(transaction.minute, file, shift)} (${shift > 0 ? '+' : ''}${shift} s, no recording at the planned time)` : ''}`
    + `${thumb ? ` · click to see ${video ? 'the videos' : 'every frame'}` : ''}`;

  if (thumb) {
    return (
      <button
        type="button"
        className="snap-tile"
        aria-label={title}
        title={title}
        onClick={(event) => { event.stopPropagation(); onOpen?.(); }}
        style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer' }}
      >
        {!saved ? (
          <span className="snap-missing" aria-hidden="true">?</span>
        ) : (
          <img
            className="snap-thumb"
            src={snaps.src(transaction.minute, file, video ? posterOf(file) : file)}
            loading="lazy"
            alt={label}
          />
        )}
        {video && saved && <span className="snap-play" aria-hidden="true">▶</span>}
        {partial ? <span className="snap-partial">Partial</span> : null}
      </button>
    );
  }

  const busy = Boolean(snaps.refreshing[key]);
  const failed = snaps.errors[key];
  const refreshTitle = busy ? `Getting this ${video ? 'video' : 'picture'} again…`
    : failed ? `Not refreshed: ${failed}. Click to try again.`
      : `Get ${label} again from the recorder`;

  return (
    <Paper variant="outlined" sx={{ p: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Box sx={{ position: 'relative' }}>
        {!saved ? (
          <Box
            className="snap-missing"
            title={title}
            sx={{ width: '100%', height: 180, boxSizing: 'border-box', cursor: 'default' }}
          >
            No {video ? 'video' : 'picture'}
          </Box>
        ) : video ? (
          <video
            className="snap-full"
            controls
            preload="none"
            title={title}
            poster={snaps.src(transaction.minute, file, posterOf(file))}
            src={snaps.src(transaction.minute, file)}
          />
        ) : (
          <img
            className="snap-full"
            src={snaps.src(transaction.minute, file)}
            loading="lazy"
            alt={label}
            title={title}
          />
        )}
        {partial ? <span className="snap-partial">Partial ({partial} s)</span> : null}
      </Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="caption" color="text.secondary">{label}</Typography>
        <IconButton
          size="small"
          disabled={busy}
          color={failed ? 'error' : 'default'}
          aria-label={refreshTitle}
          title={refreshTitle}
          onClick={(event) => { event.stopPropagation(); snaps.refresh(transaction.minute, file); }}
        >
          <RefreshIcon fontSize="small" />
        </IconButton>
      </Stack>
      {failed && <Alert severity="error" sx={{ py: 0 }}>Not refreshed: {failed}</Alert>}
    </Paper>
  );
}

interface SnapBarProps {
  minute: string;
  snaps: Snaps;
}

/**
 * Progress for a transaction's minute while the snapshot run still has frames to fetch for it.
 *
 * @param props - Component props.
 * @param props.minute - Transaction minute key (`YYYYMMDD-HHMM`).
 * @param props.snaps - Gate snapshot state and actions hook.
 * @returns Rendered React element.
 */
function SnapBar({ minute, snaps }: SnapBarProps) {
  const counts = snaps.byMinute[minute];
  const now = minute === snaps.current;
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ display: 'inline-flex', alignItems: 'center' }}
      title={now ? `Downloading ${snaps.noun}: ${counts.done} of ${counts.frames}` : 'Waiting for its turn in the snapshot run'}
    >
      <LinearProgress variant="determinate" value={(counts.done / (counts.frames || 1)) * 100} sx={{ width: 60 }} />
      <Typography variant="caption" color="text.secondary">{now ? `${counts.done} of ${counts.frames}` : 'Waiting'}</Typography>
    </Stack>
  );
}

interface SnapCellProps {
  transaction: TransactionRow;
  snaps: Snaps;
  onOpen: (transaction: TransactionRow) => void;
}

/**
 * The Camera cell of a transaction: each channel's first saved frame, a progress bar while the run fetches its
 * minute, or a button that gets that minute's pictures (or video) only.
 *
 * @param props - Component props.
 * @param props.transaction - Transaction record or row.
 * @param props.snaps - Gate snapshot state and actions hook.
 * @param props.onOpen - On open.
 * @returns Rendered React element.
 */
export function SnapCell({ transaction, snaps, onOpen }: SnapCellProps) {
  if (!transaction.camera) {
    return (
      <Typography variant="caption" color="text.secondary" title="Gate data transfers, hold-open events and other gate commands don't get camera footage">
        —
      </Typography>
    );
  }
  const snapshot = snaps.snapshots[transaction.minute];
  const bar = snaps.byMinute[transaction.minute] ? <SnapBar minute={transaction.minute} snaps={snaps} /> : null;
  const getButton = (title: string) => (
    <Button
      size="small"
      variant="outlined"
      disabled={snaps.running}
      sx={{ whiteSpace: 'nowrap' }}
      title={snaps.running ? 'Wait for the snapshot run to finish' : title}
      onClick={(event) => { event.stopPropagation(); snaps.runMinute(transaction.minute); }}
    >
      {snaps.video ? 'Get video' : 'Get pictures'}
    </Button>
  );
  if (snapshot && snapshot.status === 'removed') {
    return bar || (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="caption" color="text.secondary" title={snapshot.error || ''}>Removed</Typography>
        {getButton(`${snapshot.error ? `${snapshot.error}. ` : ''}Get the camera ${snaps.noun} again from the recorder (it works while the recorder still has this footage)`)}
      </Stack>
    );
  }
  if (!snapshot || (snaps.video && snapshot.files.length && !snapshot.files.some(isVideo))) {
    return bar || getButton(`Get the camera ${snaps.noun} for this minute only`);
  }
  const firsts = new Map<number, string>(); // channel -> its first saved frame, or its first frame when none is saved
  for (const file of snapFiles(snaps.settings, snapshot)) {
    const channel = fileChannel(file);
    if (!firsts.has(channel) || (!snapshot.files.includes(firsts.get(channel)!) && snapshot.files.includes(file))) firsts.set(channel, file);
  }
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
      {[...firsts.values()].map((file) => (
        <SnapTile key={file} transaction={transaction} file={file} thumb snaps={snaps} onOpen={() => onOpen(transaction)} />
      ))}
      {bar}
    </Stack>
  );
}

interface SnapViewerProps {
  transaction: TransactionRow | null;
  snaps: Snaps;
  onClose: () => void;
}

/**
 * Every frame (or video) of one transaction's minute, one row per channel.
 *
 * @param props - Component props.
 * @param props.transaction - Transaction record or row.
 * @param props.snaps - Gate snapshot state and actions hook.
 * @param props.onClose - Callback invoked when the layer closes.
 * @returns Rendered React element.
 */
export function SnapViewer({ transaction, snaps, onClose }: SnapViewerProps) {
  const snapshot = transaction && snaps.snapshots[transaction.minute];
  const byChannel = new Map<number, string[]>();
  if (snapshot) for (const file of snapFiles(snaps.settings, snapshot)) byChannel.set(fileChannel(file), [...(byChannel.get(fileChannel(file)) || []), file]);
  const isOpen = Boolean(transaction && snapshot);
  useBackLayer(isOpen, onClose);
  return (
    <Dialog open={isOpen} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
        <span>{transaction ? `${transaction.date} ${transaction.time} · ${transaction.name || transaction.eventType || ''}` : ''}</span>
        <IconButton size="small" aria-label="Close" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {transaction && [...byChannel].sort((a, b) => a[0] - b[0]).map(([ch, files]) => (
            <Box key={ch} className={files.length === 1 ? 'snap-grid one' : 'snap-grid'}>
              {files.map((file) => (
                <SnapTile key={file} transaction={transaction} file={file} thumb={false} snaps={snaps} />
              ))}
            </Box>
          ))}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button color="inherit" onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
