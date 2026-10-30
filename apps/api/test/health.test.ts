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

it('the sign-in stand-in runs only in development, test, or the demo with a 32+ character origin secret', async () => {
  const { assertAuthAllowed } = await import('../src/auth.ts');
  for (const env of ['development', 'test']) expect(() => assertAuthAllowed('local-stub', env)).not.toThrow();
  for (const [env, secret] of [['production', 'x'.repeat(40)], ['staging', undefined], [undefined, undefined], ['demo', undefined], ['demo', 'short']] as const) {
    expect(() => assertAuthAllowed('local-stub', env, secret), `${env} ${secret}`).toThrow(/refused/);
  }
  expect(() => assertAuthAllowed('local-stub', 'demo', 'x'.repeat(32))).not.toThrow();
});

it('demo: every request without CloudFront\'s origin secret is refused, health included', async () => {
  const { ORIGIN_HEADER } = await import('../src/server.ts');
  const secret = 'zz'.repeat(20);
  const app = buildServer({ originSecret: secret });
  for (const headers of [{}, { [ORIGIN_HEADER]: 'wrong' }, { [ORIGIN_HEADER]: secret.slice(1) }]) {
    expect((await app.inject({ method: 'GET', url: '/health', headers })).statusCode).toBe(404);
  }
  expect((await app.inject({ method: 'GET', url: '/health', headers: { [ORIGIN_HEADER]: secret } })).statusCode).toBe(200);
  await app.close();
});
