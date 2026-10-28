#!/bin/bash
# Runs inside the LocalStack container once it is ready (/etc/localstack/init/ready.d).
# Creates the local stand-ins for the S3 bucket and SQS queues. Local only; AWS resources come from Terraform.
set -euo pipefail

awslocal s3 mb s3://codex-health-documents-local 2>/dev/null || true

awslocal sqs create-queue --queue-name codex-healthcessing-dlq >/dev/null
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url http://localhost:4566/000000000000/codex-healthcessing-dlq \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

awslocal sqs create-queue --queue-name codex-healthcessing \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\",\"VisibilityTimeout\":\"300\"}" >/dev/null

echo "localstack: bucket codex-health-documents-local, queues codex-healthcessing -> codex-healthcessing-dlq ready"
