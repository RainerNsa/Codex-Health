// One transaction per request, as codex_app, under row-level security (SPEC §2, I3). Every query a route makes
// goes through `tx`, which binds app.facility_id / app.organization_id with set_config(..., true) so the binding
// dies with the transaction and never leaks to the next request on a pooled connection.
import pg from 'pg';

export type Query = <R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<pg.QueryResult<R>>;
export type Tx = <T>(fn: (q: Query) => Promise<T>) => Promise<T>;

/** Production/dev: a pool connected as codex_app (DATABASE_URL_APP). */
export function poolTx(connectionString: string): { tx: Tx; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const tx: Tx = async (fn) => {
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
  return { tx, close: () => pool.end() };
}

export const bindFacility = (q: Query, facilityId: string) => q("SELECT set_config('app.facility_id', $1, true)", [facilityId]);
export const bindOrganization = (q: Query, organizationId: string) => q("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
