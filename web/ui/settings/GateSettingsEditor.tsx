import type { ReactNode } from 'react';
import { Box as RadixBox, Callout, Flex, Grid, Heading, Table, Text } from '@radix-ui/themes';
import type { GateSettingRow } from '../../../src/types.ts';
import type { GateApi } from '../api.ts';
import { HelpTip } from '../HelpTip.tsx';
import { Box, setBit } from './GroupPage.tsx';
import { SettingInput, SettingsBar } from './SettingsBar.tsx';
import type { GateSettings } from './useGateSettings.ts';

// Relay bitmask settings shown as a checkbox per relay (bit r = relay r).
const RELAY_BITS: [string, string][] = [['relayPostalSwitch', 'Postal switch'], ['relayRotaryDial9', 'Rotary dial 9']];

// Settings groups that have their own page (kept out of this editor).
export const DEDICATED_GROUPS = new Set(['Holidays', 'Facility Codes', 'Hold Open', 'Elevator', 'Relay Elevator', 'Security', 'Anti-Pass Back']);

// Relays: one row per relay, one column per setting (strike time, the 4 open tones, entry code range, plus the
// postal switch / rotary dial 9 checkboxes from RELAY_BITS).
const RELAY_COLS: [string, string][] = [
  ['Time', 'Strike time (s)'], ['ToneMomentary', 'Momentary'], ['ToneHold', 'Hold'], ['ToneRelease', 'Release'],
  ['ToneHold1Hr', 'Hold 1 Hr'], ['EntryCodeRangeFrom', 'From'], ['EntryCodeRangeTo', 'To'],
];

function FieldGrid({ gs, fields }: { gs: GateSettings; fields: GateSettingRow[] }) {
  return (
    <Grid columns={{ initial: '1', sm: '2', md: '3' }} gap="3">
      {fields.map((s) => (
        <label key={s.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Text size="2">{s.name}<HelpTip of={s.key} /></Text>
          <SettingInput gs={gs} s={s} />
          {s.note && <Text size="1" color="gray">{s.note}</Text>}
        </label>
      ))}
    </Grid>
  );
}

// One row per setting: its name (and note) on the left, its box on the right.
function FieldRows({ gs, fields }: { gs: GateSettings; fields: GateSettingRow[] }) {
  return (
    <Table.Root size="1" variant="surface" style={{ width: 'fit-content', maxWidth: '100%' }}>
      <Table.Body>
        {fields.map((s) => (
          <Table.Row key={s.key} align="center">
            <Table.RowHeaderCell>
              <Text size="2" weight="regular">{s.name}<HelpTip of={s.key} /></Text>
              {s.note && <Text as="div" size="1" color="gray">{s.note}</Text>}
            </Table.RowHeaderCell>
            <Table.Cell><SettingInput gs={gs} s={s} /></Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

// Tone-open settings whose digit another tone also uses, and one line per clashing digit. Tracker command relays are
// left out (their row is locked); the server refuses the same clashes.
function toneClashes(gs: GateSettings, locked: Record<number, string>): { keys: Set<string>; lines: string[] } {
  const uses = new Map<string, GateSettingRow[]>();
  for (const s of gs.fields) {
    const m = /^relay(\d)Tone/.exec(s.key);
    const v = gs.current(s).trim();
    if (!m || !v || locked[Number(m[1])]) continue;
    uses.set(v, [...(uses.get(v) || []), s]);
  }
  const clashes = [...uses].filter(([, list]) => list.length > 1);
  return {
    keys: new Set(clashes.flatMap(([, list]) => list.map((s) => s.key))),
    lines: clashes.map(([d, list]) => `Digit ${d}: ${list.map((s) => s.name.replace(' tone open: ', ' ')).join(', ')}`),
  };
}

// lockedRelays: relay -> note, for Tracker command relays. Their whole row is read-only: strike time fixed at 00, and
// the tones, entry code range, postal switch and rotary dial 9 belong on relay 0 instead (DoorKing manual 3.1.3).
// relays: the rows (0-2, plus the Tracker relays, which have only a name); nameCell: the name box of a relay.
// clash: tone-open settings that share a digit (red).
function RelayTable({ gs, fields, relayLabels, lockedRelays, relays, nameCell, clash }: {
  gs: GateSettings; fields: GateSettingRow[]; relayLabels: Record<string, string | undefined>; lockedRelays: Record<number, string>;
  relays: number[]; nameCell?: (r: number) => ReactNode; clash: { keys: Set<string>; lines: string[] };
}) {
  const byKey = new Map(fields.map((s) => [s.key, s]));
  const used = new Set<string>();
  const label = (r: number) => (relayLabels[r] && relayLabels[r] !== `Relay ${r}` ? relayLabels[r] : '');
  const span = RELAY_COLS.length + RELAY_BITS.length;
  const rows = relays.map((r) => (r > 2 ? (
    <Table.Row key={r}>
      <Table.RowHeaderCell>Relay {r}</Table.RowHeaderCell>
      <Table.Cell>{nameCell ? nameCell(r) : label(r)}</Table.Cell>
      <Table.Cell colSpan={span}><Text size="1" color="gray">Tracker relay ({r <= 10 ? 'Tracker 2, commanded by relay 2' : 'Tracker 1, commanded by relay 1'}): times are set at the hardware</Text></Table.Cell>
    </Table.Row>
  ) : (
    <Table.Row key={r}>
      <Table.RowHeaderCell>Relay {r}</Table.RowHeaderCell>
      <Table.Cell>{nameCell ? nameCell(r) : label(r)}</Table.Cell>
      {RELAY_COLS.map(([suffix]) => {
        const s = byKey.get(`relay${r}${suffix}`);
        if (s) used.add(s.key);
        if (s && lockedRelays[r]) {
          const text = suffix === 'Time' ? '00' : gs.current(s) || '—';
          return <Table.Cell key={suffix}><Text size="2" color="gray" title={`Locked: ${lockedRelays[r]}`}>{text} 🔒</Text></Table.Cell>;
        }
        return (
          <Table.Cell key={suffix}>
            {s ? <SettingInput gs={gs} s={s} invalid={clash.keys.has(s.key) ? 'This digit is already used by another tone' : undefined} />
              : <Text color="gray">—</Text>}
          </Table.Cell>
        );
      })}
      {RELAY_BITS.map(([key]) => {
        const s = byKey.get(key);
        if (!s) return <Table.Cell key={key}><Text color="gray">—</Text></Table.Cell>;
        used.add(s.key);
        const on = gs.current(s)[r] === '1';
        if (lockedRelays[r]) {
          return <Table.Cell key={key}><Text size="2" color="gray" title={`Locked: ${lockedRelays[r]}`}>{on ? 'On' : 'Off'} 🔒</Text></Table.Cell>;
        }
        const bg = gs.current(s)[r] !== s.value[r] ? 'var(--blue-a4)' : s.value[r] !== s.gate[r] ? 'var(--green-a4)' : undefined;
        return (
          <Table.Cell key={key} style={{ background: bg }}>
            <Box checked={on} onChange={(v) => gs.edit(s, setBit(gs.current(s), r, v))} />
          </Table.Cell>
        );
      })}
    </Table.Row>
  )));
  const rest = fields.filter((s) => !used.has(s.key));
  return (
    <Flex direction="column" gap="3">
      {clash.lines.length > 0 && (
        <Callout.Root color="red" role="alert">
          <Callout.Text><strong>Each tone-open digit can be used only once.</strong> Change the red boxes before saving:</Callout.Text>
          <RadixBox asChild><ul style={{ margin: 0 }}>{clash.lines.map((l) => <li key={l}>{l}</li>)}</ul></RadixBox>
        </Callout.Root>
      )}
      <Table.Root size="1" variant="surface">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell rowSpan={2}>Relay</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell rowSpan={2}>Name<HelpTip of="relayName" /></Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell rowSpan={2}>Strike time (s)<HelpTip of="strikeTime" /></Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell colSpan={4}>Tone to open<HelpTip of="toneToOpen" /></Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell colSpan={2}>Entry code range<HelpTip of="entryCodeRange" /></Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell colSpan={2}>Activated by</Table.ColumnHeaderCell>
          </Table.Row>
          <Table.Row>
            {RELAY_COLS.slice(1).map(([k, label]) => <Table.ColumnHeaderCell key={k}>{label}</Table.ColumnHeaderCell>)}
            {RELAY_BITS.map(([k, label]) => (
              <Table.ColumnHeaderCell key={k}>{label}<HelpTip of={k === 'relayPostalSwitch' ? 'postalSwitch' : 'rotaryDial9'} /></Table.ColumnHeaderCell>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>{rows}</Table.Body>
      </Table.Root>
      {Object.entries(lockedRelays).map(([r, note]) => <Text key={r} size="1" color="gray">Relay {r}: {note}</Text>)}
      {rest.length > 0 && <FieldGrid gs={gs} fields={rest} />}
    </Flex>
  );
}

// The gate settings editor. prefs (System Settings): every group except Relays and Display; relays: the Relays
// group; display: the Display group of the LCD layout chosen (single line or 8 line).
// relays / nameCell: the Relays view's rows and name boxes (see RelayTable).
export function GateSettingsEditor({ gs, view, displayMode = 'single', relayLabels = {}, lockedRelays = {}, relays = [0, 1, 2], nameCell,
  gapi, onReload, onJobStarted }: {
  gs: GateSettings;
  view: 'prefs' | 'relays' | 'display';
  displayMode?: 'single' | '8line';
  relayLabels?: Record<string, string | undefined>;
  lockedRelays?: Record<number, string>;
  relays?: number[];
  nameCell?: (r: number) => ReactNode;
  gapi: GateApi;
  onReload: () => Promise<void> | void;
  onJobStarted: () => void;
}) {
  const shown = gs.fields.filter((s) => !DEDICATED_GROUPS.has(s.group));
  const groups = [...new Set(shown.map((s) => s.group))];
  const hiddenDisplay = displayMode === 'single' ? 'Display (8 line)' : 'Display (single line)';
  const wanted = groups.filter((g) => (view === 'display' ? g.startsWith('Display') && g !== hiddenDisplay
    : view === 'relays' ? g === 'Relays' : !g.startsWith('Display') && g !== 'Relays'));
  const clash = view === 'relays' ? toneClashes(gs, lockedRelays) : { keys: new Set<string>(), lines: [] };

  return (
    <Flex direction="column" gap="4">
      <SettingsBar gs={gs} gapi={gapi} onReload={onReload} onJobStarted={onJobStarted}
        blocked={clash.lines.length ? 'Two or more tones use the same digit; change the red boxes first' : undefined} />
      {view === 'display' ? wanted.map((g) => (
        <Flex key={g} direction="column" gap="2">
          <Heading size="3">{g}</Heading>
          <Table.Root size="1" variant="surface" style={{ width: 'fit-content', maxWidth: '100%' }}>
            <Table.Header>
              <Table.Row><Table.ColumnHeaderCell>Setting</Table.ColumnHeaderCell><Table.ColumnHeaderCell>Value</Table.ColumnHeaderCell></Table.Row>
            </Table.Header>
            <Table.Body>
              {shown.filter((s) => s.group === g).map((s) => (
                <Table.Row key={s.key}>
                  <Table.Cell>{s.name}</Table.Cell><Table.Cell><SettingInput gs={gs} s={s} /></Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Flex>
      )) : wanted.map((g) => (
        <Flex key={g} direction="column" gap="2">
          {view === 'prefs' && <Heading size="3">{g}</Heading>}
          {g === 'Relays' ? <RelayTable gs={gs} fields={shown.filter((s) => s.group === g)} relayLabels={relayLabels} lockedRelays={lockedRelays}
            relays={relays} nameCell={nameCell} clash={clash} />
            : <FieldRows gs={gs} fields={shown.filter((s) => s.group === g)} />}
        </Flex>
      ))}
    </Flex>
  );
}
