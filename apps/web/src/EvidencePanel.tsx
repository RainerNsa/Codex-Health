// What the AI read from the documents (M4 slice 3; SPEC §3, §5.1 T7): each fact with its words and where they are. A quote
// is hostile text from an outside sender: it is rendered as text only, and what did not verify says so in words.
import { useState, type ReactNode } from 'react';
import { Badge, Box, Button, Flex, Text, chakra } from '@chakra-ui/react';
import { ApiError, viewDocument, type FactKey, type FactRow, type ReferralView } from './api.ts';
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

export function EvidencePanel({ view, facility, user, busy, onConfirm, form }: { view: ReferralView; facility: string; user: string; busy: boolean; onConfirm: (f: FactRow) => void; form: (k: FactKey) => ReactNode }) {
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);
  const [opened, setOpened] = useState<string[]>([]); // readings this person has opened: only those can be confirmed
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const canWrite = OPEN.has(view.referral.status) && view.actions.length > 0;
  const docLabel = (id: string) => label(view.documents.find((d) => d.id === id)?.type ?? 'document');
  const open = async (f: FactRow) => {
    setMsg(null);
    if (!f.evidence) return;
    try {
      const { url, expires_in } = await viewDocument(facility, view.referral.id, user, f.evidence.document_id, f.id);
      setLink({ id: f.id, url: `${url}#page=${f.evidence.page}` });
      // an expired link opens an error page, so it must not stand as having seen the document
      window.setTimeout(() => setLink((now) => (now?.id === f.id && now.url.startsWith(url) ? null : now)), expires_in * 1000);
    } catch (err) {
      setMsg(err instanceof ApiError && err.code === 'storage_unavailable' ? 'Document storage is not configured on this server.' : err instanceof ApiError && err.code === 'not_found' ? 'This document cannot be opened: it was not read successfully.' : 'Could not open the document.');
    }
  };
  const anyAi = view.facts.some((f) => f.source === 'ai');
  return (
    <Panel id="evidence" title="Facts the recommendation rests on">
      {anyAi && <Sub>What the AI read has not been confirmed by a person until it says stated by staff. Check each reading against its page.</Sub>}
      {msg && <Text role="status" mt="2" fontSize="sm">{msg}</Text>}
      <chakra.ul mt="2">
        {view.form.fact_keys.map((k) => {
          const f = view.facts.find((x) => x.key === k.key);
          const t = f?.source === 'ai' ? trust(f) : null;
          const known = f !== undefined && f.value.value !== null && f.value.value !== 'unknown';
          return (
            <Box as="li" key={k.key} listStyleType="none" borderTopWidth="1px" borderColor="line" py="2.5">
              <Flex wrap="wrap" align="center" gap="2">
                <Text fontWeight="600" fontSize="sm">{label(k.key)}</Text>
                {k.critical && <Badge size="xs" bg="infoSoft" color="info">critical</Badge>}
                <Text fontSize="sm" fontWeight="600" ml="auto">{f ? String(f.value.value) : 'not entered'}</Text>
              </Flex>
              <Flex wrap="wrap" align="center" gap="2" mt="1">
                {f && <Text fontSize="xs" color="muted">{f.source === 'ai' ? 'Read by the AI' : `Stated by staff${f.as_of_date ? `, as of ${f.as_of_date}` : ''}`}</Text>}
                {t && <Badge bg={`${t.tone}Soft`} color={t.tone}>{t.text}</Badge>}
                {f?.single_source && <Badge bg="reviewSoft" color="review">One document only</Badge>}
              </Flex>
              {f?.note && <Text mt="1" fontSize="xs">{f.note}</Text>}
              {f?.evidence && (
                <>
                  <chakra.blockquote mt="1" pl="3" borderLeftWidth="3px" borderColor="line" fontFamily="mono" fontSize="xs" whiteSpace="pre-wrap" overflowWrap="anywhere">{f.evidence.quote}</chakra.blockquote>
                  <Text mt="1" fontSize="xs" color="muted">{docLabel(f.evidence.document_id)}, page {f.evidence.page}</Text>
                </>
              )}
              <Flex mt="1.5" wrap="wrap" align="center" gap="2">
                {f?.evidence && <Button size="xs" variant="outline" disabled={busy} onClick={() => void open(f)}>View document</Button>}
                {f && link?.id === f.id && <a href={link.url} target="_blank" rel="noopener noreferrer" onClick={() => setOpened([...opened, f.id])} style={{ textDecoration: 'underline', fontSize: '0.875rem' }}>Open page {f.evidence?.page} (link lasts two minutes)</a>}
                {canWrite && f?.source === 'ai' && f.evidence && known && (opened.includes(f.id)
                  ? <Button size="xs" disabled={busy} onClick={() => onConfirm(f)}>Confirm this reading</Button>
                  : <Text fontSize="xs" color="muted">Open the page to confirm this reading.</Text>)}
                {canWrite && <Button size="xs" variant="ghost" aria-expanded={editing === k.key} onClick={() => setEditing(editing === k.key ? null : k.key)}>{f ? 'Correct' : 'Enter'}</Button>}
              </Flex>
              {editing === k.key && form(k)}
            </Box>
          );
        })}
      </chakra.ul>
    </Panel>
  );
}
