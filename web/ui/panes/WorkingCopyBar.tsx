import { useState } from 'react';
import { Badge, Button, Callout, Flex, Text } from '@radix-ui/themes';
import type { ConflictView, ResidentsReply, SendPreview } from '../../../src/types.ts';
import { errorText, useReadOnly, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { HelpTip } from '../HelpTip.tsx';

// Items changed differently at the gate and in the working copy, each with Keep mine / Take the gate's (admins).
// Sending waits until every one is decided.
export function ConflictList({ conflicts, gapi, onDecided }: { conflicts: ConflictView[]; gapi: GateApi; onDecided: () => Promise<void> | void }) {
  const readOnly = useReadOnly();
  const [error, setError] = useState('');
  if (!conflicts.length) return null;
  const decide = async (c: ConflictView, choice: 'mine' | 'gate') => {
    try { await gapi('POST', '/working-copy/conflicts', { kind: c.kind, key: c.key, choice }); setError(''); await onDecided(); } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Callout.Root color="red" role="alert">
      <Callout.Text>
        <strong>{conflicts.length} change{conflicts.length === 1 ? '' : 's'} to decide before sending.</strong> Since your last pull,
        these were changed at the gate and differently here. Your change is kept until you choose.
      </Callout.Text>
      <Flex direction="column" gap="2" mt="2">
        {conflicts.map((c) => (
          <Flex key={`${c.kind}-${c.key}`} gap="3" align="center" wrap="wrap">
            <Text size="2"><strong>{c.label}</strong>: at the gate {c.gate}; yours {c.mine}</Text>
            {!readOnly && <Button size="1" variant="soft" onClick={() => decide(c, 'mine')}>Keep mine</Button>}
            {!readOnly && <Button size="1" variant="soft" color="gray" onClick={() => decide(c, 'gate')}>Take the gate's</Button>}
          </Flex>
        ))}
        {error && <Text size="2" color="red">{error}</Text>}
      </Flex>
    </Callout.Root>
  );
}

// The working copy's state, with Reset to gate (drops the unsent changes) and Send to gate (then a residents pull
// checks the gate holds it).
export function WorkingCopyBar({ cache, gapi, onReload, onJobStarted }: {
  cache: ResidentsReply['cache'] | null;
  gapi: GateApi;
  onReload: () => Promise<void>;
  onJobStarted: () => void;
}) {
  const [info, setInfo] = useState('');
  const [dialog, confirm] = useConfirm();
  const readOnly = useReadOnly();
  const edited = Boolean(cache && cache.edited);
  const conflicts = cache ? cache.conflicts : [];
  const [label, color] = !cache ? ['no working copy', 'gray'] as const
    : conflicts.length ? [`${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} to decide`, 'red'] as const
      : edited ? ['changes not sent to the gate', 'amber'] as const : ['matches the gate', 'green'] as const;

  async function reset() {
    if (!await confirm({ title: 'Reset to gate?', action: 'Reset', color: 'red',
      body: 'Throw away every change not sent to the gate, so the working copy matches what the gate holds (as of the last pull)?' })) return;
    setInfo('Resetting…');
    try {
      await gapi('DELETE', '/working-copy');
      await onReload();
      setInfo('Working copy reset to the gate.');
    } catch (e) { setInfo(errorText(e)); }
  }

  async function send() {
    let preview: SendPreview;
    try { preview = await gapi<SendPreview>('GET', '/send'); } catch (e) { setInfo(errorText(e)); return; }
    const blocks = Object.entries(preview.changedBlocks).filter(([, b]) => b.length);
    const ok = await confirm({ title: 'Send the working copy to the gate?', action: 'Send to gate',
      body: (
        <Flex direction="column" gap="1">
          <Text>This changes the gate.</Text>
          {blocks.map(([f, b]) => <Text key={f}>{f}: block(s) {b.join(', ')}</Text>)}
          <Text>Resident / vendor counts (from names.bin): {preview.residentCounts.join(', ')}</Text>
          <Text>A residents pull runs afterwards to check the gate.</Text>
        </Flex>
      ) });
    if (!ok) return;
    try {
      await gapi('POST', '/send', { confirm: true });
      setInfo('Sending to the gate; see the progress window.');
      onJobStarted();
    } catch (e) { setInfo(errorText(e)); }
  }

  return (
    <Flex direction="column" gap="2">
      <Flex gap="3" align="center" wrap="wrap">
        {dialog}
        <Flex align="center"><Badge color={color} size="2">{label}</Badge><HelpTip of="workingCopy" /></Flex>
        {!readOnly && <Button variant="soft" color="gray" onClick={reset} disabled={!cache}>Reset to gate</Button>}
        {!readOnly && <Button variant="soft" onClick={send} disabled={!edited || conflicts.length > 0}
          title={conflicts.length ? 'Decide the conflicts first' : undefined}>Send to gate</Button>}
        <Text size="2" color="gray">{info}</Text>
      </Flex>
      <ConflictList conflicts={conflicts} gapi={gapi} onDecided={onReload} />
    </Flex>
  );
}
