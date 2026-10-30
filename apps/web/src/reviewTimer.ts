// Active review time on a referral (dev-alignment 3.3): time counts only while the page is visible and the person
// has interacted in the last minute; reported once when they leave the referral, switch user or facility, hide
// the tab or close the page. A pilot measurement, never a control.
import { useEffect } from 'react';
import { sendReviewTime } from './api.ts';

export const TICK_MS = 5_000;
export const IDLE_MS = 60_000;

/** How much of an interval counts as active review. */
export const activeTick = (now: number, lastInput: number, visible: boolean, span = TICK_MS) => (visible && now - lastInput < IDLE_MS ? span : 0);

/** One person's time on one referral: ticks add active time; flush reports it once and starts over. */
export function reviewSession(send: (activeMs: number) => void, now = Date.now()) {
  let active = 0;
  let lastInput = now;
  let lastTick = now;
  return {
    input(at: number) { lastInput = at; },
    tick(at: number, visible: boolean) { active += activeTick(at, lastInput, visible, Math.min(at - lastTick, TICK_MS)); lastTick = at; },
    /** Report what has accumulated, including the part of the current tick, then reset. */
    flush(at: number, visible: boolean) {
      this.tick(at, visible);
      if (active >= 1000) send(Math.round(active));
      active = 0;
    },
  };
}

export function useReviewTimer(facility: string, user: string, referralId: string | null) {
  useEffect(() => {
    if (!referralId) return undefined;
    // facility, user and referral are fixed for this session: a switch ends it and reports under the old values
    const session = reviewSession((ms) => void sendReviewTime(facility, referralId, user, ms));
    const visible = () => document.visibilityState === 'visible';
    const input = () => session.input(Date.now());
    const kinds = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const k of kinds) window.addEventListener(k, input, { passive: true, capture: true });
    const timer = window.setInterval(() => session.tick(Date.now(), visible()), TICK_MS);
    // a hidden tab may never come back (mobile browsers kill it without pagehide): report on hide
    const onHide = () => { if (!visible()) session.flush(Date.now(), true); };
    const onLeave = () => session.flush(Date.now(), visible());
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onLeave);
    return () => {
      window.clearInterval(timer);
      for (const k of kinds) window.removeEventListener(k, input, { capture: true });
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onLeave);
      onLeave();
    };
  }, [facility, user, referralId]);
}
