// One pass over a queue. A message is deleted only after its handler finished; one that throws comes back when its
// visibility ends, and after max_receive_count deliveries SQS moves it to the dead-letter queue. Logs carry only the error's
// name and database code, never its message: that text can quote a document.
import { DeleteMessageCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { parseJob, type Job } from './pipeline.ts';
import type { Send } from './adapters.ts';

export async function drain(send: Send, queueUrl: string, label: string, handle: (job: Job) => Promise<unknown>): Promise<void> {
  const { Messages } = await send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20 }));
  for (const m of (Messages ?? []) as { Body?: string; ReceiptHandle?: string }[]) {
    try {
      await handle(parseJob(m.Body));
      await send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }));
    } catch (err) {
      const e = err as { name?: string; code?: string };
      console.error(JSON.stringify({ event: 'job.failed', queue: label, error: e.name ?? 'Error', code: e.code ?? null }));
    }
  }
}
