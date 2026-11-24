import type { ReactNode } from 'react';
import {
  Alert,
  Box as MuiBox,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import type { GateSettingRow } from '../types.ts';
import type { GateApi } from '../api.ts';
import { HelpTip } from '../HelpTip.tsx';
import { Box, PENDING_BG, setBit, UNSAVED_BG } from './GroupPage.tsx';
import { SettingInput, SettingsBar } from './SettingsBar.tsx';
import type { GateSettings } from './useGateSettings.ts';

/** Relay bitmask settings shown as a checkbox per relay (bit r = relay r). */
const RELAY_BITS: [string, string][] = [['relayPostalSwitch', 'Postal switch'], ['relayRotaryDial9', 'Rotary dial 9']];

/** Settings groups that have their own page (kept out of this editor). */
export const DEDICATED_GROUPS = new Set(['Holidays', 'Facility Codes', 'Hold Open', 'Elevator', 'Relay Elevator', 'Security', 'Anti-Pass Back']);

/**
 * Relays: one row per relay, one column per setting (strike time, the 4 open tones, entry code range, plus the
 * postal switch / rotary dial 9 checkboxes from RELAY_BITS).
 */
const RELAY_COLS: [string, string][] = [
  ['Time', 'Strike time (s)'], ['ToneMomentary', 'Momentary'], ['ToneHold', 'Hold'], ['ToneRelease', 'Release'],
  ['ToneHold1Hr', 'Hold 1 Hr'], ['EntryCodeRangeFrom', 'From'], ['EntryCodeRangeTo', 'To'],
];

interface FieldGridProps {
  settings: GateSettings;
  fields: GateSettingRow[];
}

function FieldGrid({ settings, fields }: FieldGridProps) {
  return (
    <MuiBox sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' }, gap: 2 }}>
      {fields.map((setting) => (
        <Stack key={setting.key} spacing={0.5} component="label">
          <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center' }}>
            {setting.name}<HelpTip of={setting.key} />
          </Typography>
          <SettingInput settings={settings} setting={setting} />
          {setting.note && <Typography variant="caption" color="text.secondary">{setting.note}</Typography>}
        </Stack>
      ))}
    </MuiBox>
  );
}

interface FieldRowsProps {
  settings: GateSettings;
  fields: GateSettingRow[];
}

/**
 * One row per setting: its name (and note) on the left, its box on the right.
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.fields - Field names or field updates.
 * @returns Rendered React element.
 */
function FieldRows({ settings, fields }: FieldRowsProps) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ width: 'fit-content', maxWidth: '100%' }}>
      <Table size="small">
        <TableBody>
          {fields.map((setting) => (
            <TableRow key={setting.key}>
              <TableCell component="th" scope="row">
                <Typography variant="body2" sx={{ display: 'flex', alignItems: 'center' }}>
                  {setting.name}<HelpTip of={setting.key} />
                </Typography>
                {setting.note && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{setting.note}</Typography>}
              </TableCell>
              <TableCell><SettingInput settings={settings} setting={setting} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

/**
 * Tone-open settings whose digit another tone also uses, and one line per clashing digit. Tracker command relays are
 * left out (their row is locked); the server refuses the same clashes.
 *
 * @param settings - Settings map or configuration.
 * @param locked - `Record<number, string>` value.
 * @returns `{ keys: Set<string>; lines: string[] }` result.
 */
function toneClashes(settings: GateSettings, locked: Record<number, string>): { keys: Set<string>; lines: string[] } {
  const uses = new Map<string, GateSettingRow[]>();
  for (const setting of settings.fields) {
    const match = /^relay(\d)Tone/.exec(setting.key);
    const v = settings.current(setting).trim();
    if (!match || !v || locked[Number(match[1])]) continue;
    uses.set(v, [...(uses.get(v) || []), setting]);
  }
  const clashes = [...uses].filter(([, list]) => list.length > 1);
  return {
    keys: new Set(clashes.flatMap(([, list]) => list.map((setting) => setting.key))),
    lines: clashes.map(([digit, list]) => `Digit ${digit}: ${list.map((setting) => setting.name.replace(' tone open: ', ' ')).join(', ')}`),
  };
}

interface RelayTableProps {
  settings: GateSettings;
  fields: GateSettingRow[];
  relayLabels: Record<string, string | undefined>;
  lockedRelays: Record<number, string>;
  relays: number[];
  nameCell?: (relay: number) => ReactNode;
  clash: { keys: Set<string>; lines: string[] };
}

/**
 * lockedRelays: relay -> note, for Tracker command relays. Their whole row is read-only: strike time fixed at 00, and
 * the tones, entry code range, postal switch and rotary dial 9 belong on relay 0 instead (DoorKing manual 3.1.3).
 * relays: the rows (0-2, plus the Tracker relays, which have only a name); nameCell: the name box of a relay.
 * clash: tone-open settings that share a digit (red).
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.fields - Field names or field updates.
 * @param props.relayLabels - Relay labels.
 * @param props.lockedRelays - Relay -> note, for Tracker command relays.
 * @param props.relays - Relay numbers to show (0–2, plus enabled Tracker relays 3–18).
 * @param props.nameCell - The name box of a relay.
 * @param props.clash - Set of tone-open setting keys that share a duplicate digit.
 * @returns Rendered React element.
 */
function RelayTable({ settings, fields, relayLabels, lockedRelays, relays, nameCell, clash }: RelayTableProps) {
  const byKey = new Map(fields.map((setting) => [setting.key, setting]));
  const used = new Set<string>();
  const label = (relay: number) => (relayLabels[relay] && relayLabels[relay] !== `Relay ${relay}` ? relayLabels[relay] : '');
  const span = RELAY_COLS.length + RELAY_BITS.length;
  const rows = relays.map((relay) => (relay > 2 ? (
    <TableRow key={relay}>
      <TableCell component="th" scope="row">Relay {relay}</TableCell>
      <TableCell>{nameCell ? nameCell(relay) : label(relay)}</TableCell>
      <TableCell colSpan={span}>
        <Typography variant="caption" color="text.secondary">
          Tracker relay ({relay <= 10 ? 'Tracker 2, commanded by relay 2' : 'Tracker 1, commanded by relay 1'}): times are set at the hardware
        </Typography>
      </TableCell>
    </TableRow>
  ) : (
    <TableRow key={relay}>
      <TableCell component="th" scope="row">Relay {relay}</TableCell>
      <TableCell>{nameCell ? nameCell(relay) : label(relay)}</TableCell>
      {RELAY_COLS.map(([suffix]) => {
        const setting = byKey.get(`relay${relay}${suffix}`);
        if (setting) used.add(setting.key);
        if (setting && lockedRelays[relay]) {
          const text = suffix === 'Time' ? '00' : settings.current(setting) || '—';
          return (
            <TableCell key={suffix}>
              <Tooltip title={`Locked: ${lockedRelays[relay]}`}>
                <Typography variant="body2" color="text.secondary" component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                  {text}<LockOutlinedIcon sx={{ fontSize: 14 }} />
                </Typography>
              </Tooltip>
            </TableCell>
          );
        }
        return (
          <TableCell key={suffix}>
            {setting
              ? <SettingInput settings={settings} setting={setting} invalid={clash.keys.has(setting.key) ? 'Duplicate digit' : undefined} />
              : <Typography variant="body2" color="text.secondary">—</Typography>}
          </TableCell>
        );
      })}
      {RELAY_BITS.map(([key, bitLabel]) => {
        const setting = byKey.get(key);
        if (!setting) return <TableCell key={key}><Typography variant="body2" color="text.secondary">—</Typography></TableCell>;
        used.add(setting.key);
        const on = settings.current(setting)[relay] === '1';
        if (lockedRelays[relay]) {
          return (
            <TableCell key={key}>
              <Tooltip title={`Locked: ${lockedRelays[relay]}`}>
                <Typography variant="body2" color="text.secondary" component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                  {on ? 'On' : 'Off'}<LockOutlinedIcon sx={{ fontSize: 14 }} />
                </Typography>
              </Tooltip>
            </TableCell>
          );
        }
        const background = settings.current(setting)[relay] !== setting.value[relay] ? UNSAVED_BG
          : setting.value[relay] !== setting.gate[relay] ? PENDING_BG : undefined;
        return (
          <TableCell key={key} sx={{ backgroundColor: background }}>
            <Box
              checked={on}
              ariaLabel={`${bitLabel} for Relay ${relay}`}
              onChange={(checked) => settings.edit(setting, setBit(settings.current(setting), relay, checked))}
            />
          </TableCell>
        );
      })}
    </TableRow>
  )));
  const rest = fields.filter((setting) => !used.has(setting.key));
  return (
    <Stack spacing={2}>
      {clash.lines.length > 0 && (
        <Alert severity="error" role="alert">
          <MuiBox component="strong">Each tone-open digit can be used only once.</MuiBox> Change the red boxes before saving:
          <MuiBox component="ul" sx={{ m: 0, pl: 2.5 }}>
            {clash.lines.map((line) => <li key={line}>{line}</li>)}
          </MuiBox>
        </Alert>
      )}
      <TableContainer component={Paper} variant="outlined" sx={{ maxWidth: '100%' }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell rowSpan={2}>Relay</TableCell>
              <TableCell rowSpan={2}>Name<HelpTip of="relayName" /></TableCell>
              <TableCell rowSpan={2}>Strike time (s)<HelpTip of="strikeTime" /></TableCell>
              <TableCell colSpan={4}>Tone to open<HelpTip of="toneToOpen" /></TableCell>
              <TableCell colSpan={2}>Entry code range<HelpTip of="entryCodeRange" /></TableCell>
              <TableCell colSpan={2}>Activated by</TableCell>
            </TableRow>
            <TableRow>
              {RELAY_COLS.slice(1).map(([k, colLabel]) => <TableCell key={k}>{colLabel}</TableCell>)}
              {RELAY_BITS.map(([k, colLabel]) => (
                <TableCell key={k}>{colLabel}<HelpTip of={k === 'relayPostalSwitch' ? 'postalSwitch' : 'rotaryDial9'} /></TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>{rows}</TableBody>
        </Table>
      </TableContainer>
      {Object.entries(lockedRelays).map(([relay, note]) => (
        <Typography key={relay} variant="caption" color="text.secondary">Relay {relay}: {note}</Typography>
      ))}
      {rest.length > 0 && <FieldGrid settings={settings} fields={rest} />}
    </Stack>
  );
}

interface GateSettingsEditorProps {
  settings: GateSettings;
  view: 'prefs' | 'relays' | 'display';
  displayMode?: 'single' | '8line';
  relayLabels?: Record<string, string | undefined>;
  lockedRelays?: Record<number, string>;
  relays?: number[];
  nameCell?: (relay: number) => ReactNode;
  gapi: GateApi;
  onReload: () => Promise<void> | void;
}

/**
 * The gate settings editor. prefs (System Settings): every group except Relays and Display; relays: the Relays
 * group; display: the Display group of the LCD layout chosen (single line or 8 line).
 * relays / nameCell: the Relays view's rows and name boxes (see RelayTable).
 *
 * @param props - Component props.
 * @param props.settings - Settings map or configuration.
 * @param props.view - View.
 * @param [props.displayMode] - Display mode.
 * @param [props.relayLabels] - Relay labels.
 * @param [props.lockedRelays] - Locked relays.
 * @param [props.relays] - The Relays group.
 * @param props.nameCell - Name cell.
 * @param props.gapi - Gate-scoped API fetch helper.
 * @param props.onReload - Callback to reload the gate data.
 * @returns Rendered React element.
 */
export function GateSettingsEditor({ settings, view, displayMode = 'single', relayLabels = {}, lockedRelays = {}, relays = [0, 1, 2], nameCell,
  gapi, onReload }: GateSettingsEditorProps) {
  const shown = settings.fields.filter((setting) => !DEDICATED_GROUPS.has(setting.group));
  const groups = [...new Set(shown.map((setting) => setting.group))];
  const hiddenDisplay = displayMode === 'single' ? 'Display (8 line)' : 'Display (single line)';
  const wanted = groups.filter((group) => (view === 'display' ? group.startsWith('Display') && group !== hiddenDisplay
    : view === 'relays' ? group === 'Relays' : !group.startsWith('Display') && group !== 'Relays'));
  const clash = view === 'relays' ? toneClashes(settings, lockedRelays) : { keys: new Set<string>(), lines: [] };

  return (
    <Stack spacing={3}>
      <SettingsBar settings={settings} gapi={gapi} onReload={onReload}
        blocked={clash.lines.length ? 'Two or more tones use the same digit; change the red boxes first' : undefined} />
      {view === 'display' ? wanted.map((group) => (
        <Stack key={group} spacing={1.5}>
          <Typography variant="h6" component="h3">{group}</Typography>
          <TableContainer component={Paper} variant="outlined" sx={{ width: 'fit-content', maxWidth: '100%' }}>
            <Table size="small">
              <TableHead>
                <TableRow><TableCell>Setting</TableCell><TableCell>Value</TableCell></TableRow>
              </TableHead>
              <TableBody>
                {shown.filter((setting) => setting.group === group).map((setting) => (
                  <TableRow key={setting.key}>
                    <TableCell>{setting.name}</TableCell>
                    <TableCell><SettingInput settings={settings} setting={setting} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Stack>
      )) : wanted.map((group) => (
        <Stack key={group} spacing={1.5}>
          {view === 'prefs' && <Typography variant="h6" component="h3">{group}</Typography>}
          {group === 'Relays' ? <RelayTable settings={settings} fields={shown.filter((setting) => setting.group === group)} relayLabels={relayLabels} lockedRelays={lockedRelays}
            relays={relays} nameCell={nameCell} clash={clash} />
            : <FieldRows settings={settings} fields={shown.filter((setting) => setting.group === group)} />}
        </Stack>
      ))}
    </Stack>
  );
}
