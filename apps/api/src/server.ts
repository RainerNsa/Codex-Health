import Fastify, { type FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { assertAuthAllowed, type AuthMode } from './auth.ts';
import { poolTx, type Tx } from './db.ts';
import { registerRoutes } from './routes.ts';

// Security headers set by hand (helmet-equivalent, no extra dependency). The API serves JSON only,
// so the CSP is the strictest possible. Cache-Control: no-store on every response: PHI must never
// land in a browser or proxy cache.
const HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export interface ServerOptions {
  /** Database access; omitted only for the /health-only test. */
  tx?: Tx;
  auth?: AuthMode;
  env?: string;
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });

  app.addHook('onSend', async (_request, reply) => {
    for (const [name, value] of Object.entries(HEADERS)) reply.header(name, value);
  });

  // Codes only: never echo the path (it can carry ids or worse) or a framework message.
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));
  app.setErrorHandler((err, _req, reply) => {
    const status = typeof (err as { statusCode?: number }).statusCode === 'number' && (err as { statusCode: number }).statusCode < 500 ? (err as { statusCode: number }).statusCode : 500;
    return reply.code(status).send({ error: status === 413 ? 'too_large' : status < 500 ? 'bad_request' : 'internal' });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  if (opts.tx) {
    assertAuthAllowed(opts.auth ?? 'local-stub', opts.env);
    registerRoutes(app, { tx: opts.tx });
  }
  return app;
}

// Listen only when run directly (`node src/server.ts`), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env['PORT'] ?? 3000);
  const url = process.env['DATABASE_URL_APP'];
  if (!url) throw new Error('missing required environment variable DATABASE_URL_APP');
  const db = poolTx(url);
  await buildServer({ tx: db.tx, auth: 'local-stub', env: process.env['CODEX_ENV'] }).listen({ host: '127.0.0.1', port });
  console.log(`api listening on 127.0.0.1:${port}`);
}
