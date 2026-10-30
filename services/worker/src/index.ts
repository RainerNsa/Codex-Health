// Worker entry. The pipeline is in pipeline.ts; the queue loop and the real OCR and Bedrock adapters arrive with
// M4 slice 2 (docs/milestones/m4-plan.md).
import { requireEnv } from '@codex-health/shared';

requireEnv('QUEUE_URL');
requireEnv('AWS_REGION');
console.log('worker idle: queue loop arrives with M4 slice 2');
process.exit(0);
