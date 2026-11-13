import { useState } from 'react';
import { Badge, Button, Flex, Text } from '@radix-ui/themes';
import type { ResidentsReply, SendPreview } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { HelpTip } from '../HelpTip.tsx';

// The working copy's state, with Reset to gate (back to the last pull) and Send to gate (then a residents pull
// checks the gate holds it).
export function WorkingCopyBar({ cache, gapi, onReload, onJobStarted }: {
  cache: ResidentsReply['cache'] | null;
  gapi: GateApi;
  onReload: () => Promise<void>;
  onJobStarted: () => void;
}) {
  const [info, setInfo] = useState('');
  const [dialog, confirm] = useConfirm();
  const edited = Boolean(cache && cache.edited);
  const newer = Boolean(cache && cache.newerPull);
  const [label, color] = !cache ? ['no working copy', 'gray'] as const
    : newer ? ['gate changed since pull', 'red'] as const
      : edited ? ['unsaved edits in working copy', 'amber'] as const : ['matches last pull', 'green'] as const;

  async function reset() {
    if (!await confirm({ title: 'Reset to gate?', action: 'Reset', color: 'red',
      body: 'Replace the working copy with the last files pulled from the gate? Unsaved resident/vendor edits will be lost.' })) return;
    setInfo('Resetting…');
    try {
      await gapi('DELETE', '/working-copy');
      await onReload();
      setInfo('Working copy reset to the last pull.');
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
    <Flex gap="3" align="center" wrap="wrap">
      {dialog}
      <Flex align="center"><Badge color={color} size="2">{label}</Badge><HelpTip of="workingCopy" /></Flex>
      <Button variant="soft" color="gray" onClick={reset} disabled={!cache}>Reset to gate</Button>
      <Button variant="soft" onClick={send} disabled={!edited || newer}>Send to gate</Button>
      <Text size="2" color="gray">{info}</Text>
    </Flex>
  );
}
