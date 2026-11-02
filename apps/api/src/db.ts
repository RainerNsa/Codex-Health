// One transaction per request, as codex_app, under row-level security (SPEC §2, I3). Every query a route makes
// goes through `tx`, which binds app.facility_id / app.organization_id with set_config(..., true) so the binding
// dies with the transaction and never leaks to the next request on a pooled connection.
import pg from 'pg';

export type Query = <R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<pg.QueryResult<R>>;
export type Tx = <T>(fn: (q: Query) => Promise<T>) => Promise<T>;

/** Production/dev: a pool connected as codex_app (DATABASE_URL_APP). */
export function poolTx(connectionString: string): { tx: Tx; counter: Tx; close: () => Promise<void> } {
  const open = (max: number) => new pg.Pool({ connectionString, max, statement_timeout: 30_000, connectionTimeoutMillis: 10_000 });
  const over = (pool: pg.Pool): Tx => async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn((sql, params) => client.query(sql, params));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  const [pool, counts] = [open(10), open(2)];
  // Its own connections: a hit must survive its request failing, and a request holding one connection must not wait on another from a full pool.
  return { tx: over(pool), counter: over(counts), close: async () => { await Promise.all([pool.end(), counts.end()]); } };
}

/** How many times this budget has been spent in the current minute, this one included. The row lock makes it exact across processes.
 *  shortcut: a fixed window, so a burst across a boundary can reach twice the limit; a sliding one if that ever matters. */
export async function countHit(q: Query, facilityId: string, bucket: string): Promise<number> {
  const { rows } = await q<{ hits: number }>(`INSERT INTO rate_limits (facility_id, bucket) VALUES ($1, $2)
    ON CONFLICT (facility_id, bucket) DO UPDATE SET
      hits = CASE WHEN rate_limits.started_at <= now() - interval '1 minute' THEN 1 ELSE rate_limits.hits + 1 END,
      started_at = CASE WHEN rate_limits.started_at <= now() - interval '1 minute' THEN now() ELSE rate_limits.started_at END
    RETURNING hits`, [facilityId, bucket]);
  return rows[0]!.hits;
}

export const bindFacility = (q: Query, facilityId: string) => q("SELECT set_config('app.facility_id', $1, true)", [facilityId]);
export const bindOrganization = (q: Query, organizationId: string) => q("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
