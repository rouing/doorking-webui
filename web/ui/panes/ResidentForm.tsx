import { useState } from 'react';
import { Button, Checkbox, Flex, Grid, Heading, Select, Text, TextArea, TextField } from '@radix-ui/themes';
import type { DeviceRange, GateFeatures, ResidentRow } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { phoneFull, securityText } from '../format.ts';
import { CardsEditor, Field, PhoneField } from './fields.tsx';
import { HelpTip } from '../HelpTip.tsx';

const NOTE_MAX = 500; // src/notes.ts

// Directory codes 0 and 1 (000, 001, ...) always get the maximum talk time; the DoorKing manual keeps them for the
// manager's office or an emergency number, so new entries aren't offered them first.
const reservedCode = (c: string) => /^\d+$/.test(c) && Number(c) <= 1;

// Edits a resident (every field) or vendor (name, entry code, security level, cards) in the working copy, or adds a new one
// (r null). Nothing goes to the gate until Send. Floor and elevator reference are hidden when the gate's features
// turn them off; their values are kept.
export function ResidentForm({ r, vendor, dirDigits, emptyCodes, devices, features, gapi, onDone, onCancel }: {
  r: ResidentRow | null;
  vendor: boolean;
  dirDigits: number;
  emptyCodes: string[];
  devices: DeviceRange[];
  features: GateFeatures;
  gapi: GateApi;
  onDone: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [code, setCode] = useState(r ? r.directoryCode : emptyCodes.find((c) => !reservedCode(c)) || '');
  const [name, setName] = useState(r ? r.name : '');
  const [phone, setPhone] = useState(r ? phoneFull(r) : '');
  const [entryCode, setEntryCode] = useState(r ? r.entryCode : '');
  const [securityLevel, setSecurity] = useState(r && r.securityLevel !== '' ? String(r.securityLevel) : '1');
  const [floor, setFloor] = useState(r ? String(r.floor) : '');
  const [elevatorRef, setElevator] = useState(String((r && r.elevatorRef) || 1));
  const [hidden, setHidden] = useState(r ? r.hidden : false);
  const [cards, setCards] = useState((r ? r.cards : []).map((c) => String(Number(c))));
  const [note, setNote] = useState(r ? r.note || '' : '');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [dialog, confirm] = useConfirm();
  const noun = vendor ? 'vendor' : 'resident';

  const run = async (busyText: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setInfo(busyText);
    try { await fn(); await onDone(); } catch (e) { setInfo(errorText(e)); setBusy(false); }
  };

  // The edit payload; the combined phone is split into area code (3 digits, or 1 + area code for long distance)
  // and the 7-digit number.
  function payload(): Record<string, unknown> | null {
    const out: Record<string, unknown> = { name, entryCode, cards, securityLevel: Number(securityLevel || 0) };
    if (vendor) return out;
    const full = phone.replace(/\D/g, '');
    if (full && full.length !== 7 && full.length !== 10 && !(full.length === 11 && full[0] === '1')) {
      setInfo('Phone must be 7 digits, 10 with area code, or 11 starting with 1 for long distance.');
      return null;
    }
    return { ...out, areaCode: full.slice(0, -7), phone: full.slice(-7), floor, elevatorRef: Number(elevatorRef), hidden };
  }

  // The note is local (not in the working copy), saved after the entry when it changed.
  const saveNote = (dirCode: string) => (note.trim() === ((r && r.note) || '') ? Promise.resolve()
    : gapi('PUT', `/residents/${encodeURIComponent(dirCode)}/note`, { note }));

  function save() {
    const body = payload();
    if (!body) return;
    if (note.trim().length > NOTE_MAX) { setInfo(`A note is at most ${NOTE_MAX} characters.`); return; }
    if (r) {
      run('Saving…', async () => {
        await gapi('PUT', `/residents/${encodeURIComponent(r.directoryCode)}`, { ...body, directoryCode: r.directoryCode });
        await saveNote(r.directoryCode);
      });
      return;
    }
    if (!new RegExp(`^\\d{${dirDigits}}$`).test(code)) { setInfo(`Enter a ${dirDigits}-digit directory code.`); return; }
    if (!name.trim()) { setInfo('A name is required.'); return; }
    run('Creating…', async () => {
      await gapi('POST', '/residents', { ...body, directoryCode: code, vendor });
      await saveNote(code);
    });
  }

  async function remove(whole: boolean) {
    if (!r) return;
    const who = `${r.name || '(no name)'} · code ${r.directoryCode}`;
    const ok = await confirm(whole
      ? { title: `Remove directory code ${r.directoryCode}?`, action: 'Remove code', color: 'red',
        body: `"${who}": this deletes the entry, phone record and all cards, and takes code ${r.directoryCode} off the gate (it will no longer be a vacant slot). Nothing is sent to the gate until you Send.` }
      : { title: `Delete ${noun} "${who}"?`, action: `Delete ${noun}`, color: 'red',
        body: 'This clears the name, phone, entry code and all cards for this directory slot in the working copy. The slot (directory code) itself stays, matching how the gate marks an empty slot. Nothing is sent to the gate until you Send.' });
    if (!ok) return;
    run(whole ? 'Removing…' : 'Deleting…',
      () => gapi('DELETE', `${whole ? '/directory-codes' : '/residents'}/${encodeURIComponent(r.directoryCode)}`));
  }

  return (
    <Flex direction="column" gap="3" onClick={(e) => e.stopPropagation()}>
      {dialog}
      {!r && <Heading size="3">Add {noun}</Heading>}
      <Grid columns={{ initial: '1', sm: '2', md: '3' }} gap="3">
        {!r && (
          <Field label="Directory code (vacant or new)" help="directoryCode">
            <TextField.Root inputMode="numeric" maxLength={dirDigits} placeholder={`e.g. ${'5'.repeat(dirDigits)}`} list="dk-empty-codes"
              value={code} onChange={(e) => setCode(e.target.value)} />
            <datalist id="dk-empty-codes">
              {[...emptyCodes.filter((c) => !reservedCode(c)), ...emptyCodes.filter(reservedCode)].map((c) => <option key={c} value={c} />)}
            </datalist>
            {reservedCode(code) && (
              <Text size="1" color="amber">Codes {'0'.padStart(dirDigits, '0')} and {'1'.padStart(dirDigits, '0')} always get the maximum talk time; best kept for the office or an emergency number.</Text>
            )}
          </Field>
        )}
        <Field label="Name"><TextField.Root maxLength={15} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        {!vendor && <Field label="Phone (area + number)"><PhoneField value={phone} onChange={setPhone} /></Field>}
        <Field label="Entry code" help="entryCode">
          <TextField.Root inputMode="numeric" maxLength={4} value={entryCode} onChange={(e) => setEntryCode(e.target.value)} />
        </Field>
        <Field label="Security level" help="securityLevel">
          <Select.Root value={securityLevel} onValueChange={setSecurity}>
            <Select.Trigger />
            <Select.Content>
              {Array.from({ length: 31 }, (_, i) => <Select.Item key={i} value={String(i)}>{securityText(i)}</Select.Item>)}
            </Select.Content>
          </Select.Root>
        </Field>
        {!vendor && (
          <>
            {features.floors && (
              <Field label="Floor (blank = none)" help="floor">
                <TextField.Root type="number" min={1} max={64} value={floor} onChange={(e) => setFloor(e.target.value)} />
              </Field>
            )}
            {features.elevators && (
              <Field label="Elevator reference" help="elevatorRef">
                <Select.Root value={elevatorRef} onValueChange={setElevator}>
                  <Select.Trigger />
                  <Select.Content>
                    {Array.from({ length: 8 }, (_, i) => <Select.Item key={i} value={String(i + 1)}>{i + 1}</Select.Item>)}
                  </Select.Content>
                </Select.Root>
              </Field>
            )}
            <Text as="label" size="2">
              <Flex gap="2" align="center" height="100%">
                <Checkbox checked={hidden} onCheckedChange={(v) => setHidden(v === true)} /> Hidden from the entry-panel directory<HelpTip of="hidden" />
              </Flex>
            </Text>
          </>
        )}
      </Grid>
      <CardsEditor cards={cards} devices={devices} onChange={setCards} />
      <Field label="Notes" help="notes">
        <TextArea maxLength={NOTE_MAX} rows={2} value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 640 }} />
      </Field>
      <Flex gap="3" align="center" wrap="wrap">
        <Button onClick={save} disabled={busy}>{r ? 'Save to working copy' : `Create ${noun}`}</Button>
        {r && <Button color="red" variant="soft" onClick={() => remove(false)} disabled={busy}>Delete {noun}</Button>}
        {r && <Button color="red" variant="soft" onClick={() => remove(true)} disabled={busy}
          title="Delete the entry and take the directory code off the gate">Remove code</Button>}
        {onCancel && <Button variant="soft" color="gray" onClick={onCancel}>{r ? 'Close editor' : 'Cancel'}</Button>}
        <Text size="2" color="gray">{info}</Text>
      </Flex>
    </Flex>
  );
}
