import { describe, expect, it } from 'vitest';
import { activeTick, IDLE_MS, TICK_MS } from './reviewTimer.ts';

describe('activeTick', () => {
  it('counts a tick only while the page is visible and the person interacted within the idle window', () => {
    expect(activeTick(100_000, 100_000 - 1_000, true)).toBe(TICK_MS);
    expect(activeTick(100_000, 100_000 - IDLE_MS, true)).toBe(0);
    expect(activeTick(100_000, 100_000 - 1_000, false)).toBe(0);
  });
});
