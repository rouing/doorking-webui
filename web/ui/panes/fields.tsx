import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Box, Button, Chip, MenuItem, Select, Stack, TextField, Tooltip, Typography } from '@mui/material';
import type { DeviceRange } from '../../../src/types.ts';
import { formatPhoneDigits } from '../format.ts';
import { deviceNameFor, MAX_CARDS_PER_ENTRY } from '../../../src/shared.ts';
import { HelpTip } from '../HelpTip.tsx';

interface FieldProps {
  label: string;
  help?: string;
  children: ReactNode;
}

/**
 * A labelled form field with optional inline HelpTip.
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
export function Field({ label, help, children }: FieldProps) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 }}>
      <Typography variant="body2" component="div" sx={{ fontWeight: 500, display: 'flex', alignItems: 'center' }}>
        {label}{help && <HelpTip of={help} />}
      </Typography>
      {children}
    </Box>
  );
}

type ChoiceOption = string | readonly [value: string, label: string];
interface ChoiceProps {
  value: string;
  options: readonly ChoiceOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  size?: '1' | '2';
  title?: string;
  ariaLabel?: string;
}

/**
 * A drop-down select; each option is a string or `[value, label]` tuple.
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
export function Choice({ value, options, onChange, disabled, size, title, ariaLabel }: ChoiceProps) {
  return (
    <Select
      size="small"
      value={value}
      displayEmpty
      disabled={disabled}
      title={title}
      inputProps={ariaLabel ? { 'aria-label': ariaLabel } : undefined}
      onChange={(event) => onChange(String(event.target.value))}
      sx={size === '1' ? { '& .MuiSelect-select': { py: 0.5, fontSize: '0.85rem' } } : undefined}
    >
      {options.map((option) => {
        const [val, label] = typeof option === 'string' ? [option, option] : option;
        return <MenuItem key={val} value={val}>{label || '—'}</MenuItem>;
      })}
    </Select>
  );
}

interface PhoneFieldProps {
  value: string;
  onChange: (v: string) => void;
  ariaLabel?: string;
}

/**
 * Phone input that formats as you type (`(918) 555-0142`, `1 (918) 555-0142`, or `555-0142`) preserving caret position.
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
export function PhoneField({ value, onChange, ariaLabel }: PhoneFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current !== null && ref.current) ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  return (
    <TextField
      inputRef={ref}
      size="small"
      type="tel"
      placeholder="(918) 555-0142"
      value={value}
      slotProps={{ htmlInput: { inputMode: 'tel', ...(ariaLabel && { 'aria-label': ariaLabel }) } }}
      onChange={(event) => {
        const input = event.target;
        let before = input.value.slice(0, input.selectionStart ?? input.value.length).replace(/\D/g, '').length;
        let digits = input.value.replace(/\D/g, '');
        if ((event.nativeEvent as InputEvent).inputType === 'deleteContentBackward' && digits === value.replace(/\D/g, '') && before > 0) {
          digits = digits.slice(0, before - 1) + digits.slice(before);
          before -= 1;
        }
        const text = formatPhoneDigits(digits.slice(0, digits[0] === '1' ? 11 : 10));
        let pos = 0;
        for (let seen = 0; pos < text.length && seen < before; pos++) if (/\d/.test(text[pos])) seen++;
        caret.current = pos;
        onChange(text);
      }}
    />
  );
}

interface CardNumberProps {
  card: string;
  devices: DeviceRange[];
  duplicate?: boolean;
}

/**
 * A card number chip with its Device Association name tooltip; highlighted red when unassigned or duplicated.
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
export function CardNumber({ card, devices, duplicate = false }: CardNumberProps) {
  const dev = deviceNameFor(devices, card);
  const label = `${card} · ${dev || 'not in any device range'}${duplicate ? ' · ALSO ASSIGNED TO ANOTHER DIRECTORY CODE' : ''}`;
  return (
    <Tooltip title={label}>
      <Chip
        size="small"
        label={duplicate ? `${card} (dup)` : card}
        color={duplicate || !dev ? 'error' : 'default'}
        variant={duplicate ? 'filled' : 'outlined'}
        sx={{ fontFamily: 'monospace', fontSize: '0.78rem', height: 22 }}
      />
    </Tooltip>
  );
}

interface CardListProps {
  cards: string[];
  devices: DeviceRange[];
  dups?: Set<string>;
}

/**
 * Wrapped list of assigned card chips.
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
export function CardList({ cards, devices, dups }: CardListProps) {
  return (
    <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', maxWidth: '24rem' }}>
      {cards.map((card) => <CardNumber key={card} card={card} devices={devices} duplicate={Boolean(dups && dups.has(card))} />)}
    </Stack>
  );
}

interface CardsEditorProps {
  cards: string[];
  devices: DeviceRange[];
  onChange: (cards: string[]) => void;
}

/**
 * Device (card) editor using accessible MUI Chips (`00001-65407`, up to `MAX_CARDS_PER_ENTRY`).
 *
 * @param props - Component props.
 * @returns Rendered React element.
 */
export function CardsEditor({ cards, devices, onChange }: CardsEditorProps) {
  const [add, setAdd] = useState('');
  const [error, setError] = useState('');
  const addNow = () => {
    const number = add.replace(/\D/g, '');
    if (!number) return;
    if (Number(number) < 1 || Number(number) > 65407) { setError('Device codes are 00001-65407'); return; }
    if (cards.includes(String(Number(number)))) { setError(`Card ${Number(number)} is already added.`); setAdd(''); return; }
    if (cards.length >= MAX_CARDS_PER_ENTRY) { setError(`At most ${MAX_CARDS_PER_ENTRY} cards per directory code`); return; }
    onChange([...cards, String(Number(number))]);
    setAdd('');
    setError('');
  };
  return (
    <Stack spacing={1}>
      <Typography variant="body2" component="div" sx={{ fontWeight: 500, display: 'flex', alignItems: 'center' }}>
        Devices / cards<HelpTip of="cards" />
      </Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {cards.map((num, i) => {
          const dev = deviceNameFor(devices, num);
          return (
            <Chip
              key={num}
              size="small"
              label={`${num} · ${dev || 'no device'}`}
              color={dev ? 'default' : 'error'}
              variant="outlined"
              onDelete={() => onChange(cards.filter((_, j) => j !== i))}
            />
          );
        })}
      </Stack>
      <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <TextField
          size="small"
          placeholder="Card number"
          value={add}
          slotProps={{ htmlInput: { inputMode: 'numeric', maxLength: 5, 'aria-label': 'Card number' } }}
          onChange={(event) => setAdd(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addNow(); } }}
          sx={{ width: 150 }}
        />
        <Button variant="outlined" size="small" onClick={addNow} disabled={cards.length >= MAX_CARDS_PER_ENTRY}>
          Add device
        </Button>
        <Typography variant="caption" color="text.secondary">{cards.length} of {MAX_CARDS_PER_ENTRY}</Typography>
      </Stack>
      {error && <Alert severity="error" sx={{ py: 0 }}>{error}</Alert>}
    </Stack>
  );
}
