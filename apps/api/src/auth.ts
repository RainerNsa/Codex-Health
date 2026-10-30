// Authentication. Only the local stub exists until a Cognito sandbox is funded (F5; decision log 2026-10-29).
// shortcut: identity comes from a request header, trusted only in development, test and the synthetic-data demo;
// replace with Cognito JWT verification (signature, issuer, audience, expiry, MFA claim) before any real data or
// any deployment that is not the demo. The demo (decision log 2026-10-30) runs only behind CloudFront's password
// gate: the API then refuses every request that lacks CloudFront's origin secret (see server.ts).
export const DEV_USER_HEADER = 'x-codex-dev-user';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AuthMode = 'local-stub';

/** Refuse to construct the stub anywhere but development, test, or the demo with its origin secret set. Called
 *  once, at startup. */
export function assertAuthAllowed(mode: AuthMode, env: string | undefined, originSecret?: string): void {
  if (mode !== 'local-stub') return;
  if (env === 'development' || env === 'test') return;
  if (env === 'demo' && typeof originSecret === 'string' && originSecret.length >= 32) return;
  throw new Error(`the local auth stub is refused when CODEX_ENV is '${env ?? ''}' (only development, test, or demo with a 32+ character origin secret)`);
}

/** The caller's user id, or null when the header is absent or not a uuid. */
export function userFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers[DEV_USER_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && UUID.test(value) ? value : null;
}
