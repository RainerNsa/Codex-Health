import { describe, expect, it } from 'vitest';
import { parseSession, SEED_FACILITIES, SEED_USERS } from './SignIn.tsx';

describe('stored demo session', () => {
  const user = SEED_USERS[1]!.id;
  const facility = SEED_FACILITIES[0]!.id;

  it('keeps a seeded user and facility, and nothing else stored with them', () => {
    expect(parseSession(JSON.stringify({ user, facility, role: 'admin' }))).toEqual({ user, facility });
  });

  it('is signed out for anything missing, unknown or malformed', () => {
    for (const raw of [null, '', 'not json', 'null', '[]', JSON.stringify({ user }), JSON.stringify({ user: 'someone', facility }), JSON.stringify({ user, facility: SEED_USERS[0]!.id })]) {
      expect(parseSession(raw)).toBeNull();
    }
  });
});
