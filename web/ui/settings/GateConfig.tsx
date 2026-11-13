import { useState } from 'react';
import { Button, Card, Checkbox, Flex, Grid, Heading, Select, Text, TextField } from '@radix-ui/themes';
import type { GateConfig as Config, GateFeatures, GatePrefs, ResidentsReply } from '../../../src/types.ts';
import { errorText, type GateApi } from '../api.ts';
import { useConfirm } from '../Confirm.tsx';
import { featuresOf, trackerOf } from '../format.ts';
import { Field } from '../panes/fields.tsx';
import { HelpTip } from '../HelpTip.tsx';

export const CONFIG_KEYS: (keyof Config)[] = ['siteName', 'memorySize', 'areaCodes', 'modelNumber', 'antiPassBack', 'interface1816'];
export const CONFIG_OPTIONS: Partial<Record<keyof Config, string[]>> = {
  memorySize: ['1000', '2000', '3000'], areaCodes: ['10 Area Codes', '255 Area Codes'], modelNumber: ['1833/1835/1837/1838', '1834'],
  antiPassBack: ['N', 'Y'], interface1816: ['N', 'Y'],
};
export const CONFIG_LABELS: Record<keyof Config, string> = {
  siteName: 'Site name', memorySize: 'System memory', areaCodes: 'Area codes', modelNumber: 'Model',
  antiPassBack: 'Anti-passback', interface1816: 'Interface 1816/1820',
};

// Gate configuration (must match the gate; DKS Cloud uses it to connect), the working copy's area codes and the
// directory code digits. gate: what the gate's last pull records (system memory, memory chips), to point out a mismatch.
export function GateConfig({ prefs, defaults, list, gapi, gate = {}, onSaved }: {
  prefs: GatePrefs; defaults: Config; list: ResidentsReply | null; gapi: GateApi; gate?: { memory?: string; chips?: string };
  onSaved: () => Promise<void>;
}) {
  const [cfg, setCfg] = useState<Record<string, string>>(() => Object.fromEntries(CONFIG_KEYS.map((k) => [k, (prefs.gateConfig && prefs.gateConfig[k]) || defaults[k] || ''])));
  const [info, setInfo] = useState('');
  const [digits, setDigits] = useState(String(list ? list.dirDigits : 3));
  const [digitsInfo, setDigitsInfo] = useState('');
  const [features, setFeatures] = useState<GateFeatures>(() => featuresOf(prefs));
  const [featuresInfo, setFeaturesInfo] = useState('');
  const [tracker, setTracker] = useState(() => trackerOf(prefs).enabled);
  const [trackerInfo, setTrackerInfo] = useState('');
  const [dialog, confirm] = useConfirm();
  const areaCodes = list ? list.areaCodes : [];
  const from = list ? list.dirDigits : 3;
  const saved = (k: keyof Config) => (prefs.gateConfig && prefs.gateConfig[k]) || defaults[k] || '';
  const mismatches = [
    ...(gate.memory && /^\d+$/.test(gate.memory) && saved('memorySize') !== gate.memory
      ? [`The gate records a system memory of ${gate.memory}, but System memory here is ${saved('memorySize')}.`] : []),
    ...(gate.chips === 'Anti-pass back' && saved('antiPassBack') !== 'Y'
      ? ['The gate reports anti-pass back memory chips, but Anti-passback here is N.'] : []),
    ...(gate.chips && gate.chips !== 'Anti-pass back' && !gate.chips.startsWith('?') && saved('antiPassBack') === 'Y'
      ? [`The gate reports ${gate.chips} memory chips (no anti-pass back), but Anti-passback here is Y.`] : []),
  ];

  async function save() {
    setInfo('Saving…');
    try { await gapi('PUT', '/prefs', { gateConfig: cfg }); setInfo('Saved. Pulls and sends will use these.'); await onSaved(); } catch (e) {
      setInfo(`Save failed: ${errorText(e)}`);
    }
  }

  // The Floors/Elevators switches save at once; they only change what the page shows.
  async function toggle(key: keyof GateFeatures, on: boolean) {
    const next = { ...features, [key]: on };
    setFeatures(next);
    setFeaturesInfo('Saving…');
    try { await gapi('PUT', '/prefs', { features: next }); setFeaturesInfo('Saved.'); await onSaved(); } catch (e) {
      setFeatures(features);
      setFeaturesInfo(`Save failed: ${errorText(e)}`);
    }
  }

  async function toggleTracker(on: boolean) {
    setTracker(on);
    setTrackerInfo('Saving…');
    try { await gapi('PUT', '/prefs', { tracker: { ...prefs.tracker, enabled: on } }); setTrackerInfo('Saved.'); await onSaved(); } catch (e) {
      setTracker(!on);
      setTrackerInfo(`Save failed: ${errorText(e)}`);
    }
  }

  async function changeDigits() {
    const to = Number(digits);
    if (to === from) { setDigitsInfo(`Already ${to} digits.`); return; }
    const decrease = to < from;
    const ok = await confirm(decrease
      ? { title: `Decrease to ${to} digits?`, action: 'Destroy resident data and change', color: 'red',
        body: `Decreasing from ${from} to ${to} digits DESTROYS ALL RESIDENT DATA in the working copy (directory, phone numbers, cards, area codes).` }
      : { title: `Increase to ${to} digits?`, action: 'Change digits',
        body: `Increase from ${from} to ${to} digits? Existing codes get leading zeros. Decreasing later will clear all resident data.` });
    if (!ok) { setDigits(String(from)); return; }
    try {
      await gapi('PUT', '/dir-digits', { digits: to, confirm: decrease });
      setDigitsInfo(`Changed to ${to} digits. Send to update the gate.`);
      await onSaved();
    } catch (e) { setDigitsInfo(`Change failed: ${errorText(e)}`); }
  }

  return (
    <Card>
      {dialog}
      <Flex direction="column" gap="3">
        <Heading size="3">Gate configuration</Heading>
        <Text size="2" color="gray">
          These must match the gate's own settings; DKS Cloud uses them to connect. Stored locally and <strong>shared by every
          account that manages this gate</strong> (keyed by system phone number). Pulls and sends use them automatically.
        </Text>
        <Grid columns={{ initial: '1', sm: '2', md: '3' }} gap="3">
          {CONFIG_KEYS.map((k) => (
            <Field key={k} label={CONFIG_LABELS[k]} help={k}>
              {CONFIG_OPTIONS[k] ? (
                <Select.Root value={cfg[k]} onValueChange={(v) => setCfg({ ...cfg, [k]: v })}>
                  <Select.Trigger />
                  <Select.Content>{CONFIG_OPTIONS[k]!.map((o) => <Select.Item key={o} value={o}>{o}</Select.Item>)}</Select.Content>
                </Select.Root>
              ) : <TextField.Root value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} />}
            </Field>
          ))}
        </Grid>
        {mismatches.map((m) => <Text key={m} size="2" color="red" role="alert">{m} They must match, or pulls and sends fail.</Text>)}
        <Flex gap="3" align="center"><Button onClick={save}>Save gate configuration</Button><Text size="2" color="gray">{info}</Text></Flex>
        <Flex direction="column" gap="2">
          <Text as="label" size="2"><Flex gap="2" align="center">
            <Checkbox checked={tracker} onCheckedChange={(v) => toggleTracker(v === true)} />
            Tracker (Tracker expansion boards are connected; not for the 1834)<HelpTip of="tracker" />
            <Text size="2" color="gray">{trackerInfo}</Text>
          </Flex></Text>
          <Text size="1" color="gray">
            Shows the "Additional relays" choices on the Relays page. Saved for this page only, not sent to the gate.
          </Text>
        </Flex>
        <Flex direction="column" gap="2">
          <Text size="2" weight="medium">Show on the page<HelpTip of="showOnPage" /></Text>
          <Text size="2" color="gray">
            Turn off what this gate doesn't use to hide it from the tables and forms. Nothing on the gate changes, and
            the stored values are kept.
          </Text>
          <Flex gap="4" align="center" wrap="wrap">
            <Text as="label" size="2"><Flex gap="2" align="center">
              <Checkbox checked={features.floors} onCheckedChange={(v) => toggle('floors', v === true)} />
              Floors (Residents Floor column and field, Security Levels Floors column)
            </Flex></Text>
            <Text as="label" size="2"><Flex gap="2" align="center">
              <Checkbox checked={features.elevators} onCheckedChange={(v) => toggle('elevators', v === true)} />
              Elevators (Residents Elevator column and field, Elevator Reference and Relay / Elevator pages)
            </Flex></Text>
            <Text size="2" color="gray">{featuresInfo}</Text>
          </Flex>
        </Flex>
        {areaCodes.length > 0 && (
          <Text size="2" color="gray">
            Working copy has {areaCodes.length} area code{areaCodes.length === 1 ? '' : 's'}: {areaCodes.map((a) => `${a.code} (${a.uses})`).join(', ')}.
            4-digit codes (1 + area code) are dialed as long distance.
          </Text>
        )}
        <Flex gap="3" align="end" wrap="wrap">
          <Field label="Num of digits in dir code" help="dirDigits">
            <Select.Root value={digits} onValueChange={setDigits}>
              <Select.Trigger />
              <Select.Content>{['1', '2', '3', '4'].map((d) => <Select.Item key={d} value={d}>{d}</Select.Item>)}</Select.Content>
            </Select.Root>
          </Field>
          <Button variant="soft" onClick={changeDigits} disabled={!list}>Change digits</Button>
          <Text size="2" color="gray">{digitsInfo}</Text>
        </Flex>
      </Flex>
    </Card>
  );
}
