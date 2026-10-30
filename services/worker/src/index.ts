// The worker: reads the processing queue, and the dead-letter queue so that a job which used up its deliveries reaches a
// person. If the queue itself cannot be read, it exits and the service manager restarts it.
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { SQSClient } from '@aws-sdk/client-sqs';
import { TextractClient } from '@aws-sdk/client-textract';
import { bedrockClientConfig, requireEnv } from '@codex-health/shared';
import { bedrockExtract, textractOcr, VERSIONS, type Send } from './adapters.ts';
import { poolTx } from './db.ts';
import { drain } from './loop.ts';
import { failReferral, processReferral, type Ports } from './pipeline.ts';

const queue = requireEnv('SQS_PROCESSING_QUEUE_URL');
const deadLetters = requireEnv('SQS_PROCESSING_DLQ_URL');
const bucket = requireEnv('S3_DOCUMENTS_BUCKET');
const tx = poolTx(requireEnv('DATABASE_URL_WORKER'));
const { region, modelId } = bedrockClientConfig({ region: requireEnv('AWS_REGION'), modelId: requireEnv('BEDROCK_MODEL_ID') });

const sqs = new SQSClient({ region });
const textract = new TextractClient({ region });
const bedrock = new BedrockRuntimeClient({ region, requestHandler: { requestTimeout: 300_000 } });
const clientSend = (c: { send: (x: never) => Promise<unknown> }): Send => (cmd) => c.send(cmd as never) as Promise<Record<string, unknown>>;

const versions = { ...VERSIONS, model_id: modelId };
const ports: Ports = {
  versions,
  ocr: textractOcr(clientSend(textract), bucket),
  extract: bedrockExtract(clientSend(bedrock), modelId, (usage) => console.log(JSON.stringify({ event: 'extract.usage', usage }))),
};

const forever = async (url: string, label: string, handle: Parameters<typeof drain>[3]) => {
  for (;;) await drain(clientSend(sqs), url, label, handle);
};
console.log('worker listening');
await Promise.all([
  forever(queue, 'processing', (job) => processReferral(tx, ports, job)),
  forever(deadLetters, 'dead-letter', (job, sentAt) => failReferral(tx, versions, job, sentAt)),
]).catch((err: { name?: string }) => {
  console.error(JSON.stringify({ event: 'worker.stopped', error: err.name ?? 'Error' })); // never the message: a provider's text
  process.exit(1);
});
