import { useEffect, useRef } from 'react';
import { Box, Chip, IconButton, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import RemoveIcon from '@mui/icons-material/Remove';
import type { Job } from './types.ts';

export type DockState = 'closed' | 'min' | 'open';

export const JOB_COLORS = { idle: 'default', running: 'primary', done: 'success', failed: 'error' } as const;
/**
 * Job label.
 *
 * @param job - `Job | null` value.
 * @returns Rendered React element.
 */
export const jobLabel = (job: Job | null) => (!job || job.state === 'idle' ? '' : `${job.what}: ${job.state}`);

interface JobDockProps {
  job: Job | null;
  state: DockState;
  onState: (state: DockState) => void;
}

/**
 * Gate connection progress: a window in the corner that can be minimized to its title bar or closed.
 *
 * @param props - Component props.
 * @param props.job - Job.
 * @param props.state - Current state object.
 * @param props.onState - On state.
 * @returns Rendered React element.
 */
export function JobDock({ job, state, onState }: JobDockProps) {
  const log = useRef<HTMLPreElement>(null);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [job, state]);
  if (state === 'closed' || !job) return null;
  const label = jobLabel(job);
  return (
    <Paper elevation={6} className="dock" sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Gate connection</Typography>
        {label && <Chip size="small" label={label} color={JOB_COLORS[job.state]} />}
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
      {job.state === 'running' && <LinearProgress sx={{ mt: 1, borderRadius: 1 }} />}
      {state === 'open' && <pre ref={log} className="job-log" style={{ marginTop: 8 }}>{job.log.join('\n')}</pre>}
    </Paper>
  );
}
