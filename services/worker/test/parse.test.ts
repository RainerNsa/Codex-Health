import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJob } from '../src/pipeline.ts';

const ok = { facilityId: '00000000-0000-4000-8000-00000000f0a1', referralId: '00000000-0000-4000-8000-00000000f0a2', jobId: 'job-1' };

test('a job message is exactly three ids; anything else is refused', () => {
  assert.deepEqual(parseJob(JSON.stringify(ok)), ok);
  for (const bad of [undefined, '', 'nope', 'null', '[]', JSON.stringify({ ...ok, extra: 1 }), JSON.stringify({ ...ok, referralId: 'x' }), JSON.stringify({ ...ok, facilityId: 7 }), JSON.stringify({ ...ok, jobId: 'Bad_Job' })]) {
    assert.throws(() => parseJob(bad), /job message/);
  }
});
