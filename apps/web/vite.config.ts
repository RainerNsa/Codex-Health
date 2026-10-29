import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to the local API (apps/api, 127.0.0.1:3000), so the browser never talks to a
// database or holds a credential; the API is the only thing that touches data.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:3000' } },
});
