# infra: AWS account guardrails and environments

Terraform for the Codex Health AWS footprint: organization guardrails, and one
root module per environment (dev, test, prod). Written at M0; nothing here has
been applied, and nothing may be until the preconditions below are met.

## Nothing is applied until

1. The founders approve the AWS accounts (management, workloads OU with
   dev/test/prod, and a separate audit-anchor account) and who pays for them.
2. The AWS Business Associate Addendum is accepted in **AWS Artifact** for the
   organization. Until then the rows in `docs/subprocessors.md` read
   "BAA: pending acceptance" and no environment may hold anything but synthetic data.
3. The security lead has reviewed the plan output of each root and signed off
   in `../../ops/decision-log.md`.

Agents never apply (CLAUDE.md "Agents must never"). `terraform apply` is a
human action, done by a named person from their own workstation with their own
MFA-backed credentials. Prod stays at `enabled = false` until M7 (dev-alignment 1.12).

## Layout

```
infra/
├── README.md                  this file
├── .gitignore                 backend.hcl (filled-in backend configs) never committed
├── scripts/infra-checks.test.mjs   static checks (node:test) that run without Terraform
└── terraform/
    ├── modules/
    │   ├── org-guardrails/    SCPs + AI opt-out (management account only)
    │   ├── kms/               one CMK per environment
    │   ├── network/           private-only VPC, endpoints, egress allowlist
    │   ├── storage/           documents bucket (short purge class)
    │   ├── database/          RDS Postgres 16
    │   ├── queue/             SQS processing queue + DLQ
    │   ├── auth/              Cognito user pool, MFA required
    │   ├── budgets/           AWS Budgets alarms
    │   ├── audit-anchor/      Object Lock bucket in the separate anchor account
    │   ├── compute-roles/     ECS task roles and the per-job worker session role (roles only)
    │   ├── logs/              KMS-encrypted log groups, <= 30-day retention
    │   └── detective/         organization CloudTrail trail + GuardDuty admin (management account only)
    └── envs/
        ├── org/               applies org-guardrails and detective to the organization
        ├── dev/               synthetic data; destroyable; NAT optional
        ├── test/              synthetic data; configured like prod
        └── prod/              gated: enabled = false, zero resources until M7
```

## How to run

Terraform >= 1.9, AWS provider 5.x (pinned `~> 5.82` in each root). Each root
has `backend.hcl.example` and `<env>.example.tfvars`; copy both without the
`.example` suffix, fill them in (gitignored), then:

```sh
cd infra/terraform/envs/dev
terraform fmt -recursive ../..            # formatting; run before every commit
terraform init -backend-config=backend.hcl
terraform validate
terraform plan -var-file=dev.tfvars -out=dev.plan
# a human reviews dev.plan; a human applies
```

State backend: one S3 bucket and one DynamoDB lock table in the management
account (placeholders `<TF_STATE_BUCKET>`, `<TF_STATE_LOCK_TABLE>`), state key
`codex-health/<env>/terraform.tfstate`, `encrypt = true`. The bucket needs
versioning, block-public-access and KMS like any other; it is created by hand
once (it cannot bootstrap itself) and recorded in the decision log.

Static checks that need no Terraform or AWS access:

```sh
node --test infra/scripts/
```

They verify the SCP allowlist and region list, the AI opt-out, the empty
backend blocks, the prod gate, "no account ids or keys in the tree", KMS and
block-public-access on every bucket, the exact egress allowlist, a policy on
every VPC endpoint, the audit-anchor write-once policy and writer/verifier split, the RDS
error-logging parameters, that test and prod never set `allow_nat`,
`force_destroy` or `deletion_protection = false`, that the Cognito pool has no
SMS template, the queue sender/consumer policy, the task roles' action ceilings,
log-group retention and KMS, the KMS key policy's principals, the documents
bucket's principal deny, and the CloudTrail and GuardDuty settings.
Wiring them into `npm run check` is a `scripts/checks/` change (not owned here).

Order of first application: `envs/org` from the management account, then
`envs/dev`. `envs/test` when M1 needs it. `envs/prod` at M7. Within a root the
anchor bucket and key policies name the writer and verifier roles from
`module.compute_roles`, so Terraform creates the roles first (AWS rejects a
policy that names a missing principal). `envs/org` needs GuardDuty's delegated
admin account to exist before its first apply.

## Modules and the rule each one serves

Rule names are the automatable checks from dev-alignment 0.10, which
CONSTRAINTS.md adopts; numbering follows CONSTRAINTS.md once it is final.

| Module | What it creates | Rule served | Source |
|---|---|---|---|
| org-guardrails | SCP denying every service outside a HIPAA-eligible allowlist (ec2, rds, s3, sqs, kms, cognito-idp, bedrock, textract, cloudwatch, logs, iam, sts, ecs, ecr, secretsmanager, dynamodb, cloudtrail, budgets, tag); explicit deny on `bedrock:PutModelInvocationLoggingConfiguration` and on stopping CloudTrail; SCP restricting regional calls to us-east-1 and us-west-2; AI services opt-out policy for all services, non-overridable | production AI endpoint is Bedrock only; no unapproved AI service; Bedrock pinned to US regions with invocation logging off | 1.11; security.md §2, §4; compliance gap 3b |
| kms | One CMK per environment, yearly rotation, alias `alias/codex-health-<env>`. Explicit key policy: the account root administers, the task roles in `user_role_arns` get use-only actions, the regional logs service may use it for our log groups, and this account's principals may use it only through s3, rds, sqs and secretsmanager (`kms:ViaService`); no wildcard principal, no `kms:*` for anyone but the root | KMS on every bucket (and RDS, SQS, the DB secret, the log groups); key policies restricted to service roles | 1.11; security.md §4; SPEC §12.2 "account operator" |
| network | VPC with two private subnets, no IGW, no NAT by default (`allow_nat = false`); gateway endpoint for S3; interface endpoints for sqs, bedrock-runtime, textract, logs, kms; three security groups where workers may reach only those endpoints and the DB. Every endpoint carries a policy: S3 allows only the documents bucket and the audit-anchor bucket (`documents_bucket_arn`, `audit_anchor_bucket_arn`); bedrock-runtime allows `InvokeModel` / `InvokeModelWithResponseStream` on the pinned `bedrock_model_arns` only; the rest require `aws:PrincipalAccount` = this account, so a compromised worker cannot write to a foreign bucket or call an unpinned model | outbound hosts limited to the Terraform allowlist; the M4 egress test (4.4) reads `endpoint_services`; Bedrock pinned model id (I6, I7) | 1.11; security.md §2 "egress allowlist" |
| storage | Documents bucket: block public access, BucketOwnerEnforced, versioning, SSE-KMS, lifecycle expiry after `retention_days` (current and non-current versions), TLS-only and KMS-only bucket policy; when `principal_role_arns` is set, a Deny on every object action and on listing for any principal other than those roles and the account root | block-public-access and KMS on every bucket; short purge class; API role and worker session role are the only data principals | 1.8, 1.11; security.md §4; SPEC §12.2 "account operator" |
| database | RDS Postgres 16, CMK-encrypted, private subnets, not publicly accessible, `rds.force_ssl`, parameter group with `log_statement = none`, no duration logging, and the error path closed (`log_min_error_statement = panic`, `log_error_verbosity = terse`, `log_parameter_max_length_on_error = 0`, `log_min_messages = warning`), no log exports, no Performance Insights, RDS-managed master password in Secrets Manager, deletion protection in test/prod | no PHI in logs, including on a failing statement; canary PHI strings absent from every log sink | 1.9 (RLS itself is in `packages/db`); security.md §2 "logs are a claim" |
| queue | Processing queue + DLQ, KMS-encrypted, redrive after 3 receives, DLQ 14-day retention, redrive-allow policy. Queue policy: `SendMessage` denied to everyone but `sender_role_arns` (the API role), receive/delete/change-visibility denied to everyone but `consumer_role_arns` (the worker), TLS required; empty lists mean nobody. Second control behind the worker deriving `facility_id` from the referral row, never the message | deletion job spans DLQ messages (payloads carry ids only); forged queue messages cannot rebind a worker | 1.8; SPEC §12.2 "queue sender" |
| auth | Cognito user pool: MFA ON (TOTP), 12-char full-complexity passwords, advanced security AUDIT (Plus tier), admin-only user creation, email templates with username and code only (no SMS template); one SRP web client with 15-minute tokens. The 15-minute idle timeout itself is client-enforced at M3; token validity only bounds how long a stolen token lives | MFA for all roles; Cognito messages carry no patient data | 1.11, 1.13; decision log 2026-10-21; security.md §2 |
| budgets | Monthly cost budget per account; 80% and 100% actual, 100% forecast, to a variable email | AWS Budgets alarms | 1.11; finance review |
| audit-anchor | Bucket in the **separate** anchor account, Object Lock COMPLIANCE with a 6-year default retention, its own CMK, versioning, block public access, TLS-only. Two identities: the writer role (`writer_role_arn`) may only Put and encrypt, the verifier role (`verifier_role_arn`) may only Get/List (with versions) and decrypt; `s3:DeleteObject*` is denied for everyone; `PutObject` is denied unless `If-None-Match: *`, so keys are write-once. Key scheme `<facility_id>/<date>.json` and `organization/<organization_id>/<date>.json`; the verifier checks the **first** version per key and treats any later version as tampering | daily anchoring of audit root hashes to Object Lock in a separate account; split writer and verifier identities | 1.10; security.md §2 "hash chain"; decision log 2026-10-29 |
| compute-roles | IAM roles only (ECS task trust with `aws:SourceAccount`): `api` (send to the queue, Get/Put under `documents/*` as the signed-URL issuer), `worker` (consume the queue, Textract, `bedrock:InvokeModel*` on the pinned ARNs only, `sts:AssumeRole` on the session role, **no S3 of its own**), `worker-session` (assumable by the worker only; Get/Put under `documents/*`, narrowed per job by the session policy the worker passes to `documents/<facility_id>/*`), `anchor-writer` (Put + `kms:Encrypt`/`GenerateDataKey` on the anchor bucket and key), `anchor-verifier` (Get/GetVersion/List/ListVersions + `kms:Decrypt`). No `s3:DeleteObject*`, no `bedrock:*` beyond the two invoke actions, no `logs:*` beyond `CreateLogStream`/`PutLogEvents` on the role's own group | worker scoped to one facility prefix per job; least privilege per identity | 1.9; SPEC §12.2 "pipeline worker", "queue sender" |
| logs | Log groups `/codex-health/<env>/{api,worker,anchor}`, encrypted with the environment CMK, `retention_days` default 30 and validated <= 30 | no PHI in logs: ids only, short retention, canary-checked from M4 | SPEC §12.1; data policy 5 |
| detective | Management account: organization CloudTrail trail (multi-region, log file validation, its own CMK, management events only, no S3/Lambda data events) into a bucket with block-public-access, KMS, TLS-only and a 400-day expiry; a GuardDuty detector and the delegated-admin designation (`guardduty_admin_account_id`). Each workload root runs its own `aws_guardduty_detector` (15-minute findings; prod count-guarded). Member auto-enrolment lives in the delegated admin account and arrives with its Terraform root | break-glass and operator actions are recorded outside the workload account; the SCP already denies stopping the trail | SPEC §12.2 "account operator", "cloud and infrastructure" |

Tagging: the providers set `project`, `environment` and `managed_by` on every
resource through `default_tags`. **Facility is not a tag.** Resources are shared
across facilities; data is tenant-scoped by RLS in Postgres and by prefix plus
short-lived signed URLs in S3 (1.9, security.md §3), so the "tagged by facility"
wording in 1.11 is met in the data model, not in AWS tags.

Environment differences: dev is destroyable (`force_destroy`, no deletion
protection, 1-day backups, 7-day KMS deletion window, optional NAT); test is
prod-shaped (deletion protection, 7-day backups, no NAT); prod adds Multi-AZ
and 35-day backups and creates nothing while `enabled = false`.

## Deliberately missing, and when it arrives

| Missing | Why not now | When |
|---|---|---|
| Compute (ECS Fargate services, task definitions, ECR repositories, the ecr.api / ecr.dkr / secretsmanager endpoints) | The task roles exist (`compute-roles`, M1); the services that assume them need product images. The SCP already allowlists ecs and ecr so nothing else can creep in. | M4 thin slice |
| Public ingress: load balancer, ACM certificate, Route 53, CDN (CloudFront), WAF | No API or UI to serve. CloudFront and WAF are HIPAA-eligible but each is another subprocessor row. | M3 (first screens) for ALB + ACM; CDN/WAF when the security lead asks, before the M6 pen test |
| CI deploy (OIDC role for GitHub Actions, plan on PR, apply on approval) | CI has nowhere to deploy and the repo has no secrets gate yet (gitleaks/SAST/dependency gates land at M1). An apply pipeline before a plan reviewer exists is a way to apply by accident. | M1 for plan-on-PR; apply stays human until the security lead approves automation |
| Anchoring job, verifier, deletion job (EventBridge Scheduler + ECS task) | They are product logic over the audit table (1.10, 1.8); their roles exist (`compute-roles`). | M1 anchoring; M6 deletion drill |
| Bedrock model access / inference profile settings | Model access is enabled per account in the console (a human step); the pinned model id lives in product config. | M0 cost spike (0.8) needs it in dev |
| Evaluation environment for real de-identified packets (0.11) | A founder decision: separate account under the BAA, not reachable by OmniRoute or developer machines. | Before M5; needs the founders and counsel |
| CloudTrail metric filters and alarms (`GetSecretValue` on the master secret, `AdminCreateUser` outside provisioning), GuardDuty member auto-enrolment, Config, VPC Flow Logs | The trail and the detectors exist (`detective`, M1). Alarms need a notification target (sns is not on the SCP allowlist yet); auto-enrolment is configured from the delegated admin account, which has no Terraform root; Config and Flow Logs are cost lines the finance lead has not seen. | M1 with the security lead's threat model (alarms, enrolment); Config and Flow Logs when the finance lead has seen the line |
| Performance Insights, RDS log exports, Bedrock invocation logging | Each stores SQL text, query text or prompt text, which is PHI. Off by design, SCP-denied for Bedrock. | Only with security-lead approval and a PHI-free design |

## Open questions for the founders and the COO

- Account structure and payer: management account, workloads OU, anchor account.
- Retention days for the short purge class (`documents_retention_days`; placeholder 90, dev 30).
- Monthly budget per environment (placeholders 150 / 300 / 1000 USD) and the alert mailbox.
- Cognito Plus tier (needed for advanced security AUDIT): a per-MAU line for the finance lead; the alternative is to drop advanced security until the pilot.
- Region: us-east-1 is the default; us-west-2 is the only other permitted. Confirm Bedrock model availability for the pinned Claude model in the chosen region during the cost spike.
- Whether the evaluation environment for real de-identified packets is a fourth root here or a separate repository.
