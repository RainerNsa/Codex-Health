import { defineConfig } from '@playwright/test';

// Runs against the built preview (npm run build first), served as Vercel serves it: static files only.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.pw.ts',
  use: { baseURL: 'http://127.0.0.1:4180' },
  webServer: { command: 'npx vite preview --port 4180 --strictPort', url: 'http://127.0.0.1:4180/app.html', reuseExistingServer: true },
});
