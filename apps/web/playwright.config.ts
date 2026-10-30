import { defineConfig } from '@playwright/test';

// Runs against the local stack (docs/local-development.md): the API on 3000 and the seeded synthetic data.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.pw.ts',
  use: { baseURL: 'http://127.0.0.1:5173' },
  webServer: { command: 'npx vite', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
});
