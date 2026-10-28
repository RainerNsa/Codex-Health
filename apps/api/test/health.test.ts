import { expect, it } from 'vitest';
import { buildServer } from '../src/server.ts';

it('GET /health is ok and every response is no-store', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok' });
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['x-content-type-options']).toBe('nosniff');

  const missing = await app.inject({ method: 'GET', url: '/nope' });
  expect(missing.statusCode).toBe(404);
  expect(missing.headers['cache-control']).toBe('no-store');
  await app.close();
});
