import { defineConfig } from 'vite';

// The bundled first-run page. Everything it needs ships in the app; the CSP
// in src-tauri/tauri.conf.json allows nothing remote.
export default defineConfig({
  clearScreen: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'safari16',
  },
  server: { fs: { allow: ['..'] } },
});
