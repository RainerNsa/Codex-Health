// Documents on a referral (M3 slice 5; SPEC §5.1 T1, T4, T5, T6): what was uploaded and where each document is.
// Files go straight to storage on a signed URL; the API checks their bytes before they count. Text only, no HTML.
import { useState } from 'react';
import { Box, Button, Flex, Grid, Input, Table, Text, VisuallyHidden } from '@chakra-ui/react';
import type { DocumentRow, ReferralView } from './api.ts';
import { Field, Panel, Select, Sub } from './ui.tsx';

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
    <Panel id="docs" title="Documents">
      {view.documents.length === 0 && <Sub>No documents. Upload the referral packet, or enter facts by hand and submit for review.</Sub>}
      {view.documents.length > 0 && (
        <Table.ScrollArea tabIndex={0} position="relative">
          <Table.Root size="sm">
            <Table.Header><Table.Row bg="transparent"><Table.ColumnHeader>Type</Table.ColumnHeader><Table.ColumnHeader>Status</Table.ColumnHeader><Table.ColumnHeader>Uploaded</Table.ColumnHeader><Table.ColumnHeader><VisuallyHidden>Actions</VisuallyHidden></Table.ColumnHeader></Table.Row></Table.Header>
            <Table.Body>
              {view.documents.map((d) => (
                <Table.Row key={d.id} bg="transparent" verticalAlign="top">
                  <Table.Cell>{label(d.type)}</Table.Cell>
                  <Table.Cell>{STATUS_TEXT[d.status]}{d.not_applicable_reason ? ` (${d.not_applicable_reason})` : ''}{d.pages !== null ? `, ${d.pages} pages` : ''}</Table.Cell>
                  <Table.Cell>{new Date(d.created_at).toLocaleString()}</Table.Cell>
                  <Table.Cell>
                    {partial && (d.status === 'failed' || d.status === 'unreadable') && (
                      <Grid gap="1" fontSize="xs">
                        <label>Replace with
                          <input type="file" accept="application/pdf,image/png,image/jpeg,image/tiff" disabled={busy} style={{ display: 'block' }}
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) void on.upload([f], d.type, d.id); e.target.value = ''; }} />
                        </label>
                        <Field label="Or mark not applicable, because">
                          <Input size="xs" maxLength={500} value={reasons[d.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [d.id]: e.target.value })} />
                        </Field>
                      </Grid>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      )}
      {partial && failed.length > 0 && (
        <Button mt="2" size="sm" variant="outline" disabled={busy || failed.some((d) => !(reasons[d.id] ?? '').trim())}
          onClick={() => void on.resolve(failed.map((d) => ({ id: d.id, reason: (reasons[d.id] ?? '').trim() }))).then((ok) => ok && setReasons({}))}>
          Mark every failed document not applicable and review
        </Button>
      )}
      {canUpload && !partial && (
        <Flex mt="3" wrap="wrap" align="end" gap="3" fontSize="sm">
          <Box><Field label="Document type"><Select value={type} onChange={setType}>{view.document_types.map((t) => <option key={t} value={t}>{label(t)}</option>)}</Select></Field></Box>
          <label>Add files (PDF or image, up to 25 MB each)
            <input type="file" multiple accept="application/pdf,image/png,image/jpeg,image/tiff" disabled={busy} style={{ display: 'block' }}
              onChange={(e) => { const files = [...(e.target.files ?? [])]; if (files.length) void on.upload(files, type); e.target.value = ''; }} />
          </label>
        </Flex>
      )}
      {view.actions.includes('process') && <Button mt="3" size="sm" disabled={busy} onClick={() => void on.process()}>Submit for processing</Button>}
      {view.referral.status === 'processing' && <Text role="status" mt="2" fontSize="sm">Processing: the documents are being read. The referral returns for review when they are done.</Text>}
    </Panel>
  );
}
