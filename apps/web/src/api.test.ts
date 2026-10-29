// The browser's data path (api.ts): headers, error mapping. fetch is stubbed; no DOM needed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createReferral, getReferral } from './api.ts';

const USER = '00000000-0000-4000-8000-0000000000e2';
const FAC = '00000000-0000-4000-8000-00000000f0a1';
const respond = (status: number, body: string) => vi.fn(async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }));

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sends the dev-user and content-type headers to the facility path', async () => {
    const fetchMock = respond(201, JSON.stringify({ referral: { id: 'r', status: 'draft' }, facts: [], form: { fact_keys: [], note_max: 500 }, evaluation: null }));
    vi.stubGlobal('fetch', fetchMock);
    await createReferral(FAC, USER);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(`/api/facilities/${FAC}/referrals`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'x-codex-dev-user': USER, 'content-type': 'application/json' });
  });
  it('throws an ApiError with the server code, and falls back to "error" for a non-JSON body', async () => {
    vi.stubGlobal('fetch', respond(403, JSON.stringify({ error: 'forbidden' })));
    await expect(getReferral(FAC, 'r', USER)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    vi.stubGlobal('fetch', respond(502, '<html>bad gateway</html>'));
    const err = await getReferral(FAC, 'r', USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, code: 'error' });
  });
});
