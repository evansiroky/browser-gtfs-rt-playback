import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The API lives on the same origin as the app in production; in development the server runs
// separately and Vite forwards `/api` to it.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // The map chunk (MapLibre GL JS) is loaded only by the trip screen and is large by nature.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
