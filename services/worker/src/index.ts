// Worker entry. @aws-sdk/client-sqs is declared but deliberately not imported yet (M3):
// keeps rules-ci-offline and bedrock-only checks trivial while there is no pipeline.
import { requireEnv } from '@codex-health/shared';

requireEnv('QUEUE_URL');
requireEnv('AWS_REGION');
console.log('worker idle: pipeline arrives at M3');
process.exit(0);
