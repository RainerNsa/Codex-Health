// In-house stand-ins for Textract and Bedrock, so the whole pipeline runs on one machine with no cloud account and no AI
// endpoint (I7). Development only: localMode() refuses anything else. A local fact is a word search, not a reading: it is
// always low confidence, and it passes the pipeline's own clean() and verifyEvidence() like any model's answer.
// shortcut: keyword search finds only tri_state facts named by their key and misses meaning, replace with Bedrock on a real server.
import { spawn } from 'node:child_process';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { pageImageKey } from '@codex-health/shared';
import type { Send } from './adapters.ts';
import type { DocumentRef, Extracted, Page, Ports } from './pipeline.ts';
import { jailed } from './render.ts';
import { normalise } from './verify.ts';

export const LOCAL_VERSIONS = { model_id: 'none', prompt_version: 'none', extractor_version: 'local-keywords-1', ocr_engine_version: 'tesseract-5.3.0' };

const OCR_TIMEOUT_MS = 120_000;
const MIN_WORDS = 3; // verifyQuote's floor: a shorter line could never verify
const MAX_OCR_BYTES = 16 * 1024 * 1024;
// "isn't" reaches here as "isn t". Stricter than verify.ts: this one chooses the value, so it must also catch what ends a treatment.
const NEGATION = /\b(no|not|none|never|without|denies|denied|negative|absent|free|weaned|discontinued|\w+n t)\b/;
const VAGUE = new Set(['use', 'used', 'status', 'history', 'current', 'recent', 'daily', 'required', 'needs', 'has', 'any', 'present']);

/** True only when asked for, in development, against LocalStack: a stand-in must never read a document anywhere else, so a
 *  server that kept this flag stops at startup rather than quietly losing Textract and Bedrock. */
export function localMode(env: Record<string, string | undefined>): boolean {
  if (env['LOCAL_PIPELINE'] === undefined) return false;
  const endpoint = env['AWS_ENDPOINT_URL'] ?? ''; // must be LocalStack on 127.0.0.1
  if (env['LOCAL_PIPELINE'] !== '1' || env['CODEX_ENV'] !== 'development' || !/^http:\/\/127\.0\.0\.1:4566$/.test(endpoint)) {
    throw new Error('LOCAL_PIPELINE is refused outside CODEX_ENV=development on LocalStack');
  }
  return true;
}

// --psm 1 finds the page's orientation: faxes arrive sideways and upside down.
function tesseract(png: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const [file, args] = jailed(['/usr/bin/tesseract', 'stdin', 'stdout', '--psm', '1']);
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'], env: { OMP_THREAD_LIMIT: '1' }, timeout: OCR_TIMEOUT_MS, killSignal: 'SIGKILL' });
    const out: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_OCR_BYTES) child.kill('SIGKILL');
      else out.push(d);
    });
    child.stdin.on('error', () => {}); // a child that died early is reported by its exit code
    child.on('error', () => reject(new Error('ocr could not start')));
    child.on('close', (code) => (code === 0 && size <= MAX_OCR_BYTES ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error('ocr did not succeed'))));
    child.stdin.end(png);
  });
}

/** Reads the page images the renderer stored, never the sender's file. A document with no images (a TIFF) has no text. */
export function tesseractOcr(send: Send, bucket: string, read = tesseract): Ports['ocr'] {
  return async (doc: DocumentRef): Promise<Page[]> => {
    const pages: Page[] = [];
    for (let page = 1; ; page++) {
      let png: Uint8Array;
      try {
        const r = await send(new GetObjectCommand({ Bucket: bucket, Key: pageImageKey(doc.storage_key, page) }));
        png = await (r['Body'] as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') return pages;
        throw err;
      }
      pages.push({ page, text: await read(png) });
    }
  };
}

/** One entry for each page line that names every telling word of a key: "no" when that line negates, otherwise "yes". */
export const localExtract: Ports['extract'] = async (documents, keys, types) => {
  const found: Extracted[] = [];
  for (const key of keys) {
    if ((types.get(key) ?? 'tri_state') !== 'tri_state') continue;
    const words = key.split('_').filter((w) => w.length > 2 && !VAGUE.has(w));
    if (!words.length) continue;
    for (const { document_id, pages } of documents) {
      for (const { page, text } of pages) {
        for (const line of text.split('\n')) {
          // a negation counts only in the clause naming the key: "No fever, remains on ventilator" is a yes
          const clause = line.split(/[,;.]/).map((c) => ` ${normalise(c)} `).find((c) => words.every((w) => c.includes(` ${w} `)));
          if (!clause || normalise(line).split(' ').length < MIN_WORDS) continue;
          found.push({ key, value: { type: 'tri_state', value: NEGATION.test(clause) ? 'no' : 'yes' }, document_id, page, quote: line.trim(), confidence_band: 'low' });
        }
      }
    }
  }
  return found;
};
