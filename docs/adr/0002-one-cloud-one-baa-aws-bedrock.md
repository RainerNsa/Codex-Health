# ADR-0002: One cloud, one BAA: AWS with Bedrock; Supabase only as a conditioned fallback

## Status
Accepted (master plan decision 5 resolved "AWS as default"; stack confirmed for M0 per the DevOps brief). The technical founder owns any reversal.

## Date
2026-10-22

## Context
Codex Health handles protected health information as a business associate. Every vendor that touches a packet must be under a BAA with zero retention and no training on our data. The prototypes showed the failure mode: a browser-held OpenAI key, raw packet text written to Supabase tables without RLS, and an unauthenticated edge function. The compliance review notes that "one BAA" is only true if every subprocessor sits inside the same agreement and the account is restricted to HIPAA-eligible services. The security review requires an egress allowlist, which is only enforceable when the OCR and model endpoints are inside the same network boundary as the data.

## Decision
Build on **AWS under a single AWS BAA**: RDS Postgres with row-level security, S3 (private, block-public-access, KMS), SQS with a dead-letter queue, Textract for OCR, **Claude on Amazon Bedrock with a pinned model id** for extraction, Cognito with MFA for all roles, Secrets Manager, and Terraform for dev and test environments (production deferred to M7). Account guardrails in Terraform: an Organizations SCP restricting the account to HIPAA-eligible services, the AI services opt-out policy, Bedrock pinned to US regions with invocation logging off, VPC endpoints and an egress allowlist for S3, Bedrock and Textract only, no patient data in Cognito templates, budgets alarms, and a subprocessor register maintained in the repo.

The production AI endpoint is Bedrock only; CI fails if any product code points elsewhere (CONSTRAINTS.md §3, `bedrock-only.mjs`).

**Supabase is a fallback, not a parallel option,** usable only if all of the following hold: a signed Supabase BAA; a separate BAA-covered LLM and OCR vendor; RLS forced on every tenant table; **never the anon-key / unauthenticated edge-function pattern** of the prototypes; and a fresh threat model and egress design before any PHI. Switching is a founder decision recorded in a superseding ADR.

## Alternatives considered

### Supabase on a BAA plan as the primary
Faster to stand up; less control over egress, network boundaries and worker tenancy; needs separate LLM and OCR BAAs; the prototype pattern lives there. Kept as the conditioned fallback.

### Any managed Postgres plus a direct Anthropic or OpenAI API under their BAAs
Two or three BAAs instead of one, no shared network boundary with the data, and the egress allowlist becomes a policy rather than a control. Rejected.

### Azure or GCP equivalents
Comparable HIPAA eligibility; no team familiarity advantage, and Bedrock's pinned Claude ids with invocation logging controls are what the plan already specifies. Not pursued.

## Consequences
- The technical founder requests the AWS BAA and the Bedrock pricing and retention terms in writing during the M0 cost spike.
- Local development cannot reach Textract or Bedrock; developers work on synthetic fixtures and the engine, and the rule CI never calls either service.
- A Supabase fallback would re-open the threat model and the subprocessor register; it is not a drop-in swap.
- Invariant I7 in CONSTRAINTS.md follows from this decision.
