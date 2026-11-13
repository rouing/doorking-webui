import { useEffect, useRef } from 'react';
import { Badge, Card, Flex, IconButton, Text } from '@radix-ui/themes';
import type { Job } from '../../src/types.ts';

export type DockState = 'closed' | 'min' | 'open';

export const JOB_COLORS = { idle: 'gray', running: 'blue', done: 'green', failed: 'red' } as const;
export const jobLabel = (job: Job | null) => (!job || job.state === 'idle' ? '' : `${job.what}: ${job.state}`);

// Gate connection progress: a window in the corner that can be minimized to its title bar or closed.
export function JobDock({ job, state, onState }: { job: Job | null; state: DockState; onState: (s: DockState) => void }) {
  const log = useRef<HTMLPreElement>(null);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [job, state]);
  if (state === 'closed' || !job) return null;
  return (
    <Card className="dock" style={{ position: 'fixed', right: 16, bottom: 16, width: 'min(560px, calc(100vw - 32px))', zIndex: 10 }}>
      <Flex align="center" gap="2">
        <Text weight="bold">Gate connection</Text>
        {jobLabel(job) && <Badge color={JOB_COLORS[job.state]}>{jobLabel(job)}</Badge>}
        <Flex flexGrow="1" />
        <IconButton size="1" variant="ghost" color="gray" title={state === 'min' ? 'Restore' : 'Minimize'}
          onClick={() => onState(state === 'min' ? 'open' : 'min')}>–</IconButton>
        <IconButton size="1" variant="ghost" color="gray" title="Close" onClick={() => onState('closed')}>✕</IconButton>
      </Flex>
      {state === 'open' && <pre ref={log} className="job-log">{job.log.join('\n')}</pre>}
    </Card>
  );
}
