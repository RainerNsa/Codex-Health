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
  trace: { resolution_step: string; trace: TraceEntry[]; missing: string[]; conflicts: string[]; blocking: string[]; empty_profile_keys: string[]; confirmation_set?: string[] };
}
export type Action = 'submit' | 'process' | 'hold' | 'request_info' | 'escalate' | 'resume' | 'finalize' | 'reevaluate' | 'cosign' | 'amend' | 'upload' | 'resolve_failures';
export interface DocumentRow { id: string; type: string; status: 'uploaded' | 'processed' | 'failed' | 'unreadable' | 'not_applicable'; pages: number | null; not_applicable_reason: string | null; created_at: string }
export interface TransitionRow { transition: string; from_status: string; to_status: string; note: string | null; department: string | null; requested_items: string[]; created_by: string; created_at: string }
export interface DecisionRow { id: string; evaluation_id: string; recommended_outcome: string; decision: 'admit' | 'do_not_admit'; override_reason: string | null; decided_by: string; cosigned_by: string | null; amends_decision_id: string | null; amendment_reason: string | null; decided_at: string }
export interface ReferralView {
  referral: { id: string; status: string };
  facts: FactRow[];
  form: { fact_keys: FactKey[]; note_max: number; configured?: boolean; departments: string[] };
  evaluation: Evaluation | null;
  rule_explanations: Record<string, string | null>;
  confirmation: { key: string; confirmed: boolean; known: boolean }[];
  admit_requires: string[];
  evaluation_outdated: boolean;
  cosign: { admit: boolean; any: boolean };
  pending_request: { id: string; evaluation_id: string; decision: 'admit' | 'do_not_admit'; override_reason: string | null; requested_by: string; requested_by_name: string; created_at: string; amends_decision_id: string | null; amendment_reason: string | null; can_cosign: boolean } | null;
  transitions: TransitionRow[];
  decision: DecisionRow | null;
  decisions: DecisionRow[];
  documents: DocumentRow[];
  document_types: string[];
  actions: Action[];
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

export const reevaluateReferral = (facility: string, referral: string, user: string) =>
  call<ReferralView>(`/api/facilities/${facility}/referrals/${referral}/evaluate`, user, { method: 'POST', body: '{}' });
export type DecisionBody = { evaluation_id: string; decision: 'admit' | 'do_not_admit'; override_reason?: string; amendment_reason?: string };
export const amendReferral = (facility: string, referral: string, user: string, body: DecisionBody) =>
  call<ReferralView>(`/api/facilities/${facility}/referrals/${referral}/amendments`, user, { method: 'POST', body: JSON.stringify(body) });
export const requestCosign = (facility: string, referral: string, user: string, body: DecisionBody) =>
  call<ReferralView>(`/api/facilities/${facility}/referrals/${referral}/decision-requests`, user, { method: 'POST', body: JSON.stringify(body) });
export const cosignRequest = (facility: string, referral: string, request: string, user: string) =>
  call<ReferralView>(`/api/facilities/${facility}/referrals/${referral}/decision-requests/${request}/cosign`, user, { method: 'POST', body: '{}' });
export const moveReferral = (facility: string, referral: string, user: string, body: { action: 'submit' | 'process' | 'hold' | 'request_info' | 'escalate' | 'resume'; note?: string; department?: string; items?: string[] }) =>
  call<ReferralView>(`/api/facilities/${facility}/referrals/${referral}/transitions`, user, { method: 'POST', body: JSON.stringify(body) });
export const finalizeReferral = (facility: string, referral: string, user: string, body: { evaluation_id: string; decision: 'admit' | 'do_not_admit'; override_reason?: string }) =>
  call<ReferralView>(`/api/facilities/${facility}/referrals/${referral}/decision`, user, { method: 'POST', body: JSON.stringify(body) });

export interface Settings {
  configured: boolean;
  rule_set?: { version: number; criteria_document_ref: string; rules: { id: string; kind: string; inputs: string[]; enabled_here: boolean; enabled_in_rule_set: boolean; switchable: boolean; explanation: string | null }[] };
  profile?: { version: number; capabilities: Record<string, boolean | number>; disabled_rules: string[] };
  profile_keys?: Record<string, 'boolean' | 'count'>;
  completeness?: { required_keys: string[]; missing_keys: string[] };
}
export const getSettings = (facility: string, user: string) => call<Settings>(`/api/facilities/${facility}/settings`, user);
export const saveSettings = (facility: string, user: string, body: { capabilities: Record<string, boolean | number>; disabled_rules: string[]; based_on_version: number }) =>
  call<Settings>(`/api/facilities/${facility}/settings`, user, { method: 'PUT', body: JSON.stringify(body) });

// Upload as the API expects: hash the bytes here, get a signed URL, PUT the bytes, then ask the API to check them.
export async function uploadDocument(facility: string, referral: string, user: string, file: File, type: string, replaces?: string): Promise<ReferralView> {
  const bytes = await file.arrayBuffer();
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const base = `/api/facilities/${facility}/referrals/${referral}/documents`;
  const link = await call<{ url: string }>(`${base}/uploads`, user, { method: 'POST', body: JSON.stringify({ sha256, bytes: bytes.byteLength }) });
  const put = await fetch(link.url, { method: 'PUT', body: bytes });
  if (!put.ok) throw new ApiError(put.status, 'upload_failed');
  return call<ReferralView>(base, user, { method: 'POST', body: JSON.stringify({ sha256, type, ...(replaces ? { replaces } : {}) }) });
}
export const resolveFailures = (facility: string, referral: string, user: string, documents: { id: string; reason: string }[]) =>
  call<ReferralView>(`/api/facilities/${facility}/referrals/${referral}/documents/resolve`, user, { method: 'POST', body: JSON.stringify({ documents }) });

export interface QueueRow { id: string; status: string; referral_type: string; created_at: string; updated_at: string; outcome: Evaluation['outcome'] | null; sub_reasons: string[] | null; documents: number; failed_documents: number; cosign_waiting: boolean }
export type QueueFilter = 'open' | 'processing' | 'closed';
export const listReferrals = (facility: string, user: string, filter: QueueFilter, after?: string) =>
  call<{ filter: QueueFilter; referrals: QueueRow[]; next: string | null }>(`/api/facilities/${facility}/referrals?filter=${filter}${after ? `&after=${encodeURIComponent(after)}` : ''}`, user);
