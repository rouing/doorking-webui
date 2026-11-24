/**
 * @module web/ui/theme
 *
 * Material Design 3 Expressive theme matching the native Android app (`Color.kt` / `Theme.kt`):
 * DoorKing Blue brand palette, full cool-neutral MD3 surface container ladder, semantic container/on-container pills,
 * borderless tonal cards & accordions, pill search bars, and M3 navigation active indicators.
 */
import { createTheme } from '@mui/material/styles';

const isCoarsePointer = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

const MD3_LIGHT = {
  primary: '#00639B',
  onPrimary: '#FFFFFF',
  primaryContainer: '#CEE5FF',
  onPrimaryContainer: '#001D33',
  secondary: '#51606F',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#D5E4F7',
  onSecondaryContainer: '#0E1D2A',
  tertiary: '#67587A',
  onTertiary: '#FFFFFF',
  tertiaryContainer: '#EDDCFF',
  onTertiaryContainer: '#221533',
  success: '#1B7A43',
  onSuccess: '#FFFFFF',
  successContainer: '#C8F5D6',
  onSuccessContainer: '#052E15',
  warning: '#A05B00',
  onWarning: '#FFFFFF',
  warningContainer: '#FFE0B5',
  onWarningContainer: '#341A00',
  error: '#BA1A1A',
  onError: '#FFFFFF',
  errorContainer: '#FFDAD6',
  onErrorContainer: '#410002',
  surface: '#F7F9FC',
  onSurface: '#181C20',
  onSurfaceVariant: '#42474E',
  surfaceLowest: '#FFFFFF',
  surfaceLow: '#F1F4F9',
  surfaceContainer: '#EBEEF3',
  surfaceHigh: '#E6E8EE',
  surfaceHighest: '#E0E2E8',
  outline: '#72777F',
  outlineVariant: '#C2C7CF',
} as const;

const MD3_DARK = {
  primary: '#96CCFF',
  onPrimary: '#003353',
  primaryContainer: '#004A76',
  onPrimaryContainer: '#CEE5FF',
  secondary: '#B9C8DA',
  onSecondary: '#233240',
  secondaryContainer: '#3A4857',
  onSecondaryContainer: '#D5E4F7',
  tertiary: '#D2BFE7',
  onTertiary: '#382A4A',
  tertiaryContainer: '#4F4061',
  onTertiaryContainer: '#EDDCFF',
  success: '#7CE2A0',
  onSuccess: '#00391B',
  successContainer: '#0E532B',
  onSuccessContainer: '#C8F5D6',
  warning: '#FFB963',
  onWarning: '#4F2B00',
  warningContainer: '#703F00',
  onWarningContainer: '#FFE0B5',
  error: '#FFB4AB',
  onError: '#690005',
  errorContainer: '#93000A',
  onErrorContainer: '#FFDAD6',
  surface: '#101418',
  onSurface: '#E0E2E8',
  onSurfaceVariant: '#C2C7CF',
  surfaceLowest: '#0B0E12',
  surfaceLow: '#181C20',
  surfaceContainer: '#1C2024',
  surfaceHigh: '#262A2F',
  surfaceHighest: '#31353A',
  outline: '#8C9199',
  outlineVariant: '#42474E',
} as const;

const M3_EASE = 'cubic-bezier(0.2, 0, 0, 1)';
const DESKTOP_MQ = '@media (min-width: 761px)';

/**
 * Builds the DoorKing Gate Manager Material 3 Expressive theme for light or dark appearance.
 *
 * @param dark - True for dark mode.
 * @returns Configured MUI theme instance.
 */
export function createAppTheme(dark: boolean) {
  const c = dark ? MD3_DARK : MD3_LIGHT;
  const fieldSize = isCoarsePointer() ? 'medium' : 'small';

  return createTheme({
    cssVariables: true,
    palette: {
      mode: dark ? 'dark' : 'light',
      primary: { main: c.primary, contrastText: c.onPrimary },
      secondary: { main: c.secondary, contrastText: c.onSecondary },
      success: { main: c.success, contrastText: c.onSuccess },
      warning: { main: c.warning, contrastText: c.onWarning },
      error: { main: c.error, contrastText: c.onError },
      background: { default: c.surface, paper: c.surfaceLow },
      text: { primary: c.onSurface, secondary: c.onSurfaceVariant },
      divider: c.outlineVariant,
      action: {
        hover: dark ? 'rgba(224, 226, 232, 0.08)' : 'rgba(24, 28, 32, 0.06)',
        selected: c.secondaryContainer,
      },
    },
    shape: { borderRadius: 16 },
    typography: {
      fontFamily: '"Roboto Flex", "Roboto", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
      h4: { fontWeight: 700, letterSpacing: '-0.015em', fontVariantNumeric: 'tabular-nums' },
      h5: { fontWeight: 700, letterSpacing: '-0.01em' },
      h6: { fontWeight: 600, letterSpacing: '-0.005em' },
      subtitle1: { fontWeight: 600 },
      subtitle2: { fontWeight: 600 },
      button: { textTransform: 'none', fontWeight: 600, letterSpacing: '0.01em' },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ':root': {
            '--md-surface': c.surface,
            '--md-surface-lowest': c.surfaceLowest,
            '--md-surface-low': c.surfaceLow,
            '--md-surface-container': c.surfaceContainer,
            '--md-surface-high': c.surfaceHigh,
            '--md-surface-highest': c.surfaceHighest,
            '--md-primary-container': c.primaryContainer,
            '--md-on-primary-container': c.onPrimaryContainer,
            '--md-secondary-container': c.secondaryContainer,
            '--md-on-secondary-container': c.onSecondaryContainer,
            '--md-success-container': c.successContainer,
            '--md-on-success-container': c.onSuccessContainer,
            '--md-warning-container': c.warningContainer,
            '--md-on-warning-container': c.onWarningContainer,
            '--md-error-container': c.errorContainer,
            '--md-on-error-container': c.onErrorContainer,
            '--md-outline': c.outline,
            '--md-outline-variant': c.outlineVariant,
            '--md-card-radius': '16px',
            [DESKTOP_MQ]: {
              '--md-card-radius': '10px',
            },
          },
          body: {
            backgroundColor: c.surface,
            color: c.onSurface,
            fontFeatureSettings: '"cv02", "cv03", "cv04", "cv11"',
          },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            backgroundColor: c.surface,
            color: c.onSurface,
            borderBottom: `1px solid ${c.outlineVariant}`,
          },
        },
      },
      MuiCard: {
        defaultProps: { elevation: 0, variant: 'elevation' },
        styleOverrides: {
          root: {
            borderRadius: 'var(--md-card-radius, 16px)',
            backgroundColor: c.surfaceLow,
            backgroundImage: 'none',
            border: 'none',
          },
        },
      },
      MuiCardContent: {
        styleOverrides: {
          root: {
            padding: 16,
            '&:last-child': { paddingBottom: 16 },
          },
        },
      },
      MuiAccordion: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            borderRadius: 'var(--md-card-radius, 16px) !important',
            backgroundColor: c.surfaceLow,
            backgroundImage: 'none',
            border: 'none !important',
            overflow: 'hidden',
            '&::before': { display: 'none' },
          },
        },
      },
      MuiAccordionDetails: {
        styleOverrides: {
          root: {
            '& .MuiCard-root': {
              backgroundColor: c.surfaceHigh,
            },
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            [DESKTOP_MQ]: { borderRadius: 10 },
          },
          outlined: {
            borderColor: c.outlineVariant,
            backgroundColor: c.surfaceLowest,
          },
        },
      },
      MuiDialog: {
        defaultProps: { maxWidth: 'sm', fullWidth: true },
        styleOverrides: {
          paper: {
            borderRadius: 28,
            [DESKTOP_MQ]: { borderRadius: 14 },
            backgroundColor: c.surfaceHigh,
            padding: 4,
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: c.surfaceLow,
          },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            borderRadius: 999,
            [DESKTOP_MQ]: { borderRadius: 6 },
            transition: `background-color 160ms ${M3_EASE}, transform 120ms ${M3_EASE}, color 160ms ${M3_EASE}`,
            '&:active:not(:disabled)': { transform: 'scale(0.985)' },
            variants: [
              // M3 Filled Tonal treatment for secondary ("outlined") buttons.
              {
                props: { variant: 'outlined' },
                style: {
                  border: 'none',
                  backgroundColor: c.secondaryContainer,
                  color: c.onSecondaryContainer,
                  '&:hover': {
                    border: 'none',
                    backgroundColor: c.primaryContainer,
                    color: c.onPrimaryContainer,
                  },
                },
              },
              {
                props: { variant: 'outlined', color: 'inherit' },
                style: {
                  border: 'none',
                  backgroundColor: c.surfaceHighest,
                  color: c.onSurface,
                  '&:hover': {
                    border: 'none',
                    backgroundColor: c.secondaryContainer,
                    color: c.onSecondaryContainer,
                  },
                },
              },
              {
                props: { variant: 'outlined', color: 'error' },
                style: {
                  border: 'none',
                  backgroundColor: c.errorContainer,
                  color: c.onErrorContainer,
                  '&:hover': {
                    border: 'none',
                    filter: dark ? 'brightness(1.12)' : 'brightness(0.95)',
                  },
                },
              },
              {
                props: { variant: 'outlined', color: 'warning' },
                style: {
                  border: 'none',
                  backgroundColor: c.warningContainer,
                  color: c.onWarningContainer,
                  '&:hover': {
                    border: 'none',
                    filter: dark ? 'brightness(1.12)' : 'brightness(0.95)',
                  },
                },
              },
              {
                props: { variant: 'outlined', color: 'success' },
                style: {
                  border: 'none',
                  backgroundColor: c.successContainer,
                  color: c.onSuccessContainer,
                  '&:hover': {
                    border: 'none',
                    filter: dark ? 'brightness(1.12)' : 'brightness(0.95)',
                  },
                },
              },
            ],
          },
        },
      },
      MuiChip: {
        defaultProps: { variant: 'filled' },
        styleOverrides: {
          root: {
            borderRadius: 999,
            [DESKTOP_MQ]: { borderRadius: 6 },
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            backgroundColor: c.surfaceHighest,
            color: c.onSurfaceVariant,
            variants: [
              {
                props: { color: 'primary' },
                style: { backgroundColor: c.primaryContainer, color: c.onPrimaryContainer },
              },
              {
                props: { color: 'success' },
                style: { backgroundColor: c.successContainer, color: c.onSuccessContainer },
              },
              {
                props: { color: 'warning' },
                style: { backgroundColor: c.warningContainer, color: c.onWarningContainer },
              },
              {
                props: { color: 'error' },
                style: { backgroundColor: c.errorContainer, color: c.onErrorContainer },
              },
              {
                props: { variant: 'outlined' },
                style: { border: 'none', backgroundColor: c.surfaceHighest, color: c.onSurfaceVariant },
              },
              {
                props: { variant: 'outlined', color: 'primary' },
                style: { border: 'none', backgroundColor: c.primaryContainer, color: c.onPrimaryContainer },
              },
              {
                props: { variant: 'outlined', color: 'success' },
                style: { border: 'none', backgroundColor: c.successContainer, color: c.onSuccessContainer },
              },
              {
                props: { variant: 'outlined', color: 'warning' },
                style: { border: 'none', backgroundColor: c.warningContainer, color: c.onWarningContainer },
              },
              {
                props: { variant: 'outlined', color: 'error' },
                style: { border: 'none', backgroundColor: c.errorContainer, color: c.onErrorContainer },
              },
            ],
          },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: {
            borderRadius: 12,
            variants: [
              { props: { severity: 'error' }, style: { backgroundColor: c.errorContainer, color: c.onErrorContainer } },
              { props: { severity: 'warning' }, style: { backgroundColor: c.warningContainer, color: c.onWarningContainer } },
              { props: { severity: 'success' }, style: { backgroundColor: c.successContainer, color: c.onSuccessContainer } },
              { props: { severity: 'info' }, style: { backgroundColor: c.primaryContainer, color: c.onPrimaryContainer } },
            ],
          },
        },
      },
      MuiTextField: {
        defaultProps: { size: fieldSize },
        styleOverrides: {
          root: {
            '& .MuiOutlinedInput-root': {
              borderRadius: 12,
              [DESKTOP_MQ]: { borderRadius: 8 },
              backgroundColor: c.surfaceLowest,
              transition: `background-color 150ms ${M3_EASE}, border-color 150ms ${M3_EASE}`,
            },
            // M3 contained borderless pill search bar on mobile, crisp rounded-square on desktop.
            '&:has(input[type="search"]) .MuiOutlinedInput-root': {
              borderRadius: 999,
              [DESKTOP_MQ]: { borderRadius: 8 },
              backgroundColor: c.surfaceHigh,
              '& fieldset': { borderColor: 'transparent' },
              '&:hover fieldset': { borderColor: 'transparent' },
              '&.Mui-focused fieldset': { borderColor: c.primary, borderWidth: 1.5 },
            },
          },
        },
      },
      MuiSelect: {
        defaultProps: { size: fieldSize },
        styleOverrides: {
          root: {
            borderRadius: 12,
            [DESKTOP_MQ]: { borderRadius: 8 },
            backgroundColor: c.surfaceLowest,
          },
        },
      },
      MuiSwitch: {
        styleOverrides: {
          root: {
            padding: 7,
          },
          track: {
            borderRadius: 999,
            backgroundColor: c.surfaceHighest,
            opacity: 1,
            border: `1.5px solid ${c.outline}`,
          },
          switchBase: {
            '&.Mui-checked + .MuiSwitch-track': {
              backgroundColor: c.primary,
              borderColor: c.primary,
              opacity: 1,
            },
            '&.Mui-checked .MuiSwitch-thumb': {
              color: c.onPrimary,
            },
          },
          thumb: {
            boxShadow: 'none',
          },
        },
      },
      MuiTabs: {
        styleOverrides: {
          indicator: {
            height: 3,
            borderRadius: '3px 3px 0 0',
          },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontWeight: 600,
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 999,
            [DESKTOP_MQ]: { borderRadius: 8 },
            transition: `background-color 160ms ${M3_EASE}`,
            '&.Mui-selected': {
              backgroundColor: c.secondaryContainer,
              color: c.onSecondaryContainer,
              '&:hover': { backgroundColor: c.secondaryContainer },
            },
          },
        },
      },
      MuiBottomNavigation: {
        styleOverrides: {
          root: {
            height: 66,
            backgroundColor: c.surfaceContainer,
          },
        },
      },
      MuiBottomNavigationAction: {
        styleOverrides: {
          root: {
            minWidth: 0,
            paddingLeft: 4,
            paddingRight: 4,
            color: c.onSurfaceVariant,
            '& > .MuiSvgIcon-root, & > .MuiBadge-root': {
              boxSizing: 'content-box',
              padding: '4px 16px',
              borderRadius: 16,
              transition: `background-color 180ms ${M3_EASE}, color 180ms ${M3_EASE}`,
            },
            '&.Mui-selected': {
              color: c.onSurface,
              '& > .MuiSvgIcon-root, & > .MuiBadge-root': {
                backgroundColor: c.secondaryContainer,
                color: c.onSecondaryContainer,
              },
            },
          },
          label: {
            fontSize: '0.75rem',
            marginTop: 2,
            whiteSpace: 'nowrap',
            '&.Mui-selected': { fontSize: '0.75rem', fontWeight: 700 },
          },
        },
      },
      MuiToggleButtonGroup: {
        styleOverrides: {
          root: {
            borderRadius: 999,
            [DESKTOP_MQ]: { borderRadius: 6 },
            overflow: 'hidden',
          },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontWeight: 600,
            borderColor: c.outlineVariant,
            '&.Mui-selected': {
              backgroundColor: c.secondaryContainer,
              color: c.onSecondaryContainer,
              '&:hover': { backgroundColor: c.secondaryContainer },
            },
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          sizeSmall: { padding: '7px 10px' },
          head: { fontWeight: 600, backgroundColor: c.surfaceLow },
        },
      },
    },
  });
}
