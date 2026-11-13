import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// New web page (React + Radix Themes). `npm run build` writes web/dist, served by web/server.ts;
// `npm run dev` serves it on port 5173 and sends /api to the server on port 8080 (as from localhost:8080, since the
// server accepts only its own Host and Origin).
const API = 'http://localhost:8080';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL('../dist', import.meta.url)), emptyOutDir: true },
  server: { port: 5173, proxy: { '/api': { target: API, changeOrigin: true, headers: { origin: API } } } },
});
