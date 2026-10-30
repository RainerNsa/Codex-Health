#!/bin/bash
# Runs inside the LocalStack container once it is ready (/etc/localstack/init/ready.d).
# Creates the local stand-ins for the S3 bucket and SQS queues. Local only; AWS resources come from Terraform.
set -euo pipefail

awslocal s3 mb s3://codex-health-documents-local 2>/dev/null || true
# The web app (Vite dev server) PUTs uploads straight to the bucket with a signed URL: allow its origin only.
awslocal s3api put-bucket-cors --bucket codex-health-documents-local --cors-configuration \
  '{"CORSRules":[{"AllowedOrigins":["http://localhost:5173","http://127.0.0.1:5173"],"AllowedMethods":["PUT"],"AllowedHeaders":["*"],"MaxAgeSeconds":300}]}'
# Anchor bucket stand-in: versioned so the verifier can read first versions. Object Lock and the deny-delete policy exist only on the real bucket.
awslocal s3 mb s3://codex-health-audit-anchor-local 2>/dev/null || true
awslocal s3api put-bucket-versioning --bucket codex-health-audit-anchor-local --versioning-configuration Status=Enabled

awslocal sqs create-queue --queue-name codex-healthcessing-dlq >/dev/null
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/codex-healthcessing-dlq \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue --queue-name codex-healthcessing \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\",\"VisibilityTimeout\":\"300\"}" >/dev/null

echo "localstack: bucket codex-health-documents-local, queues codex-healthcessing -> codex-healthcessing-dlq ready"
