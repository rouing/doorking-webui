import { useEffect, useRef, useState } from 'react';
import { Box, Button, IconButton, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import RemoveIcon from '@mui/icons-material/Remove';
import type { Job } from './types.ts';

export type DockState = 'closed' | 'min' | 'open';

export const JOB_COLORS = { idle: 'default', running: 'primary', done: 'success', failed: 'error' } as const;

export const jobLabel = (job: Job | null) => (!job || job.state === 'idle' ? '' : `${job.what}: ${job.state}`);

const LOG_PERCENT_RE = /(\d{1,3})\s*%/;
const LOG_TS_PREFIX_RE = /^\s*\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?\s+/i;

function parseJobProgress(job: Job): { percent: number | null; statusLabel: string; complete: boolean } {
  const lines = job.log || [];
  if (job.state === 'done' || lines.some((l) => /session complete:\s*success/i.test(l))) {
    return { percent: 100, statusLabel: 'Session Complete: Success', complete: true };
  }
  let latestPercent: number | null = null;
  let latestStage = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = LOG_PERCENT_RE.exec(lines[i]);
    if (match) {
      latestPercent = Math.min(100, Math.max(0, Number(match[1])));
      const cleaned = lines[i].replace(LOG_TS_PREFIX_RE, '').trim();
      latestStage = cleaned.split(':')[0].trim() || cleaned;
      break;
    }
  }
  if (job.state === 'failed') {
    return { percent: latestPercent, statusLabel: 'Job failed', complete: false };
  }
  const lastLine = [...lines].reverse().find((l) => l.trim())?.replace(LOG_TS_PREFIX_RE, '').split('\n')[0].trim().slice(0, 60);
  return {
    percent: latestPercent,
    statusLabel: latestStage || lastLine || 'Connecting to gate…',
    complete: false,
  };
}

function formatJobTitle(what: string | undefined, complete: boolean): string {
  const w = (what || '').toLowerCase();
  if (complete) {
    if (w === 'transactions') return 'Transactions pulled';
    if (w === 'residents') return 'Residents pulled';
    if (w === 'send') return 'Sent to gate';
    return 'Gate job complete';
  }
  if (w === 'transactions') return 'Pulling transactions';
  if (w === 'residents') return 'Pulling residents';
  if (w === 'send') return 'Sending to gate';
  return what ? `Gate job (${what})` : 'Gate connection';
}

interface JobDockProps {
  job: Job | null;
  state: DockState;
  onState: (state: DockState) => void;
}

/**
 * Gate connection progress dock with log-parsed progress bar and expandable raw log view.
 */
export function JobDock({ job, state, onState }: JobDockProps) {
  const log = useRef<HTMLPreElement>(null);
  const [showRawLog, setShowRawLog] = useState(false);
  useEffect(() => { if (showRawLog && log.current) log.current.scrollTop = log.current.scrollHeight; }, [job, state, showRawLog]);
  if (state === 'closed' || !job) return null;
  const prog = parseJobProgress(job);
  const title = formatJobTitle(job.what, prog.complete);
  return (
    <Paper elevation={6} className="dock" sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{title}</Typography>
        <Box sx={{ flexGrow: 1 }} />
        <IconButton
          size="small"
          aria-label={state === 'min' ? 'Restore' : 'Minimize'}
          title={state === 'min' ? 'Restore' : 'Minimize'}
          onClick={() => onState(state === 'min' ? 'open' : 'min')}
        >
          {state === 'min' ? <OpenInFullIcon fontSize="small" /> : <RemoveIcon fontSize="small" />}
        </IconButton>
        <IconButton size="small" aria-label="Close" title="Close" onClick={() => onState('closed')}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>
      <Stack spacing={1} sx={{ mt: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="caption" color="text.secondary" noWrap>{prog.statusLabel}</Typography>
          {prog.percent !== null && (
            <Typography variant="caption" sx={{ fontWeight: 700, color: prog.complete ? 'success.main' : 'primary.main' }}>
              {prog.percent}%
            </Typography>
          )}
        </Stack>
        {prog.percent !== null ? (
          <LinearProgress
            variant="determinate"
            value={prog.percent}
            color={prog.complete ? 'success' : 'primary'}
            sx={{ borderRadius: 1 }}
          />
        ) : job.state === 'running' ? (
          <LinearProgress sx={{ borderRadius: 1 }} />
        ) : null}
      </Stack>
      {state === 'open' && (
        <Stack spacing={1} sx={{ mt: 1.25 }}>
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            fullWidth
            startIcon={showRawLog ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            onClick={() => setShowRawLog((v) => !v)}
          >
            {showRawLog ? 'Hide raw log' : 'Show raw log'}
          </Button>
          {showRawLog && <pre ref={log} className="job-log" style={{ marginTop: 0 }}>{job.log.join('\n')}</pre>}
        </Stack>
      )}
    </Paper>
  );
}
