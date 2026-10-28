import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pending } from '../migrate.mjs';

test('pending: orders by name, skips applied and non-migration files', () => {
  const files = ['0002_b.sql', 'README.md', '0001_init.sql', '0003_c.sql', '0001_init.sql.bak'];
  assert.deepEqual(pending(files, ['0001_init.sql']), ['0002_b.sql', '0003_c.sql']);
  assert.deepEqual(pending(files, []), ['0001_init.sql', '0002_b.sql', '0003_c.sql']);
  assert.deepEqual(pending([], []), []);
});
