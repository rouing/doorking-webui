import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

// New web page (React + Radix Themes). `npm run build` writes web/dist, served by web/server.ts;
// `npm run dev` serves it on port 5173 and sends /api to the server on port 8080 (as from localhost:8080, since the
// server accepts only its own Host and Origin).
const API = 'http://localhost:8080';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), VitePWA({
    // Installable app (manifest + icons in public/) whose service worker (sw.ts) keeps only the page itself (HTML,
    // scripts, styles, icons) for a fast start and displays incoming Web Push alerts; /api, /help and camera files
    // always go to the server. UpdateNotice registers it and offers the reload when a newer build is waiting.
    strategies: 'injectManifest',
    srcDir: '.',
    filename: 'sw.ts',
    registerType: 'prompt',
    injectRegister: false,
    includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'icon.svg'],
    manifest: {
      name: 'Doorking Gate', short_name: 'Doorking Gate', description: 'Manage DoorKing gates through DKS Cloud',
      theme_color: '#0090ff', background_color: '#0090ff', // start screen: the icon on its own blue, for light and dark
      display: 'standalone', orientation: 'portrait', start_url: '/', scope: '/',
      icons: [
        { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
        { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    injectManifest: {
      globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
    },
  })],
  build: { outDir: fileURLToPath(new URL('../dist', import.meta.url)), emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': { target: API, changeOrigin: true, headers: { origin: API } } } },
});
