// Authentication. Only the local stub exists until a Cognito sandbox is funded (F5; decision log 2026-10-29).
// shortcut: identity comes from a request header, trusted only in development and test; replace with Cognito
// JWT verification (signature, issuer, audience, expiry, MFA claim) before anything is deployed anywhere.
export const DEV_USER_HEADER = 'x-codex-dev-user';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AuthMode = 'local-stub';

/** Refuse to construct the stub anywhere but development or test. Called once, at startup. */
export function assertAuthAllowed(mode: AuthMode, env: string | undefined): void {
  if (mode === 'local-stub' && env !== 'development' && env !== 'test') {
    throw new Error(`the local auth stub is refused when CODEX_ENV is '${env ?? ''}' (only development or test)`);
  }
}

/** The caller's user id, or null when the header is absent or not a uuid. */
export function userFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers[DEV_USER_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && UUID.test(value) ? value : null;
}
