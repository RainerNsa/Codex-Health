# Organization-level guardrails (dev-alignment 1.11; sector-reviews/security.md §4 M1;
# compliance-privacy-legal.md gap 3b). Applied ONCE from the organization management
# account against the OU (or accounts) that hold dev/test/prod. Nothing in this module
# runs inside a workload account.
#
# Prerequisite, done by hand in the management account before the first apply:
# enable the SERVICE_CONTROL_POLICY and AISERVICES_OPT_OUT_POLICY policy types on the
# organization root (Organizations console > Policies). This module does not manage the
# aws_organizations_organization resource because that would take ownership of the
# whole organization from one Terraform root.
#
# Compute choice recorded in the allowlist: ECS (Fargate) and ECR, not Lambda.
# Pipeline workers parse hostile PDFs in a sandbox, run OCR jobs that can exceed
# Lambda's 15-minute ceiling, and must be pinned to one facility per job (1.9); a
# long-lived container with a single task role is the simpler fit, and keeping Lambda
# out of the allowlist stops it creeping in as an unreviewed side channel.
# Secrets Manager is listed because RDS stores the managed master password there;
# DynamoDB is listed only for the Terraform state lock table; CloudTrail for account
# audit; tag for resource tagging. All are HIPAA-eligible services.
# Deliberately absent until their milestone (see infra/README.md): lambda,
# elasticloadbalancing, acm, route53, cloudfront, wafv2, events, scheduler, ses, sns.

resource "aws_organizations_policy" "hipaa_allowlist" {
  name        = "codex-health-hipaa-eligible-allowlist"
  description = "Deny every service outside the HIPAA-eligible allowlist; deny Bedrock invocation logging; protect CloudTrail."
  type        = "SERVICE_CONTROL_POLICY"
  content     = file("${path.module}/policies/scp-hipaa-allowlist.json")
  tags        = var.tags
}

resource "aws_organizations_policy" "region_restriction" {
  name        = "codex-health-region-us-only"
  description = "Deny regional API calls outside us-east-1 and us-west-2 (Bedrock pinned to US regions, dev-alignment 1.11)."
  type        = "SERVICE_CONTROL_POLICY"
  content     = file("${path.module}/policies/scp-region-restriction.json")
  tags        = var.tags
}

# Without this, Textract and other AI services may use submitted content to improve
# the service (compliance-privacy-legal.md gap 3b). optOut for all services, and child
# policies may not override it.
resource "aws_organizations_policy" "ai_services_opt_out" {
  name        = "codex-health-ai-services-opt-out"
  description = "Opt every account out of AWS AI service content use for service improvement."
  type        = "AISERVICES_OPT_OUT_POLICY"
  content     = file("${path.module}/policies/ai-services-opt-out.json")
  tags        = var.tags
}

locals {
  policies = {
    hipaa_allowlist     = aws_organizations_policy.hipaa_allowlist.id
    region_restriction  = aws_organizations_policy.region_restriction.id
    ai_services_opt_out = aws_organizations_policy.ai_services_opt_out.id
  }
  attachments = {
    for pair in setproduct(keys(local.policies), var.target_ids) :
    "${pair[0]}/${pair[1]}" => { policy = local.policies[pair[0]], target = pair[1] }
  }
}

resource "aws_organizations_policy_attachment" "this" {
  for_each  = local.attachments
  policy_id = each.value.policy
  target_id = each.value.target
}
