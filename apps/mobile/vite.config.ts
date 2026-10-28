import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const version = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version;
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [react()],
  define: { __MOBILE_VERSION__: JSON.stringify(version) },
  server: { host: '127.0.0.1', port: 15175, strictPort: true },
  build: { outDir: 'dist', target: 'es2022' },
});
