import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Box, Button, Callout, Flex, Text, TextField } from '@radix-ui/themes';
import type { GateSettingRow, SendPreview } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { ConflictList } from '../panes/WorkingCopyBar.tsx';
import { gsShow, type GateSettings } from './useGateSettings.ts';

const HINTS: [string, string][] = [['holiday', 'MM/DD'], ['Tone', '1-9'], ['EntryCodeRange', '0000'], ['outsideLineDigit', '0-9']];

// Background of a setting: blue = unsaved edit, green = saved in the working copy but not sent to the gate.
export function settingTone(gs: GateSettings, s: GateSettingRow) {
  return s.key in gs.edits ? 'var(--blue-a4)' : s.value !== s.gate ? 'var(--green-a4)' : undefined;
}

export function settingTitle(gs: GateSettings, s: GateSettingRow) {
  const edited = s.key in gs.edits;
  const pending = s.value !== s.gate;
  return `${s.name}\nGate (pulled): ${gsShow(s.gate)}${pending ? `\nWorking copy (saved, not sent): ${gsShow(s.value)}` : ''}`
    + `${edited ? `\nYour change (unsaved): ${gsShow(gs.edits[s.key])}` : ''}`
    + `\nnames.bin offset 0x${s.offset.toString(16)}${s.editable ? '' : ' (read-only)'}`;
}

// Width in px that fits `max` of the widest character in the input's font as the browser draws it (its fonts, zoom and
// minimum font size included), plus the input's text indent and border and a little room for the caret; null until
// the input is on screen.
const SPARE_PX = 28; // room past a full-length message so it never touches the edge or scrolls

function useFitWidth(input: RefObject<HTMLInputElement | null>, max: number | null) {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || !max) return;
    const cs = getComputedStyle(el);
    const probe = document.createElement('span');
    probe.textContent = 'W'.repeat(max);
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', fontFamily: cs.fontFamily,
      fontSize: cs.fontSize, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, letterSpacing: cs.letterSpacing });
    el.parentElement!.append(probe);
    const text = probe.getBoundingClientRect().width;
    probe.remove();
    const indent = parseFloat(cs.textIndent) || 0;
    const root = el.parentElement!.getBoundingClientRect().width - el.getBoundingClientRect().width;
    setWidth(Math.ceil(text + indent * 2 + root + SPARE_PX));
  }, [input, max]);
  return width;
}

// One input for a gate setting, coloured and with hover text as above. Text settings (display messages) are wide
// enough for the most characters the gate accepts (in a fixed-width font, like the gate's LCD) and stop at it.
// invalid: a reason the value can't be saved (red, and shown first in the hover text).
export function SettingInput({ gs, s, invalid }: { gs: GateSettings; s: GateSettingRow; invalid?: string }) {
  const max = s.maxLength;
  const ref = useRef<HTMLInputElement>(null);
  const fit = useFitWidth(ref, max);
  const width = fit ? `${fit}px` : max ? `calc(${max}ch + var(--space-4))`
    : s.editable ? '9ch' : `calc(${Math.max(9, gs.current(s).length)}ch + var(--space-4))`;
  return (
    <TextField.Root ref={ref} size="1" value={gs.current(s)} readOnly={!s.editable}
      title={invalid ? `${invalid}\n${settingTitle(gs, s)}` : settingTitle(gs, s)} color={invalid ? 'red' : undefined}
      placeholder={HINTS.find(([k]) => s.key.includes(k))?.[1] || ''} className={max ? 'lcd-input' : undefined}
      maxLength={max ?? undefined}
      style={{ width, minWidth: width, flexShrink: 0, background: invalid ? 'var(--red-a5)' : settingTone(gs, s),
        opacity: s.editable ? undefined : 0.7 }}
      onChange={(e) => gs.edit(s, e.target.value)} />
  );
}

// Save / Discard / Reset to gate / Send to gate for the gate settings, the working-copy file links and the
// result of the last action. blocked: why the edits can't be saved yet (Save is disabled).
export function SettingsBar({ gs, gapi, onReload, onJobStarted, blocked }: {
  gs: GateSettings; gapi: GateApi; onReload: () => Promise<void> | void; onJobStarted: () => void; blocked?: string;
}) {
  const [result, setResult] = useState<{ title: string; lines: string[] } | null>(null);
  const [dialog, confirm] = useConfirm();
  const n = Object.keys(gs.edits).length;
  const loaded = Boolean(gs.reply);

  const save = async () => {
    try {
      const r = await gs.save();
      setResult({ title: `Saved to the working copy. Block(s) differing from the gate: ${r.changedBlocks.join(', ') || 'none'}`,
        lines: r.changed.map((c) => `${c.name}: "${c.from}" → "${c.to}"`) });
      await onReload();
    } catch (e) { setResult({ title: 'Save failed', lines: [errorText(e)] }); }
  };

  const reset = async () => {
    if (!await confirm({ title: 'Reset to gate?', action: 'Reset', color: 'red',
      body: 'Throw away every change not sent to the gate (on every page), so the working copy matches what the gate holds?' })) return;
    try {
      await gapi('DELETE', '/working-copy');
      gs.discard();
      setResult({ title: 'Working copy reset to the gate', lines: [] });
      await gs.load();
      await onReload();
    } catch (e) { setResult({ title: 'Reset failed', lines: [errorText(e)] }); }
  };

  const send = async () => {
    let preview: SendPreview;
    try { preview = await gapi<SendPreview>('GET', '/send'); } catch (e) { setResult({ title: 'Send not possible', lines: [errorText(e)] }); return; }
    const blocks = Object.entries(preview.changedBlocks).filter(([, b]) => b.length);
    const lines: ReactNode[] = ['This changes the gate.', ...gs.changes, ...blocks.map(([f, b]) => `${f}: block(s) ${b.join(', ')}`),
      `Resident / vendor counts (from names.bin): ${preview.residentCounts.join(', ')}`, 'A residents pull runs afterwards to check the gate.'];
    if (!await confirm({ title: 'Send the working copy to the gate?', action: 'Send to gate',
      body: <Flex direction="column" gap="1">{lines.map((l, i) => <Text key={i}>{l}</Text>)}</Flex> })) return;
    try {
      await gapi('POST', '/send', { confirm: true });
      setResult({ title: 'Sending to the gate; progress is shown in the gate connection window', lines: [] });
      onJobStarted();
    } catch (e) { setResult({ title: 'Send failed', lines: [errorText(e)] }); }
  };

  const status = !loaded ? gs.error : [
    n ? `${n} unsaved change(s)` : 'No unsaved changes',
    gs.pending.length ? `${gs.pending.length} setting(s) saved, not sent (block(s) ${gs.blocks.join(', ')})` : '',
    `gate pulled ${new Date(gs.reply!.pulled).toLocaleString()}`,
    gs.pending.length ? `working copy saved ${new Date(gs.reply!.saved).toLocaleString()}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <Flex direction="column" gap="2">
      {dialog}
      <Text size="2" color="gray">
        Edits go to the working copy (blue = unsaved, green = saved but not sent to the gate). Hover a value to see the gate's value.
      </Text>
      <Flex gap="2" wrap="wrap" align="center">
        <Button onClick={save} disabled={!loaded || !n || Boolean(blocked)} title={blocked}>Save to working copy</Button>
        <Button variant="soft" color="gray" onClick={() => { gs.discard(); setResult(null); }} disabled={!loaded || !n}>Discard unsaved</Button>
        <Button variant="soft" color="gray" onClick={reset} disabled={!loaded || (!gs.pending.length && !gs.blocks.length)}>Reset to gate</Button>
        <Button variant="soft" onClick={send} disabled={!loaded || n > 0 || !gs.blocks.length || gs.conflicts.length > 0}
          title={n ? 'Save or discard unsaved changes first' : gs.conflicts.length ? 'Decide the conflicts first' : 'Send the working copy to the gate'}>
          Send to gate
        </Button>
      </Flex>
      <Text size="2" color="gray">{status}</Text>
      <ConflictList conflicts={gs.conflicts} gapi={gapi} onDecided={async () => { await gs.load(); await onReload(); }} />
      {result && (
        <Callout.Root color={result.title.includes('failed') || result.title.includes('not possible') ? 'red' : 'blue'}>
          <Callout.Text><strong>{result.title}</strong></Callout.Text>
          {result.lines.length > 0 && <Box asChild><ul style={{ margin: 0 }}>{result.lines.map((l, i) => <li key={i}>{l}</li>)}</ul></Box>}
        </Callout.Root>
      )}
    </Flex>
  );
}
