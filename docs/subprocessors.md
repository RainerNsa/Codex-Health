# Subprocessor register

Every third party that may touch protected health information (PHI) on behalf
of Codex Health, with its purpose, the data it sees, and its Business Associate
Agreement (BAA) status. Required by dev-alignment 1.11 and the compliance review
("subprocessor register at M1"; gap 3: "one BAA is not one BAA"). Maintained in
the repo; changing it is a pull request reviewed by the compliance lead.

Status as of 2026-10-22: **no BAA is in force.** The AWS BAA has not yet been
accepted in AWS Artifact, no AWS account has been provisioned, and no environment
holds anything but synthetic data. Every AWS row below is "pending acceptance"
until a founder accepts the BAA and records it in `../../ops/decision-log.md`.

## Register

| Subprocessor | Purpose | Data touched | BAA status | Region |
|---|---|---|---|---|
| AWS S3 | Referral documents, page images, OCR text (short purge class); Terraform state | PHI: full packets | BAA: pending acceptance | us-east-1 (us-west-2 permitted) |
| AWS RDS (PostgreSQL) | Tenant data, extracted facts, decisions, audit log | PHI: facts, ids, decision records | BAA: pending acceptance | us-east-1 (us-west-2 permitted) |
| AWS SQS | Processing queue and dead-letter queue | Ids only by design (referral, document, facility, run); no document text | BAA: pending acceptance | us-east-1 (us-west-2 permitted) |
| AWS Textract | OCR of scanned packet pages | PHI: page images and extracted text | BAA: pending acceptance; AI services opt-out policy applied at the organization | us-east-1 (us-west-2 permitted) |
| AWS Bedrock (Anthropic Claude, pinned model id) | Fact extraction from OCR text into Yes/No/Unknown with quotes | PHI: packet text in prompts; model output | BAA: pending acceptance; invocation logging off and SCP-denied; model runs inside AWS, no data leaves the AWS BAA boundary | us-east-1 (us-west-2 permitted; US cross-region inference only) |
| AWS Cognito | Staff authentication, MFA | Staff identities (name, email) only; no patient data in any message template | BAA: pending acceptance | us-east-1 (us-west-2 permitted) |
| AWS CloudWatch (Logs, metrics) | Application and worker logs, metrics, alarms | Ids and metrics only by design; log-field allowlist, canary-PHI check in CI; no DB query logging, no Bedrock invocation logs | BAA: pending acceptance | us-east-1 (us-west-2 permitted) |
| AWS KMS, Secrets Manager, ECS/ECR, CloudTrail, Budgets, DynamoDB | Keys, the RDS master secret, compute, account audit, cost alarms, Terraform lock | Keys and metadata; no PHI content | BAA: pending acceptance (covered by the same AWS BAA) | us-east-1 (us-west-2 permitted) |
| **No other AI provider or gateway** | — | — | **Not permitted in the PHI path.** No OpenAI, Anthropic direct API, Google, OmniRoute or any proxy may receive packet content. Enforced by the org SCP allowlist, the VPC egress allowlist (S3, SQS, Bedrock, Textract, Logs, KMS endpoints only), and the CI check that the production AI client points only at Bedrock. | — |

## Not subprocessors (no PHI, by rule)

| Party | Role | Why it is not on the register |
|---|---|---|
| OmniRoute | Gateway for developers' coding agents | Developer machines only, synthetic data only, never reachable from any environment (CLAUDE.md; `docs/tooling/omniroute-dev-only.md`) |
| GitHub | Source code, CI | Code and synthetic fixtures only; CI never calls Bedrock or Textract (dev-alignment 2.9) and never holds real packets (0.11) |
| Developer workstations | Code | Synthetic data only (0.11) |

## Adding a row

1. Confirm the service is on the AWS HIPAA-eligible services list, or that the
   vendor will sign a BAA with zero retention and no training (master plan §13).
2. Add it to the SCP allowlist (`infra/terraform/modules/org-guardrails/policies/scp-hipaa-allowlist.json`)
   and, if workers must reach it, to the VPC endpoint list in `modules/network`.
   Update the expected lists in `infra/scripts/infra-checks.test.mjs` in the same PR;
   `node --test infra/scripts/` fails until the SCP, the endpoints and the test agree.
3. Add the row here with the data it will touch and the BAA status; the
   compliance lead reviews the PR.

## Open items

- Pilot facility BAA (the covered entity's BAA with us): template by M4, signed before P1 (compliance review).
- Error tracking, support tooling and any log SaaS: none chosen; each would be a row and most are not BAA-eligible. Default is CloudWatch only.
- Evaluation environment for real de-identified packets: same AWS BAA, separate account; founder decision before M5.
