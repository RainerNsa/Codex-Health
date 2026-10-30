import Fastify, { type FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { assertAuthAllowed, type AuthMode } from './auth.ts';
import { poolTx, type Tx } from './db.ts';
import { sqsEnqueue, type Enqueue } from './queue.ts';
import { registerRoutes } from './routes.ts';
import { s3Storage, type Storage } from './storage.ts';

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
  /** Document storage; without it the upload routes answer 503 storage_unavailable. */
  storage?: Storage | null;
  /** Sends a referral's job to the pipeline; without it a referral waits in processing (the local stack has no worker). */
  enqueue?: Enqueue | null;
  /** Demo only: the secret CloudFront adds to every request it forwards. Requests without it are refused, so the
   *  password gate in front of the demo cannot be bypassed by calling the server directly. */
  originSecret?: string;
}

export const ORIGIN_HEADER = 'x-codex-origin';
const sameSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });

  if (opts.originSecret) {
    const secret = opts.originSecret;
    app.addHook('onRequest', async (req, reply) => {
      const got = req.headers[ORIGIN_HEADER];
      if (typeof got !== 'string' || !sameSecret(got, secret)) return reply.code(404).send({ error: 'not_found' });
      return undefined;
    });
  }

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
    assertAuthAllowed(opts.auth ?? 'local-stub', opts.env, opts.originSecret);
    registerRoutes(app, { tx: opts.tx, storage: opts.storage ?? null, enqueue: opts.enqueue ?? null });
  }
  return app;
}

// Listen only when run directly (`node src/server.ts`), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env['PORT'] ?? 3000);
  const url = process.env['DATABASE_URL_APP'];
  if (!url) throw new Error('missing required environment variable DATABASE_URL_APP');
  const db = poolTx(url);
  const bucket = process.env['S3_DOCUMENTS_BUCKET'];
  const env = process.env['CODEX_ENV'];
  const queueUrl = process.env['SQS_PROCESSING_QUEUE_URL'];
  // the demo listens for CloudFront on the network; everything else stays on the loopback interface
  const host = env === 'demo' ? '0.0.0.0' : '127.0.0.1';
  await buildServer({ tx: db.tx, auth: 'local-stub', env, storage: bucket ? s3Storage(bucket, process.env['S3_DOCUMENTS_KMS_KEY_ID']) : null, originSecret: env === 'demo' ? process.env['DEMO_ORIGIN_SECRET'] : undefined, enqueue: queueUrl ? sqsEnqueue(queueUrl) : null }).listen({ host, port });
  console.log(`api listening on ${host}:${port}`);
}
