import { expect, it } from 'vitest';
import { age } from './QueuePanel.tsx';

it('age reads at the grain a queue needs, and never goes negative', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  expect([age(ago(10_000), now), age(ago(-60_000), now), age(ago(59 * 60_000), now), age(ago(60 * 60_000), now), age(ago(47 * 3600_000), now), age(ago(49 * 3600_000), now)])
    .toEqual(['under a minute', 'under a minute', '59 min', '1 h', '47 h', '2 days']);
});
