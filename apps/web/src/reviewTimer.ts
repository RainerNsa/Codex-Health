// Active review time on a referral (dev-alignment 3.3): five-second ticks that count only while the page is
// visible and the person has interacted in the last minute; reported once when they leave the referral, switch
// user or facility, or close the page. A pilot measurement, never a control.
import { useEffect } from 'react';
import { sendReviewTime } from './api.ts';

export const TICK_MS = 5_000;
export const IDLE_MS = 60_000;

/** How much of one tick counts as active review. */
export const activeTick = (now: number, lastInput: number, visible: boolean) => (visible && now - lastInput < IDLE_MS ? TICK_MS : 0);

export function useReviewTimer(facility: string, user: string, referralId: string | null) {
  useEffect(() => {
    if (!referralId) return undefined;
    let active = 0;
    let last = Date.now();
    const input = () => { last = Date.now(); };
    const kinds = ['pointerdown', 'keydown', 'scroll', 'pointermove'] as const;
    for (const k of kinds) window.addEventListener(k, input, { passive: true });
    const timer = window.setInterval(() => { active += activeTick(Date.now(), last, document.visibilityState === 'visible'); }, TICK_MS);
    const flush = () => {
      if (active > 0) void sendReviewTime(facility, referralId, user, active);
      active = 0;
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.clearInterval(timer);
      for (const k of kinds) window.removeEventListener(k, input);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [facility, user, referralId]);
}
