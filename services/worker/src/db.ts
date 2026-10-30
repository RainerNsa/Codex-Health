// One transaction per stage, as codex_worker, under row-level security. The pipeline binds the facility inside each one.
import pg from 'pg';
import type { Tx } from './pipeline.ts';

export function poolTx(connectionString: string): Tx {
  const pool = new pg.Pool({ connectionString, max: 2 });
  return async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(((sql, params) => client.query(sql, params)) as Parameters<typeof fn>[0]);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
}
