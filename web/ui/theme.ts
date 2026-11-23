/**
 * @module web/ui/theme
 *
 * Shared Material UI theme configuration (light & dark color schemes with solid buttons & filled pills).
 */
import { alpha, createTheme } from '@mui/material/styles';

const isCoarsePointer = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

/**
 * Builds the DoorKing Gate Manager MUI theme for light or dark appearance.
 *
 * @param dark - True for dark mode.
 * @returns Configured MUI theme instance.
 */
export function createAppTheme(dark: boolean) {
  const fieldSize = isCoarsePointer() ? 'medium' : 'small';
  return createTheme({
    cssVariables: true,
    palette: {
      mode: dark ? 'dark' : 'light',
      primary: {
        main: dark ? '#64b5f6' : '#1565c0',
      },
      secondary: {
        main: dark ? '#90caf9' : '#0288d1',
      },
      background: dark
        ? { default: '#111318', paper: '#1a1d24' }
        : { default: '#f4f6f9', paper: '#ffffff' },
    },
    shape: { borderRadius: 10 },
    typography: {
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      h4: { fontWeight: 600 },
      h5: { fontWeight: 600 },
      h6: { fontWeight: 600 },
      button: { textTransform: 'none', fontWeight: 500 },
    },
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: ({ theme }) => ({
            variants: [
              // Solid tonal surfaces for secondary ("outlined") buttons instead of transparent wireframes.
              {
                props: { variant: 'outlined' },
                style: {
                  borderColor: 'transparent',
                  backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.11),
                  '&:hover': {
                    borderColor: 'transparent',
                    backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.28 : 0.18),
                  },
                },
              },
              {
                props: { variant: 'outlined', color: 'inherit' },
                style: {
                  borderColor: 'transparent',
                  backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.12)' : theme.palette.grey[200],
                  '&:hover': {
                    borderColor: 'transparent',
                    backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.2)' : theme.palette.grey[300],
                  },
                },
              },
              {
                props: { variant: 'outlined', color: 'error' },
                style: {
                  borderColor: 'transparent',
                  backgroundColor: alpha(theme.palette.error.main, theme.palette.mode === 'dark' ? 0.2 : 0.12),
                  '&:hover': {
                    borderColor: 'transparent',
                    backgroundColor: alpha(theme.palette.error.main, theme.palette.mode === 'dark' ? 0.3 : 0.2),
                  },
                },
              },
              {
                props: { variant: 'outlined', color: 'warning' },
                style: {
                  borderColor: 'transparent',
                  backgroundColor: alpha(theme.palette.warning.main, theme.palette.mode === 'dark' ? 0.22 : 0.14),
                  '&:hover': {
                    borderColor: 'transparent',
                    backgroundColor: alpha(theme.palette.warning.main, theme.palette.mode === 'dark' ? 0.32 : 0.22),
                  },
                },
              },
              {
                props: { variant: 'outlined', color: 'success' },
                style: {
                  borderColor: 'transparent',
                  backgroundColor: alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.2 : 0.12),
                  '&:hover': {
                    borderColor: 'transparent',
                    backgroundColor: alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.3 : 0.2),
                  },
                },
              },
            ],
          }),
        },
      },
      MuiChip: {
        defaultProps: { variant: 'filled' },
        styleOverrides: {
          root: ({ theme }) => ({
            fontWeight: 500,
            variants: [
              {
                props: { variant: 'outlined' },
                style: {
                  borderColor: 'transparent',
                  backgroundColor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.12)' : theme.palette.grey[200],
                },
              },
              {
                props: { variant: 'outlined', color: 'primary' },
                style: {
                  borderColor: 'transparent',
                  backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.22 : 0.14),
                },
              },
              {
                props: { variant: 'outlined', color: 'success' },
                style: {
                  borderColor: 'transparent',
                  backgroundColor: alpha(theme.palette.success.main, theme.palette.mode === 'dark' ? 0.22 : 0.14),
                },
              },
              {
                props: { variant: 'outlined', color: 'warning' },
                style: {
                  borderColor: 'transparent',
                  backgroundColor: alpha(theme.palette.warning.main, theme.palette.mode === 'dark' ? 0.24 : 0.16),
                },
              },
              {
                props: { variant: 'outlined', color: 'error' },
                style: {
                  borderColor: 'transparent',
                  backgroundColor: alpha(theme.palette.error.main, theme.palette.mode === 'dark' ? 0.22 : 0.14),
                },
              },
            ],
          }),
        },
      },
      MuiBottomNavigationAction: {
        styleOverrides: {
          root: { minWidth: 0, paddingLeft: 2, paddingRight: 2 },
          label: {
            fontSize: '0.75rem',
            whiteSpace: 'nowrap',
            '&.Mui-selected': { fontSize: '0.75rem', fontWeight: 700 },
          },
        },
      },
      MuiCard: {
        defaultProps: { variant: 'outlined' },
      },
      MuiAccordion: {
        styleOverrides: {
          root: ({ theme }) => ({
            borderRadius: `${theme.shape.borderRadius}px !important`,
            overflow: 'hidden',
            '&::before': { display: 'none' },
          }),
        },
      },
      MuiPaper: {
        styleOverrides: {
          outlined: ({ theme }) => ({
            borderColor: theme.palette.divider,
          }),
        },
      },
      MuiTextField: {
        defaultProps: { size: fieldSize },
      },
      MuiSelect: {
        defaultProps: { size: fieldSize },
      },
      MuiTableCell: {
        styleOverrides: {
          sizeSmall: { padding: '6px 10px' },
          head: { fontWeight: 600 },
        },
      },
      MuiDialog: {
        defaultProps: { maxWidth: 'sm', fullWidth: true },
      },
    },
  });
}
