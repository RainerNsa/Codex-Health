// Documents on a referral (M3 slice 5; SPEC §5.1 T1, T4, T5, T6): what was uploaded and where each document is.
// Files go straight to storage on a signed URL; the API checks their bytes before they count. Text only, no HTML.
import { useState } from 'react';
import type { DocumentRow, ReferralView } from './api.ts';

const STATUS_TEXT: Record<DocumentRow['status'], string> = {
  uploaded: 'Waiting to be processed', processed: 'Processed', failed: 'Failed', unreadable: 'Unreadable', not_applicable: 'Not applicable',
};
const label = (k: string) => k.replaceAll('_', ' ');

export interface DocumentHandlers {
  upload: (files: File[], type: string, replaces?: string) => Promise<boolean>;
  process: () => Promise<boolean>;
  resolve: (documents: { id: string; reason: string }[]) => Promise<boolean>;
}

export function DocumentsPanel({ view, busy, on }: { view: ReferralView; busy: boolean; on: DocumentHandlers }) {
  const [type, setType] = useState('unclassified');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const failed = view.documents.filter((d) => d.status === 'failed' || d.status === 'unreadable');
  const partial = view.referral.status === 'partial_failure';
  const canUpload = view.actions.includes('upload');
  return (
    <section aria-labelledby="docs" className="mb-6 rounded border border-gray-300 p-4">
      <h2 id="docs" className="font-semibold">Documents</h2>
      {view.documents.length === 0 && <p className="text-sm text-gray-600">No documents. Upload the referral packet, or enter facts by hand and submit for review.</p>}
      {view.documents.length > 0 && (
        <table className="mt-2 w-full text-left text-sm">
          <thead><tr><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Uploaded</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {view.documents.map((d) => (
              <tr key={d.id} className="border-t align-top">
                <td className="py-1">{label(d.type)}</td>
                <td>{STATUS_TEXT[d.status]}{d.not_applicable_reason ? ` (${d.not_applicable_reason})` : ''}{d.pages !== null ? `, ${d.pages} pages` : ''}</td>
                <td>{new Date(d.created_at).toLocaleString()}</td>
                <td>
                  {partial && (d.status === 'failed' || d.status === 'unreadable') && (
                    <>
                      <label className="block text-xs">Replace with
                        <input type="file" accept="application/pdf,image/png,image/jpeg,image/tiff" disabled={busy} className="block text-xs"
                          onChange={(e) => { const f = e.target.files?.[0]; if (f) void on.upload([f], d.type, d.id); e.target.value = ''; }} />
                      </label>
                      <label className="mt-1 block text-xs">Or mark not applicable, because
                        <input className="block w-full rounded border p-1" maxLength={500} value={reasons[d.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [d.id]: e.target.value })} />
                      </label>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {partial && failed.length > 0 && (
        <button type="button" disabled={busy || failed.some((d) => !(reasons[d.id] ?? '').trim())} className="mt-2 rounded border border-gray-900 px-3 py-1 text-sm disabled:opacity-50"
          onClick={() => void on.resolve(failed.map((d) => ({ id: d.id, reason: (reasons[d.id] ?? '').trim() }))).then((ok) => ok && setReasons({}))}>
          Mark every failed document not applicable and review
        </button>
      )}
      {canUpload && !partial && (
        <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <label>Document type
            <select className="ml-2 rounded border p-1" value={type} onChange={(e) => setType(e.target.value)}>
              {view.document_types.map((t) => <option key={t} value={t}>{label(t)}</option>)}
            </select>
          </label>
          <label>Add files (PDF or image, up to 25 MB each)
            <input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/tiff" disabled={busy} className="block"
              onChange={(e) => { const files = [...(e.target.files ?? [])]; if (files.length) void on.upload(files, type); e.target.value = ''; }} />
          </label>
        </div>
      )}
      {view.actions.includes('process') && (
        <button type="button" disabled={busy} className="mt-3 rounded bg-gray-900 px-3 py-1 text-sm text-white disabled:opacity-50" onClick={() => void on.process()}>Submit for processing</button>
      )}
      {view.referral.status === 'processing' && <p role="status" className="mt-2 text-sm">Processing: the documents are being read. The referral returns for review when they are done.</p>}
    </section>
  );
}
