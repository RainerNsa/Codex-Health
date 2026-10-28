import Fastify, { type FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';

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

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onSend', async (_request, reply) => {
    for (const [name, value] of Object.entries(HEADERS)) reply.header(name, value);
  });

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}

// Listen only when run directly (`node src/server.ts`), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env['PORT'] ?? 3000);
  await buildServer().listen({ host: '127.0.0.1', port });
  console.log(`api listening on 127.0.0.1:${port}`);
}
