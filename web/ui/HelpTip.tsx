import { useState, type MouseEvent } from 'react';
import { Box, IconButton, Popover, Tooltip, Typography, useMediaQuery } from '@mui/material';
import { HelpOutlineOutlined as HelpOutlineIcon } from '@mui/icons-material';
import { HELP } from './help.ts';

interface HelpTipProps {
  of?: string;
  text?: string;
}

/**
 * A small "?" icon button that shows more detail on hover/focus (desktop) or tap popover (touch screens).
 *
 * @param props - Component props.
 * @param props.of - Key in `HELP`.
 * @param props.text - Custom help text.
 * @returns Rendered React element.
 */
export function HelpTip({ of, text }: HelpTipProps) {
  const touch = useMediaQuery('(hover: none)');
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const content = text ?? (of ? HELP[of] : undefined);
  if (!content) return null;

  const stop = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  if (!touch) {
    return (
      <Tooltip title={<Box sx={{ maxWidth: 320, whiteSpace: 'normal' }}>{content}</Box>} arrow>
        <IconButton size="small" aria-label="More information" onClick={stop}
          sx={{ ml: 0.5, p: 0.25, color: 'text.secondary', verticalAlign: 'middle' }}>
          <HelpOutlineIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
    );
  }

  return (
    <>
      <IconButton size="small" aria-label="More information"
        onClick={(event) => { stop(event); setAnchorEl(anchorEl ? null : event.currentTarget); }}
        sx={{ ml: 0.5, p: 0.5, color: 'text.secondary', verticalAlign: 'middle' }}>
        <HelpOutlineIcon sx={{ fontSize: 16 }} />
      </IconButton>
      <Popover open={Boolean(anchorEl)} anchorEl={anchorEl} onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        onClick={(event) => event.stopPropagation()}>
        <Typography variant="body2" sx={{ p: 1.5, maxWidth: 'min(340px, 90vw)' }}>{content}</Typography>
      </Popover>
    </>
  );
}
