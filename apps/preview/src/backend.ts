// The preview's backend, in the browser: an in-memory Postgres (PGlite) built from the real role setup and migrations,
// with row-level security and the audit chain, and the real API routes (apps/api/src/routes.ts) answering the web
// app's /api requests. Every request runs as codex_app in its own transaction, as on the server. Synthetic data only;
// nothing is stored or sent anywhere, and a reload starts over. No document storage: uploads answer 503.
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import type { Query, Tx } from '../../api/src/db.ts';
import { registerRoutes } from '../../api/src/routes.ts';
import { DEMO_FACILITY, seedOrgs, seedStories } from '../../../scripts/dev/seed-core.mjs';
import profile from '../../../packages/schemas/examples/profiles/zztest-facility.json';

const MIGRATIONS = import.meta.glob<string>('../../../packages/db/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
const ROLES = Object.values(import.meta.glob<string>('../../../packages/db/sql/init/001_roles_and_database.sql', { query: '?raw', import: 'default', eager: true }))[0]!;
const RULES = Object.entries(import.meta.glob<unknown>('../../../packages/schemas/examples/rules/*.json', { import: 'default', eager: true }))
  .sort(([a], [b]) => a.localeCompare(b)).map(([, rule]) => rule);

type Reply = { status: number; body: unknown };
type Handler = (req: { params: Record<string, string>; query: Record<string, string | string[]>; headers: Record<string, string>; body: unknown }, reply: unknown) => Promise<unknown>;
const routes: { method: string; parts: string[]; handler: Handler }[] = [];

/** A JS array as a Postgres array literal, as node-pg sends it (PGlite would send "a,b"). */
export const arrayLiteral = (a: unknown[]): string =>
  `{${a.map((v) => (v === null || v === undefined ? 'NULL' : Array.isArray(v) ? arrayLiteral(v) : `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join(',')}}`;

/** node-pg's behaviour where the routes rely on it: array parameters as array literals; rowCount is the rows returned,
 *  or for a write the rows changed. */
const asQuery = (t: Transaction | PGlite): Query => (async (sql: string, params?: unknown[]) => {
  const r = await t.query(sql, params?.map((p) => (Array.isArray(p) ? arrayLiteral(p) : p)));
  return { ...r, rowCount: r.fields.length ? r.rows.length : r.affectedRows ?? 0 };
}) as unknown as Query;

/** Match a request to a registered route, Fastify style (":name" segments), and run it. */
export async function handle(method: string, url: URL, headers: Record<string, string>, body: unknown): Promise<Reply> {
  const parts = url.pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (!r.parts.every((p, i) => (p.startsWith(':') ? ((params[p.slice(1)] = decodeURIComponent(parts[i]!)), true) : p === parts[i]))) continue;
    const query: Record<string, string | string[]> = {};
    for (const [k, v] of url.searchParams) { const had = query[k]; query[k] = had === undefined ? v : [...(Array.isArray(had) ? had : [had]), v]; }
    const out: Reply = { status: 200, body: undefined };
    const reply = { code(n: number) { out.status = n; return reply; }, send(b: unknown) { out.body = b; return reply; }, header() { return reply; } };
    await r.handler({ params, query, headers, body }, reply);
    return out;
  }
  return { status: 404, body: { error: 'not_found' } };
}

export async function startBackend(): Promise<void> {
  // node-pg leaves bigint and numeric as text; the routes expect the same
  const db = await PGlite.create({ parsers: { 20: (v: string) => v, 1700: (v: string) => v } });
  // the roles exactly as the server has them; this database stands in for codex_health, owned by the migrator
  await db.exec(ROLES.split('\n').filter((line) => !/DATABASE/.test(line)).join('\n'));
  await db.exec('ALTER DATABASE postgres OWNER TO codex_migrator; SET ROLE codex_migrator');
  for (const [, sql] of Object.entries(MIGRATIONS).sort(([a], [b]) => a.localeCompare(b))) await db.exec(sql);
  await db.transaction((t) => seedOrgs(asQuery(t), RULES, profile.capabilities));
  await db.exec('RESET ROLE');

  const tx: Tx = (fn) => db.transaction(async (t) => { await t.exec('SET LOCAL ROLE codex_app'); return fn(asQuery(t)); });
  const add = (method: string) => (path: string, handler: Handler) => { routes.push({ method, parts: path.split('/').filter(Boolean), handler }); };
  const app = { get: add('GET'), post: add('POST'), put: add('PUT'), log: { error: () => {} } };
  registerRoutes(app as unknown as FastifyInstance, { tx, storage: null, enqueue: null });

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const text = await req.text();
    const { status, body } = await handle(req.method, url, Object.fromEntries(req.headers), text ? JSON.parse(text) : undefined);
    return new Response(JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json' } });
  };

  // the five demo stories, entered through the routes as the ZZTEST Reviewer, exactly as the demo server does
  await seedStories(async (user: string, method: string, path: string, body?: unknown) => {
    const r = await handle(method, new URL(`/api/facilities/${DEMO_FACILITY}${path}`, location.origin), { 'x-codex-dev-user': user }, body);
    if (r.status >= 300) throw new Error(`preview seed: ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} answered ${r.status}`);
    return r.body;
  });
}
