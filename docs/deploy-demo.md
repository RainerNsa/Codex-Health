# Deploying the synthetic-data demo to AWS

The demo runs Codex Health in one AWS account for showing to investors and testers. **Synthetic data only**: it
has no business associate agreement (BAA) and never holds real patient data. It is not the production design
(`infra/terraform/envs/dev|test|prod`); see `infra/terraform/envs/demo/main.tf` for what it keeps and what it drops.

Account setup from scratch (sign-up, securing the account, the CLI) is in the founder's setup guide. This page
starts once you can run `aws sts get-caller-identity` and see your account.

## What it builds

| Part | What | Why |
| --- | --- | --- |
| One server (EC2 `t4g.small`, ARM) | Postgres 16, the API, the web build | Same stack as local development; no RDS cost |
| CloudFront | HTTPS on an `…cloudfront.net` address, a password gate, the web app and `/api/*` | No domain needed; nobody reaches the app without the password |
| Security group | Port 3000 from CloudFront's address ranges only; no SSH | The server answers only CloudFront, and the API also refuses any request without CloudFront's secret header |
| Documents bucket | The hardened storage module: KMS, versioning, quarantine expiry, browser uploads from the demo address only | Same rules as production |
| Web bucket | Private; only CloudFront reads it | |
| Budget | Email alerts at the monthly amount you set | So credits never run out silently |

Inside, the app is unchanged: row-level security, the audit chain, the co-sign rules. Sign-in is the local
stand-in (pick a ZZTEST user), allowed only because the password gate and the origin secret stand in front of it;
real sign-in (Cognito) replaces both before any real data (decision log 2026-10-30).

## Cost (estimate; check with the AWS Pricing Calculator before you apply)

| Item | Approx. per month (us-east-1) |
| --- | --- |
| EC2 `t4g.small`, always on | about $12 |
| Public IPv4 address | about $3.60 |
| 20 GB gp3 disk | about $1.60 |
| KMS key | $1 |
| S3, CloudFront, Budgets at demo volume | cents (CloudFront has a free monthly allowance; Budgets alerts are free) |
| **Idle total** | **about $18–20** |

Bedrock and Textract are paid per use (M4); a demo run costs cents. Stop the server between demos to save most of
the EC2 cost (`aws ec2 stop-instances --instance-ids <id>`); the disk and address still bill.

## Deploy

```sh
cd infra/terraform/envs/demo
cp demo.example.tfvars demo.tfvars        # then edit: commit sha, gate password, alert email
git rev-parse origin/main                 # the full sha to put in repo_ref
terraform init
terraform plan -var-file=demo.tfvars      # read it: about 30 resources, all named codex-health-demo-*
terraform apply -var-file=demo.tfvars
terraform output demo_url
```

The server builds itself after `apply` finishes: allow about 10 minutes. Watch it with Session Manager:

```sh
aws ssm start-session --target "$(terraform output -raw server_instance_id)"
sudo tail -f /var/log/cloud-init-output.log   # ends with "codex-health demo: ready"
```

Open `demo_url`, enter the gate user name (`codex` unless changed) and your password, then pick a ZZTEST user.

## Update to a newer commit

Set `repo_ref` to the new sha and `terraform apply -var-file=demo.tfvars`. The server is rebuilt from scratch, so
the demo's synthetic data starts over.

## Tear down

```sh
terraform destroy -var-file=demo.tfvars
```

The KMS key enters a 7-day deletion wait (the minimum) and costs nothing more once deleted. State and values stay
on your machine in `terraform.tfstate` and `demo.tfvars`: both hold the gate password and are gitignored.
