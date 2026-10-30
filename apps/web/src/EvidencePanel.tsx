// What the AI read from the documents (M4 slice 3; SPEC §3, §5.1 T7): each fact with its words and where they are. A quote
// is hostile text from an outside sender: it is rendered as text only, and what did not verify says so in words.
import { useState } from 'react';
import { Badge, Box, Button, Flex, Text, chakra } from '@chakra-ui/react';
import { ApiError, viewDocument, type FactRow, type ReferralView } from './api.ts';
import { Panel, Sub, type Tone } from './ui.tsx';

const OPEN = new Set(['draft', 'ready_for_review', 'on_hold', 'info_requested', 'escalated']);
const label = (k: string) => k.replaceAll('_', ' ');

/** How far this reading may be relied on, in words: colour is only the second signal. */
export function trust(f: FactRow): { tone: Tone; text: string } {
  if (!f.evidence) return { tone: 'review', text: 'Documents disagree' };
  if (!f.evidence.verified) return { tone: 'stop', text: 'Quote not found on the page' };
  if (f.confidence_band === 'high' || f.confidence_band === 'medium') return { tone: 'info', text: 'Quote found on the page' };
  return { tone: 'review', text: 'Low confidence' };
}

export function EvidencePanel({ view, facility, user, busy, onConfirm }: { view: ReferralView; facility: string; user: string; busy: boolean; onConfirm: (f: FactRow) => void }) {
  const [link, setLink] = useState<{ key: string; url: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const read = view.facts.filter((f) => f.source === 'ai');
  const canConfirm = OPEN.has(view.referral.status) && view.actions.length > 0;
  const docLabel = (id: string) => label(view.documents.find((d) => d.id === id)?.type ?? 'document');
  const open = async (f: FactRow) => {
    setMsg(null);
    if (!f.evidence) return;
    try {
      const { url } = await viewDocument(facility, view.referral.id, user, f.evidence.document_id, f.key, f.evidence.page);
      setLink({ key: f.key, url: `${url}#page=${f.evidence.page}` });
    } catch (err) {
      setMsg(err instanceof ApiError && err.code === 'storage_unavailable' ? 'Document storage is not configured on this server.' : 'Could not open the document.');
    }
  };
  if (read.length === 0) return null;
  return (
    <Panel id="evidence" title="What the documents say">
      <Sub>Read by the AI. Check each one against its page: no person has confirmed these yet.</Sub>
      {msg && <Text role="status" mt="2" fontSize="sm">{msg}</Text>}
      <chakra.ul mt="2">
        {read.map((f) => {
          const t = trust(f);
          const known = f.value.value !== null && f.value.value !== 'unknown';
          return (
            <Box as="li" key={f.id} listStyleType="none" borderTopWidth="1px" borderColor="line" py="2.5">
              <Flex wrap="wrap" align="center" gap="2">
                <Text fontWeight="600" fontSize="sm">{label(f.key)}</Text>
                <Text fontSize="sm">{String(f.value.value)}</Text>
                <Badge bg={`${t.tone}Soft`} color={t.tone}>{t.text}</Badge>
                {f.single_source && <Badge bg="reviewSoft" color="review">One document only</Badge>}
              </Flex>
              {f.evidence && (
                <>
                  <chakra.blockquote mt="1" pl="3" borderLeftWidth="3px" borderColor="line" fontFamily="mono" fontSize="xs" whiteSpace="pre-wrap" overflowWrap="anywhere">{f.evidence.quote}</chakra.blockquote>
                  <Text mt="1" fontSize="xs" color="muted">{docLabel(f.evidence.document_id)}, page {f.evidence.page}</Text>
                </>
              )}
              {!f.evidence && <Text mt="1" fontSize="xs" color="muted">State this fact below, after checking the documents.</Text>}
              <Flex mt="1.5" wrap="wrap" align="center" gap="2">
                {f.evidence && <Button size="xs" variant="outline" disabled={busy} onClick={() => void open(f)}>View document</Button>}
                {link?.key === f.key && <a href={link.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline', fontSize: '0.875rem' }}>Open page {f.evidence?.page} (link lasts two minutes)</a>}
                {canConfirm && known && <Button size="xs" disabled={busy} onClick={() => onConfirm(f)}>Confirm this reading</Button>}
              </Flex>
            </Box>
          );
        })}
      </chakra.ul>
    </Panel>
  );
}
