import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

// Standalone React + MUI PWA frontend.
// `npm run build` writes ./dist (served by Caddy/Nginx/Ingress under /* while /api/* routes to doorking-api).
// `npm run dev` serves on port 5173 and proxies /api, /help, /download and /.well-known to API_ORIGIN.
const API = process.env.API_ORIGIN || 'http://localhost:8080';
const proxyToApi = { target: API, changeOrigin: true, headers: { origin: API } };

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), VitePWA({
    strategies: 'injectManifest',
    srcDir: '.',
    filename: 'sw.ts',
    registerType: 'prompt',
    injectRegister: false,
    includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'icon.svg'],
    manifest: {
      name: 'Doorking Gate', short_name: 'Doorking Gate', description: 'Manage DoorKing gates through DKS Cloud',
      theme_color: '#0090ff', background_color: '#0090ff',
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
  build: { outDir: fileURLToPath(new URL('./dist', import.meta.url)), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': proxyToApi,
      '/help': proxyToApi,
      '/privacy': proxyToApi,
      '/download': proxyToApi,
      '/.well-known': proxyToApi,
    },
  },
});
