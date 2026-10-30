// Document storage (SPEC §12.1): the browser PUTs to a signed, short-lived URL under quarantine/; the API then
// reads the object back, checks its size, its SHA-256 and its magic bytes, and only then copies it to
// documents/<facility>/<referral>/<sha256>. Nothing in quarantine is ever read by the pipeline.
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const UPLOAD_TTL_SECONDS = 300;
const S3_TIMEOUT_MS = 30_000;

/** What was checked: the bytes are identified by ETag (and VersionId on a versioned bucket), so only they move. */
export interface Inspected { bytes: number; sha256: string; head: Buffer; etag: string; versionId: string | undefined }
const CONTENT_TYPE = { pdf: 'application/pdf', png: 'image/png', jpeg: 'image/jpeg', tiff: 'image/tiff' } as const;

export interface Storage {
  /** A URL the browser PUTs exactly these bytes to, within the TTL, with the headers it must send unchanged. */
  presignPut(key: string, bytes: number): Promise<{ url: string; headers: Record<string, string> }>;
  /** The object's size, SHA-256 (hex), first bytes and version, or null when it is not there or too large. */
  inspect(key: string): Promise<Inspected | null>;
  /** Copy exactly the inspected version (refused if the object changed since), with its content type set from the
   *  checked file type and served as an attachment; then delete that quarantine version. */
  move(from: string, to: string, checked: Inspected, kind: keyof typeof CONTENT_TYPE): Promise<void>;
  remove(key: string, versionId?: string): Promise<void>;
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

/** kmsKeyId: the real bucket refuses any object write that does not ask for SSE-KMS (modules/storage policy), so
 *  the signed upload and the promotion copy both name the key. LocalStack runs without one. */
export function s3Storage(bucket: string, kmsKeyId?: string): Storage {
  const sse = kmsKeyId ? { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: kmsKeyId } : {};
  const sseHeaders: Record<string, string> = kmsKeyId ? { 'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': kmsKeyId } : {};
  const endpoint = process.env['AWS_ENDPOINT_URL']; // localstack only; unset in AWS
  // LocalStack locally (path-style); the real bucket in a sandbox. Presigned URLs carry no extra checksum header
  // the browser would have to reproduce: the API verifies the bytes itself on completion.
  const s3 = new S3Client({ ...(endpoint ? { endpoint, forcePathStyle: true } : {}), requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  return {
    // the encryption headers are signed and must travel as headers (not query parameters): the browser sends them
    presignPut: async (key, bytes) => ({
      url: await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentLength: bytes, ...sse }),
        { expiresIn: UPLOAD_TTL_SECONDS, unhoistableHeaders: new Set(Object.keys(sseHeaders)) }),
      headers: sseHeaders,
    }),
    async inspect(key) {
      let res;
      try {
        res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(S3_TIMEOUT_MS) });
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') return null;
        throw err;
      }
      if (!res.Body || !res.ETag || (res.ContentLength ?? 0) > MAX_DOCUMENT_BYTES) return null;
      const hash = createHash('sha256');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > MAX_DOCUMENT_BYTES) return null;
        hash.update(chunk);
        if (chunks.length === 0) chunks.push(Buffer.from(chunk.subarray(0, 16)));
      }
      return { bytes, sha256: hash.digest('hex'), head: chunks[0] ?? Buffer.alloc(0), etag: res.ETag, versionId: res.VersionId };
    },
    async move(from, to, checked, kind) {
      // the PUT URL stays valid after the check: copying "whatever is there now" would promote swapped bytes
      const source = `${bucket}/${from}${checked.versionId ? `?versionId=${encodeURIComponent(checked.versionId)}` : ''}`;
      await s3.send(new CopyObjectCommand({
        Bucket: bucket, Key: to, CopySource: source, CopySourceIfMatch: checked.etag,
        MetadataDirective: 'REPLACE', ContentType: CONTENT_TYPE[kind], ContentDisposition: 'attachment', ...sse,
      }), { abortSignal: AbortSignal.timeout(S3_TIMEOUT_MS) });
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: from, ...(checked.versionId ? { VersionId: checked.versionId } : {}) }));
    },
    async remove(key, versionId) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }));
    },
  };
}
