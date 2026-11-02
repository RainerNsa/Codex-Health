import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to the local API (apps/api, 127.0.0.1:3000), so the browser never talks to a
// database or holds a credential; the API is the only thing that touches data.
// Same policy as CloudFront's in infra/terraform/envs/demo/main.tf, but for LocalStack. Chakra writes inline styles.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http://127.0.0.1:4566; connect-src 'self' http://127.0.0.1:4566; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:3000' } },
  preview: { headers: { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } },
});
