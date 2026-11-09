import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import vercel from '../../vercel.json';

const stub = fileURLToPath(new URL('./src/node-stub.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  publicDir: '../web/public',
  // the API's modules import pg and node:crypto for their server paths; the preview never takes those paths
  resolve: { alias: { pg: stub, 'node:crypto': stub } },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  build: { target: 'es2022', rollupOptions: { input: { site: 'index.html', app: 'app.html' } } },
  server: { host: '127.0.0.1', fs: { allow: ['../..'] } },
  // the headers Vercel serves (vercel.json), so the e2e test runs under the same CSP
  preview: { headers: Object.fromEntries(vercel.headers[0]!.headers.map((h) => [h.key, h.value])) },
});
