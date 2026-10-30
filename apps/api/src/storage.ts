// Document storage (SPEC §12.1): the browser PUTs to a signed, short-lived URL under quarantine/; the API then
// reads the object back, checks its size, its SHA-256 and its magic bytes, and only then copies it to
// documents/<facility>/<referral>/<sha256>. Nothing in quarantine is ever read by the pipeline.
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const UPLOAD_TTL_SECONDS = 300;

export interface Storage {
  /** A URL the browser PUTs exactly these bytes to, within the TTL. */
  presignPut(key: string, bytes: number): Promise<string>;
  /** The object's size, SHA-256 (hex) and first bytes, or null when it is not there or too large. */
  inspect(key: string): Promise<{ bytes: number; sha256: string; head: Buffer } | null>;
  move(from: string, to: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** PDF, PNG, JPEG or TIFF, by their first bytes: the declared type and the file name are never trusted. */
export function sniff(head: Buffer): 'pdf' | 'png' | 'jpeg' | 'tiff' | null {
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpeg';
  const t = head.subarray(0, 4).toString('latin1');
  if (t === 'II*\u0000' || t === 'MM\u0000*') return 'tiff';
  return null;
}

export function s3Storage(bucket: string): Storage {
  const endpoint = process.env['AWS_ENDPOINT_URL']; // localstack only; unset in AWS
  // LocalStack locally (path-style); the real bucket in a sandbox. Presigned URLs carry no extra checksum header
  // the browser would have to reproduce: the API verifies the bytes itself on completion.
  const s3 = new S3Client({ ...(endpoint ? { endpoint, forcePathStyle: true } : {}), requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  return {
    presignPut: (key, bytes) => getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentLength: bytes }), { expiresIn: UPLOAD_TTL_SECONDS }),
    async inspect(key) {
      let res;
      try {
        res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') return null;
        throw err;
      }
      if (!res.Body || (res.ContentLength ?? 0) > MAX_DOCUMENT_BYTES) return null;
      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > MAX_DOCUMENT_BYTES) return null;
        hash.update(chunk);
        if (chunks.length === 0) chunks.push(Buffer.from(chunk.subarray(0, 16)));
      }
      return { bytes, sha256: hash.digest('hex'), head: chunks[0] ?? Buffer.alloc(0) };
    },
    async move(from, to) {
      await s3.send(new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: `${bucket}/${from}` }));
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: from }));
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}
