import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App.tsx';
import { stackTablesOnPhones } from './stackTables.ts';
import { lsGet } from './api.ts';

stackTablesOnPhones();
// Dark mode before the page draws (no white flash at start): the account's setting, remembered by this browser (App).
document.documentElement.style.colorScheme = lsGet('dk-theme', false) ? 'dark' : 'light';
// Best-effort portrait lock on touch devices where Screen Orientation API allows it (installed PWAs / Android).
if (window.matchMedia('(pointer: coarse)').matches) {
  (screen.orientation as { lock?: (orientation: string) => Promise<void> } | undefined)?.lock?.('portrait')?.catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
