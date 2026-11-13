import { useState, type ReactNode } from 'react';
import { Button, Checkbox, Flex, Heading, Table, Text } from '@radix-ui/themes';
import type { GateSettingRow } from '../../../src/types.ts';
import { errorText } from '../api.ts';
import { HelpTip } from '../HelpTip.tsx';
import type { GateSettings } from './useGateSettings.ts';

export const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const CLEAR_NOTE = 'Clear sets every setting on this page back to unset.'; // the gate stores relays 0-18; values for the others are kept unchanged

// Row colour and status of a group of settings: blue = unsaved edit, green = saved but not sent to the gate.
export function rowState(gs: GateSettings, fields: (GateSettingRow | undefined)[], edited?: boolean, pending?: boolean,
  pendingText = 'not sent') {
  const list = fields.filter((f): f is GateSettingRow => Boolean(f));
  const e = edited ?? list.some((f) => f.key in gs.edits);
  const p = !e && (pending ?? list.some((f) => f.value !== f.gate));
  return { style: { background: e ? 'var(--blue-a4)' : p ? 'var(--green-a4)' : undefined }, status: e ? 'unsaved' : p ? pendingText : '' };
}

// A checkbox, with an optional label and "?" tip (help: a key in HELP).
export function Box({ checked, onChange, disabled, label, help }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string; help?: string;
}) {
  const box = <Checkbox checked={checked} disabled={disabled} onCheckedChange={(v) => onChange(v === true)} />;
  return label ? <Text as="label" size="2"><Flex gap="1" align="center">{box}{label}{help && <HelpTip of={help} />}</Flex></Text> : box;
}

// The browser's own time input (sized to the time), styled like the other fields.
export function TimeBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <input type="time" className="time-input" value={value} onChange={(e) => onChange(e.target.value)} />;
}

// A string of '0'/'1' flags with position i set to on.
export const setBit = (bits: string, i: number, on: boolean) => {
  const a = [...bits.padEnd(i + 1, '0')];
  a[i] = on ? '1' : '0';
  return a.join('');
};

// A page editing one group of gate settings in the working copy (Save / Discard, plus `buttons`), then `children`.
// clearValue: adds a Clear button that sets each setting of the group to its unset value (undefined = leave it).
// help: a key in HELP, shown as a "?" tip after the title.
export function GroupPage({ title, intro, gs, group, buttons, clearValue, help, children }: {
  title: string; intro: ReactNode; gs: GateSettings; group: string; buttons?: ReactNode;
  clearValue?: (f: GateSettingRow) => string | undefined; help?: string; children: ReactNode;
}) {
  const [saved, setSaved] = useState('');
  const fields = gs.fields.filter((f) => f.group === group);
  const n = Object.keys(gs.edits).length;
  const pending = fields.filter((f) => f.value !== f.gate).length;
  const save = async () => {
    try {
      const r = await gs.save();
      setSaved(`Saved to working copy. Changed block(s): ${r.changedBlocks.join(', ') || 'none'}`);
    } catch (e) { setSaved(`Save failed: ${errorText(e)}`); }
  };
  const info = !gs.reply ? gs.error : saved && !n ? saved
    : [n ? `${n} unsaved change(s)` : 'No unsaved changes', pending ? `${pending} saved, not sent to the gate` : ''].filter(Boolean).join(' · ');
  return (
    <Flex direction="column" gap="3">
      <Heading>{title}{help && <HelpTip of={help} />}</Heading>
      <Text size="2" color="gray">{intro}</Text>
      <Flex gap="2" align="center" wrap="wrap">
        <Button onClick={save} disabled={!n}>Save to working copy</Button>
        <Button variant="soft" color="gray" onClick={() => { gs.discard(); setSaved(''); }} disabled={!n}>Discard unsaved</Button>
        {clearValue && (
          <Button variant="soft" color="gray" disabled={!fields.length} onClick={() => {
            for (const f of fields) { const v = clearValue(f); if (v !== undefined) gs.edit(f, v); }
            setSaved('');
          }}>Clear</Button>
        )}
        {buttons}
        <Text size="2" color="gray">{info}</Text>
      </Flex>
      {gs.reply && fields.length > 0 && <Table.Root size="1" variant="surface" style={{ width: 'fit-content', maxWidth: '100%' }}>{children}</Table.Root>}
    </Flex>
  );
}

// Header row of plain column labels.
export function Head({ cols }: { cols: string[] }) {
  return <Table.Header><Table.Row>{cols.map((c, i) => <Table.ColumnHeaderCell key={i}>{c}</Table.ColumnHeaderCell>)}</Table.Row></Table.Header>;
}
