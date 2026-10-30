// The processing queue (SPEC §12.2): ids only, never document text or facts. Called after the transaction commits, so the
// worker can never receive a job for a referral it cannot yet see as processing.
import { randomUUID } from 'node:crypto';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export type Enqueue = (facilityId: string, referralId: string) => Promise<void>;

export function sqsEnqueue(queueUrl: string): Enqueue {
  const sqs = new SQSClient({});
  return async (facilityId, referralId) => {
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ facilityId, referralId, jobId: randomUUID() }) }));
  };
}
