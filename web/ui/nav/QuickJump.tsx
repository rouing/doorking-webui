/**
 * @module web/ui/nav/QuickJump
 *
 * Global Cmd/Ctrl+K quick-jump search dialog for the open gate: instant search across residents, vendors, cards,
 * entry codes, phone numbers, notes, recent transactions, and pages.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Box, Chip, Dialog, DialogContent, DialogTitle, IconButton, List, ListItemButton, ListItemText, TextField, Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import type { ResidentRow, TransactionRow } from '../../../src/types.ts';
import { useBackLayer } from '../back.ts';
import type { NavKey } from './pages.ts';
import { searchGate, type QuickJumpHit } from './quickJumpSearch.ts';

interface QuickJumpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  residents: ResidentRow[];
  transactions: TransactionRow[];
  elevators: boolean;
  onGoPage: (page: NavKey) => void;
  onOpenResident: (resident: ResidentRow) => void;
  onOpenTransaction: (transaction: TransactionRow) => void;
}

const KIND_BADGE: Record<QuickJumpHit['kind'], { label: string; color: 'primary' | 'warning' | 'default' }> = {
  resident: { label: 'Directory', color: 'primary' },
  transaction: { label: 'Activity', color: 'warning' },
  page: { label: 'Page', color: 'default' },
};

/**
 * Global Quick-Jump dialog (`Cmd/Ctrl+K`) for jumping directly to any resident, card, entry code, transaction, or page.
 *
 * @param props - Component props.
 * @param props.open - Whether the dialog is open.
 * @param props.onOpenChange - Callback toggling open state.
 * @param props.residents - Loaded working-copy resident/vendor rows.
 * @param props.transactions - Loaded transaction rows.
 * @param props.elevators - Whether elevator pages are shown.
 * @param props.onGoPage - Navigates to a gate page.
 * @param props.onOpenResident - Jumps to and highlights a resident/vendor.
 * @param props.onOpenTransaction - Opens a transaction (or its snapshot viewer).
 * @returns Rendered React element.
 */
export function QuickJump({
  open, onOpenChange, residents, transactions, elevators, onGoPage, onOpenResident, onOpenTransaction,
}: QuickJumpProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const scrollOnSelect = useRef(false);

  useBackLayer(open, () => onOpenChange(false));

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (open) { setQuery(''); setSelected(0); }
  }, [open]);

  const hits = useMemo(
    () => searchGate(query, { residents, transactions, elevators }),
    [query, residents, transactions, elevators],
  );

  useEffect(() => { setSelected(0); }, [query]);

  useEffect(() => {
    if (!scrollOnSelect.current) return;
    scrollOnSelect.current = false;
    itemRefs.current[selected]?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const choose = (hit: QuickJumpHit) => {
    onOpenChange(false);
    if (hit.kind === 'page') onGoPage(hit.page);
    else if (hit.kind === 'resident') onOpenResident(hit.resident);
    else onOpenTransaction(hit.transaction);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!hits.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      scrollOnSelect.current = true;
      setSelected((current) => (current + 1) % hits.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      scrollOnSelect.current = true;
      setSelected((current) => (current - 1 + hits.length) % hits.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(hits[Math.min(selected, hits.length - 1)]);
    }
  };

  return (
    <Dialog open={open} onClose={() => onOpenChange(false)} maxWidth="sm" fullWidth onKeyDown={handleKeyDown}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 1 }}>
        Quick jump
        <IconButton size="small" aria-label="Close" onClick={() => onOpenChange(false)}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent sx={{ pt: '4px !important' }}>
        <TextField
          autoFocus
          fullWidth
          placeholder="Search residents, cards, entry codes, phones, notes, or pages…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          slotProps={{ htmlInput: { 'aria-label': 'Search residents, cards, entry codes, phones, notes, or pages' } }}
        />
        <Box sx={{ mt: 1.5, maxHeight: 360, overflowY: 'auto' }}>
          {hits.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>No matches.</Typography>
          ) : (
            <List dense role="listbox" aria-label="Search results" disablePadding>
              {hits.map((hit, index) => {
                const active = index === selected;
                const badge = KIND_BADGE[hit.kind];
                return (
                  <ListItemButton
                    key={hit.id}
                    ref={(el) => { itemRefs.current[index] = el; }}
                    role="option"
                    aria-selected={active}
                    selected={active}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => choose(hit)}
                    sx={{ borderRadius: 1.5, gap: 1.5 }}
                  >
                    <ListItemText
                      primary={hit.title}
                      secondary={hit.subtitle}
                      slotProps={{
                        primary: { variant: 'body2', noWrap: true, sx: { fontWeight: 500 } },
                        secondary: { variant: 'caption', noWrap: true },
                      }}
                    />
                    <Chip size="small" label={badge.label} color={badge.color} variant="outlined" sx={{ flexShrink: 0 }} />
                  </ListItemButton>
                );
              })}
            </List>
          )}
        </Box>
      </DialogContent>
    </Dialog>
  );
}
