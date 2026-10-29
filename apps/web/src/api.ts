// The browser's only data path: JSON over /api. The identity header is the local auth stub (development only);
// it is replaced by a Cognito session when a sandbox exists.
export type Tri = 'yes' | 'no' | 'unknown';
export interface FactKey { key: string; critical: boolean; read_by: string[] }
export interface FactRow { id: string; key: string; value: { type: string; value: unknown }; source: 'ai' | 'user'; note: string | null; as_of_date: string | null }
export interface TraceEntry { rule_id: string; kind: string; result: Tri; inputs: { key: string; presence: Tri; value?: string | number }[] }
export interface Evaluation {
  id: string;
  outcome: 'admit' | 'needs_review' | 'do_not_admit';
  clinical_outcome: string;
  financial_status: string;
  sub_reasons: string[];
  trace: { resolution_step: string; trace: TraceEntry[]; missing: string[]; conflicts: string[]; blocking: string[]; empty_profile_keys: string[] };
}
export interface ReferralView {
  referral: { id: string; status: string };
  facts: FactRow[];
  form: { fact_keys: FactKey[]; note_max: number };
  evaluation: Evaluation | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

async function call<T>(path: string, user: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', 'x-codex-dev-user': user, ...(init.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? 'error');
  return body as T;
}

export const createReferral = (facility: string, user: string) =>
  call<ReferralView>(`/api/facilities/${facility}/referrals`, user, { method: 'POST', body: '{}' });
export const getReferral = (facility: string, referral: string, user: string) =>
  call<ReferralView>(`/api/facilities/${facility}/referrals/${referral}`, user);
export const enterFact = (facility: string, referral: string, user: string, fact: { key: string; value: { type: 'tri_state'; value: Tri }; note: string; as_of_date: string | null }) =>
  call<ReferralView>(`/api/facilities/${facility}/referrals/${referral}/facts`, user, { method: 'POST', body: JSON.stringify(fact) });
