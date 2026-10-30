import { describe, expect, it } from 'vitest';
import { isPlaceholder, SCREENS } from './Placeholders.tsx';

describe('screens', () => {
  it('lists every screen once; referrals and settings are real, the five M6 screens are placeholders', () => {
    expect(new Set(SCREENS.map((s) => s.id)).size).toBe(SCREENS.length);
    expect(SCREENS.filter((s) => isPlaceholder(s.id)).map((s) => s.id).sort()).toEqual(['audit', 'criteria', 'dashboard', 'history', 'users']);
  });
});
