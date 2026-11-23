import { useState, type MouseEvent } from 'react';
import { Button, Divider, ListItemIcon, ListItemText, Menu, MenuItem, Typography } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import type { GateInfo } from '../../../src/types.ts';
import { api, errorText } from '../api.ts';
import { useBackLayer } from '../back.ts';
import { gateLabel, roleLabel } from '../Gates.tsx';

interface GateSwitcherProps {
  gate: GateInfo; // the open gate
  onSwitch: (to: GateInfo) => void;
  onAllGates: () => void;
}

/**
 * The gate's name in the sidebar (and the phone's menu): opens a list of the user's gates to switch to, and All gates.
 *
 * @param props - Component props.
 * @param props.gate - Currently open gate summary (`GateInfo`).
 * @param props.onSwitch - On switch.
 * @param props.onAllGates - On all gates.
 * @returns Rendered React element.
 */
export function GateSwitcher({ gate, onSwitch, onAllGates }: GateSwitcherProps) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [gates, setGates] = useState<GateInfo[] | null>(null);
  const [error, setError] = useState('');
  const open = Boolean(anchorEl);
  const close = () => setAnchorEl(null);
  useBackLayer(open, close);

  const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
    setAnchorEl(event.currentTarget);
    api<{ gates: GateInfo[] }>('GET', '/api/gates').then(
      (reply) => { setGates(reply.gates); setError(''); },
      (err) => setError(errorText(err)),
    );
  };

  return (
    <>
      <Button
        type="button"
        fullWidth
        color="inherit"
        endIcon={<KeyboardArrowDownIcon />}
        aria-label={`${gateLabel(gate)}: switch gate`}
        aria-haspopup="menu"
        aria-expanded={open ? 'true' : undefined}
        onClick={openMenu}
        sx={{
          justifyContent: 'space-between',
          textAlign: 'left',
          px: 1,
          py: 0.75,
          fontWeight: 700,
          fontSize: '0.95rem',
          lineHeight: 1.3,
        }}
      >
        <Typography component="span" variant="subtitle2" sx={{ fontWeight: 700, overflowWrap: 'anywhere', textAlign: 'left' }}>
          {gateLabel(gate)}
        </Typography>
      </Button>
      <Menu
        anchorEl={anchorEl}
        open={open}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { minWidth: 220, maxWidth: 'min(360px, 90vw)' } } }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, px: 2, py: 0.5, display: 'block' }}>
          Your gates
        </Typography>
        {!gates && !error && <MenuItem disabled>Loading…</MenuItem>}
        {error && <MenuItem disabled>{error}</MenuItem>}
        {gates?.map((other) => (
          <MenuItem
            key={other.phoneNumber}
            selected={other.phoneNumber === gate.phoneNumber}
            onClick={() => { close(); if (other.phoneNumber !== gate.phoneNumber) onSwitch(other); }}
          >
            <ListItemIcon sx={{ minWidth: 28 }}>
              {other.phoneNumber === gate.phoneNumber && <CheckIcon fontSize="small" aria-label="Open now" />}
            </ListItemIcon>
            <ListItemText primary={gateLabel(other)} slotProps={{ primary: { noWrap: true, variant: 'body2' } }} />
            {other.role !== 'admin' && (
              <Typography variant="caption" color="text.secondary" sx={{ ml: 1.5, flexShrink: 0 }}>
                {roleLabel(other.role)}
              </Typography>
            )}
          </MenuItem>
        ))}
        <Divider />
        <MenuItem onClick={() => { close(); onAllGates(); }}>All gates…</MenuItem>
      </Menu>
    </>
  );
}

