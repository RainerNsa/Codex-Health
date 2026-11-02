// The limit is shared: separate pools stand in for separate API processes, on real connections, so hits really commit.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { bindFacility, countHit, poolTx } from '../src/db.ts';

const owner = process.env['DATABASE_URL'];
const app = process.env['DATABASE_URL_APP'];

describe.skipIf(!owner || !app)('rate limit store', () => {
  const [one, two] = [poolTx(app!), poolTx(app!)];
  const facility = randomUUID();
  const hit = (db: typeof one, id: string, bucket: string) => db.counter(async (q) => { await bindFacility(q, id); return countHit(q, id, bucket); });
  const c = new pg.Client({ connectionString: owner });

  afterAll(async () => {
    await c.connect();
    await c.query("SELECT set_config('app.facility_id', $1, false)", [facility]);
    await c.query('DELETE FROM rate_limits WHERE facility_id = $1', [facility]);
    await c.end();
    await Promise.all([one.close(), two.close()]);
  });

  it('two processes spend one budget, exactly, under concurrency', async () => {
    const hits = await Promise.all(Array.from({ length: 40 }, (_, i) => hit(i % 2 ? one : two, facility, 'shared')));
    expect([...hits].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('a hit survives the request that spent it failing', async () => {
    await one.tx(async () => {
      await hit(one, facility, 'failed');
      throw new Error('the request failed');
    }).catch(() => {});
    expect(await hit(two, facility, 'failed')).toBe(2);
  });

  it('budgets are separate, a new minute starts again, and no facility sees another', async () => {
    expect(await hit(one, facility, 'other')).toBe(1);
    await c.connect();
    await c.query("SELECT set_config('app.facility_id', $1, false)", [facility]);
    await c.query("UPDATE rate_limits SET started_at = now() - interval '61 seconds' WHERE bucket = 'other'");
    await c.end();
    Object.assign(c, new pg.Client({ connectionString: owner }));
    expect(await hit(one, facility, 'other')).toBe(1);
    expect(await hit(one, facility, 'other')).toBe(2);
    await expect(one.counter(async (q) => { await bindFacility(q, randomUUID()); return countHit(q, facility, 'other'); })).rejects.toThrow(/row-level security/);
  });
});
