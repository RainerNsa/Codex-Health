// One pass over a queue. A message is deleted only after its handler finished; one that throws comes back when its
// visibility ends, and after max_receive_count deliveries SQS moves it to the dead-letter queue. Logs carry only the error's
// name and database code, never its message: that text can quote a document.
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { failReferral, parseJob, processReferral, type Job, type Ports, type Tx } from './pipeline.ts';
import type { Send } from './adapters.ts';

const VISIBILITY_SECONDS = 900;

/** What each queue does: the processing queue runs the pipeline, and a dead letter sends the referral to a person. */
export const handlers = (tx: Tx, ports: Ports) => ({
  processing: (job: Job) => processReferral(tx, ports, job),
  deadLetter: (job: Job, sentAt: number) => failReferral(tx, ports.versions, job, sentAt),
});

export async function drain(send: Send, queueUrl: string, label: string, handle: (job: Job, sentAt: number) => Promise<unknown>, beatMs = 300_000): Promise<void> {
  const { Messages } = await send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20, MessageSystemAttributeNames: ['SentTimestamp'] }));
  for (const m of (Messages ?? []) as { Body?: string; ReceiptHandle?: string; Attributes?: { SentTimestamp?: string } }[]) {
    // a long packet keeps its message: without this it would come back mid-run, be read twice and could dead-letter
    const beat = setInterval(() => { send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: VISIBILITY_SECONDS })).catch(() => {}); }, beatMs);
    try {
      await handle(parseJob(m.Body), Number(m.Attributes?.SentTimestamp ?? Date.now()));
      await send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
    } catch (err) {
      const e = err as { name?: string; code?: string };
      console.error(JSON.stringify({ event: 'job.failed', queue: label, error: e.name ?? 'Error', code: /^[A-Z0-9_]{1,32}$/.test(e.code ?? '') ? e.code : null }));
    } finally {
      clearInterval(beat);
    }
  }
}
