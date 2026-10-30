import { describe, expect, it } from 'vitest';
import { activeTick, IDLE_MS, reviewSession, TICK_MS } from './reviewTimer.ts';

describe('review time', () => {
  it('counts a tick only while the page is visible and the person interacted within the idle window', () => {
    expect(activeTick(100_000, 100_000 - 1_000, true)).toBe(TICK_MS);
    expect(activeTick(100_000, 100_000 - IDLE_MS, true)).toBe(0);
    expect(activeTick(100_000, 100_000 - 1_000, false)).toBe(0);
  });

  it('a session reports its active time once, including the part of the last tick, and nothing twice', () => {
    const sent: number[] = [];
    const s = reviewSession((ms) => sent.push(ms), 0);
    s.tick(5_000, true);          // active
    s.tick(10_000, false);        // hidden: not counted
    s.input(10_000);
    s.tick(15_000, true);         // active again
    s.tick(80_000, true);         // 65 s with no input since 10 s: idle, not counted
    s.input(80_000);
    s.flush(82_500, true);        // the partial tick before leaving counts
    s.flush(82_500, true);        // the second leave of the same moment (pagehide, then unmount) sends nothing more
    expect(sent).toEqual([12_500]);
  });

  it('sends nothing for under a second, and nothing after an idle stretch', () => {
    const sent: number[] = [];
    const s = reviewSession((ms) => sent.push(ms), 0);
    s.flush(400, true);
    s.tick(5_000 + IDLE_MS, true);
    s.flush(6_000 + IDLE_MS, true);
    expect(sent).toEqual([]);
  });
});
