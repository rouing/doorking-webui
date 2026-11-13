import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Code, Flex, IconButton, Text, TextField } from '@radix-ui/themes';
import type { DeviceRange } from '../../../src/types.ts';
import { deviceFor, formatPhoneDigits } from '../format.ts';
import { HelpTip } from '../HelpTip.tsx';

// A labelled form field; help: a key in HELP (or own text) shown as a "?" tip after the label.
export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Text size="2" weight="medium">{label}{help && <HelpTip of={help} />}</Text>
      {children}
    </label>
  );
}

// Phone input that formats as you type ((918) 555-0142, 1 (918) 555-0142 or 555-0142) and keeps the caret after
// the same digit.
// Backspace over a separator removes the digit before it.
export function PhoneField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current !== null && ref.current) ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  return (
    <TextField.Root ref={ref} inputMode="tel" placeholder="(918) 555-0142" value={value} onChange={(e) => {
      const input = e.target;
      let before = input.value.slice(0, input.selectionStart ?? input.value.length).replace(/\D/g, '').length;
      let d = input.value.replace(/\D/g, '');
      if ((e.nativeEvent as InputEvent).inputType === 'deleteContentBackward' && d === value.replace(/\D/g, '') && before > 0) {
        d = d.slice(0, before - 1) + d.slice(before);
        before -= 1;
      }
      const text = formatPhoneDigits(d.slice(0, d[0] === '1' ? 11 : 10));
      let pos = 0;
      for (let seen = 0; pos < text.length && seen < before; pos++) if (/\d/.test(text[pos])) seen++;
      caret.current = pos;
      onChange(text);
    }} />
  );
}

// A card number with its Device Association name as a tooltip; red when no range holds it. dup: the card is also
// assigned to another directory code (red background).
export function CardNumber({ num, devices, dup = false }: { num: string; devices: DeviceRange[]; dup?: boolean }) {
  const dev = deviceFor(devices, num);
  return (
    <Code variant="ghost" color={dev ? undefined : 'red'}
      title={`${num} · ${dev || 'not in any device range'}${dup ? ' · ALSO ASSIGNED TO ANOTHER DIRECTORY CODE' : ''}`}
      style={{ minWidth: '4.5em', background: dup ? 'var(--red-a5)' : undefined }}>{num}</Code>
  );
}

// Card numbers as fixed-width items that wrap onto aligned rows; cards in `dups` are marked as duplicates.
export function CardList({ cards, devices, dups }: { cards: string[]; devices: DeviceRange[]; dups?: Set<string> }) {
  return (
    <Flex gap="1" wrap="wrap" style={{ maxWidth: '24rem' }}>
      {cards.map((c) => <CardNumber key={c} num={c} devices={devices} dup={Boolean(dups && dups.has(c))} />)}
    </Flex>
  );
}

// Device (card) list with remove buttons and an add box (device codes 00001-65407; leading zeros dropped, no duplicates).
export function CardsEditor({ cards, devices, onChange }: { cards: string[]; devices: DeviceRange[]; onChange: (c: string[]) => void }) {
  const [add, setAdd] = useState('');
  const [error, setError] = useState('');
  const addNow = () => {
    const n = add.replace(/\D/g, '');
    if (!n) return;
    if (Number(n) < 1 || Number(n) > 65407) { setError('Device codes are 00001-65407'); return; }
    if (!cards.includes(String(Number(n)))) onChange([...cards, String(Number(n))]);
    setAdd('');
    setError('');
  };
  return (
    <Flex direction="column" gap="2">
      <Text size="2" weight="medium">Devices / cards<HelpTip of="cards" /></Text>
      <Flex gap="2" wrap="wrap">
        {cards.map((num, i) => {
          const dev = deviceFor(devices, num);
          return (
            <Flex key={num} align="center" gap="1" px="2" py="1" style={{ background: 'var(--gray-a3)', borderRadius: 'var(--radius-2)' }}>
              <Text size="2">{num}</Text>
              <Text size="1" color={dev ? 'gray' : 'red'}>{dev || 'no device'}</Text>
              <IconButton size="1" variant="ghost" color="gray" title="Remove device"
                onClick={() => onChange(cards.filter((_, j) => j !== i))}>✕</IconButton>
            </Flex>
          );
        })}
      </Flex>
      <Flex gap="2" align="center">
        <TextField.Root inputMode="numeric" placeholder="Card number" maxLength={5} value={add}
          onChange={(e) => setAdd(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNow(); } }} />
        <Button variant="soft" color="gray" onClick={addNow}>Add device</Button>
        {error && <Text size="2" color="red">{error}</Text>}
      </Flex>
    </Flex>
  );
}
