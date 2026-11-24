/**
 * @module web/ui/panes/MobilePrimitives
 *
 * Pixel-exact Material 3 mobile primitives matching the native Android app (`DoorKingComponents.kt`):
 * - MobileSearchBar: 56px tall borderless pill (`var(--md-surface-high)`), 24px Search icon, 16px text, clear button.
 * - MobileFilterChip: 32px tall, 8px corner radius M3 FilterChip (selected = secondaryContainer no border,
 *   unselected = transparent + 1px outlineVariant border).
 */
import { Box, ButtonBase, IconButton, InputBase } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';

interface MobileSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel?: string;
}

export function MobileSearchBar({ value, onChange, placeholder, ariaLabel }: MobileSearchBarProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        height: 56,
        px: 2,
        gap: 1.5,
        borderRadius: '999px',
        bgcolor: 'var(--md-surface-high)',
        color: 'text.primary',
      }}
    >
      <SearchIcon sx={{ fontSize: 24, color: 'text.secondary', flexShrink: 0 }} />
      <InputBase
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputProps={{ 'aria-label': ariaLabel || placeholder }}
        sx={{
          flex: 1,
          minWidth: 0,
          fontSize: '1rem',
          lineHeight: 1.5,
          '& input::placeholder': {
            color: 'text.secondary',
            opacity: 1,
          },
          '& input::-webkit-search-cancel-button': {
            display: 'none',
          },
        }}
      />
      {value && (
        <IconButton
          size="small"
          aria-label="Clear search"
          onClick={() => onChange('')}
          sx={{ color: 'text.secondary', mr: -0.75 }}
        >
          <CloseIcon sx={{ fontSize: 20 }} />
        </IconButton>
      )}
    </Box>
  );
}

interface MobileFilterChipProps {
  label: string;
  selected: boolean;
  onClick: () => void;
  showCheck?: boolean;
}

export function MobileFilterChip({ label, selected, onClick, showCheck = false }: MobileFilterChipProps) {
  return (
    <ButtonBase
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      sx={{
        height: 32,
        px: selected && showCheck ? 1.25 : 1.75,
        gap: 0.75,
        borderRadius: '8px',
        fontSize: '0.875rem',
        fontWeight: 500,
        lineHeight: 1,
        flexShrink: 0,
        bgcolor: selected ? 'var(--md-secondary-container)' : 'transparent',
        color: selected ? 'var(--md-on-secondary-container)' : 'text.secondary',
        border: selected ? '1px solid transparent' : '1px solid var(--md-outline)',
        transition: 'background-color 140ms ease, border-color 140ms ease, color 140ms ease',
      }}
    >
      {selected && showCheck && <CheckIcon sx={{ fontSize: 16 }} />}
      <span>{label}</span>
    </ButtonBase>
  );
}
