// The storage gate (SPEC §12.1): file signatures, and promotion of exactly the inspected bytes. The move test runs
// against LocalStack; it is skipped without it locally and required in the db-checks job.
import { beforeAll, describe, expect, it } from 'vitest';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { sniff, s3Storage } from '../src/storage.ts';

const endpoint = process.env['AWS_ENDPOINT_URL']; // localstack only
if (!endpoint && process.env['REQUIRE_DATABASE']) throw new Error('AWS_ENDPOINT_URL (localstack) must be set here: the storage tests may not be skipped in the db-checks job');

describe('sniff', () => {
  it('knows PDF, PNG, JPEG and both TIFF byte orders by their first bytes, and nothing else', () => {
    expect(sniff(Buffer.from('%PDF-1.7\n'))).toBe('pdf');
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png');
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniff(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe('tiff');
    expect(sniff(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))).toBe('tiff');
    for (const bad of [Buffer.from('%PDF'), Buffer.alloc(0), Buffer.from('<html>'), Buffer.from('MZ\x90\x00'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])]) {
      expect(sniff(bad), bad.toString('hex')).toBe(null);
    }
  });
});

describe.skipIf(!endpoint)('move', () => {
  const bucket = process.env['S3_DOCUMENTS_BUCKET'] ?? 'codex-health-documents-local';
  beforeAll(async () => {
    // CI's LocalStack starts empty, and test files may run in any order
    await new S3Client({ endpoint, forcePathStyle: true }).send(new CreateBucketCommand({ Bucket: bucket })).catch((err: { name?: string }) => {
      if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
    });
  });
  it('promotes exactly the inspected bytes: an object swapped after the check is refused', async () => {
    const st = s3Storage(bucket);
    const key = `quarantine/zz-test/move/${Date.now()}`;
    const to = `documents/zz-test/move/${Date.now()}`;
    const good = Buffer.from('%PDF-1.4 ZZTEST good');
    const url = await st.presignPut(key, good.length);
    await fetch(url, { method: 'PUT', body: good });
    const checked = await st.inspect(key);
    expect(checked && sniff(checked.head)).toBe('pdf');
    await fetch(url, { method: 'PUT', body: Buffer.from('MZ ZZTEST swapped!!!') }); // same length, still within the TTL
    await expect(st.move(key, to, checked!, 'pdf')).rejects.toMatchObject({ name: 'PreconditionFailed' });
    expect(await st.inspect(to)).toBe(null);
    await st.remove(key);
  });
});
