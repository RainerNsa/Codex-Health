// What the AI read from the documents (M4 slice 3; SPEC §3, §5.1 T7): each fact with its words and where they are. A quote
// is hostile text from an outside sender: it is rendered as text only, and what did not verify says so in words.
import { useState, type ReactNode } from 'react';
import { Badge, Box, Button, Flex, Text, chakra } from '@chakra-ui/react';
import { ApiError, pageImage, pageSeen, type FactKey, type FactRow, type ReferralView } from './api.ts';
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
  const [shown, setShown] = useState<{ id: string; url: string } | null>(null);
  const [turn, setTurn] = useState(0); // faxes arrive sideways and upside down
  const [opened, setOpened] = useState<string[]>([]); // readings this person has seen on the page: only those can be confirmed
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const canWrite = OPEN.has(view.referral.status) && view.actions.length > 0;
  const docLabel = (id: string) => label(view.documents.find((d) => d.id === id)?.type ?? 'document');
  const problem = (err: unknown) => (err instanceof ApiError && err.code === 'storage_unavailable' ? 'Document storage is not configured on this server.'
    : err instanceof ApiError && err.code === 'no_page_image' ? 'There is no image of this page. Check the document and state the fact with a note.'
      : 'The page could not be shown. Try again.');
  const show = async (f: FactRow) => {
    setMsg(null);
    if (!f.evidence) return;
    try {
      const { url } = await pageImage(facility, view.referral.id, user, f.evidence.document_id, f.evidence.page);
      setTurn(0);
      setShown({ id: f.id, url });
    } catch (err) { setMsg(problem(err)); }
  };
  // only an image that has really loaded counts, so a link that expired or failed never stands as having seen the page
  const loaded = async (f: FactRow) => {
    if (!f.evidence) return;
    try {
      await pageSeen(facility, view.referral.id, user, f.evidence.document_id, f.evidence.page, f.id);
      setOpened((now) => [...now, f.id]);
    } catch (err) { setShown(null); setMsg(problem(err)); } // cleared so Show loads it again and tries the record again
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
                {f?.source === 'ai' && f.single_source && <Text fontSize="xs" color="muted">Check it against the page before deciding.</Text>}
              </Flex>
              {f?.note && <Text mt="1" fontSize="xs">{f.note}</Text>}
              {f?.evidence && (
                <>
                  <chakra.blockquote mt="1" pl="3" borderLeftWidth="3px" borderColor="line" fontFamily="mono" fontSize="xs" whiteSpace="pre-wrap" overflowWrap="anywhere">{f.evidence.quote}</chakra.blockquote>
                  <Text mt="1" fontSize="xs" color="muted">{docLabel(f.evidence.document_id)}, page {f.evidence.page}</Text>
                </>
              )}
              <Flex mt="1.5" wrap="wrap" align="center" gap="2">
                {f?.evidence && <Button size="xs" variant="outline" disabled={busy} onClick={() => void show(f)}>Show page {f.evidence.page}</Button>}
                {f && shown?.id === f.id && <Button size="xs" variant="ghost" onClick={() => setTurn((turn + 90) % 360)}>Rotate page</Button>}
                {canWrite && f?.source === 'ai' && f.evidence && known && (opened.includes(f.id)
                  ? <Button size="xs" disabled={busy} onClick={() => onConfirm(f)}>Confirm this reading</Button>
                  : <Text fontSize="xs" color="muted">Show the page to confirm this reading.</Text>)}
                {canWrite && <Button size="xs" variant="ghost" aria-expanded={editing === k.key} onClick={() => setEditing(editing === k.key ? null : k.key)}>{f ? 'Correct' : 'Enter'}</Button>}
              </Flex>
              {f?.evidence && shown?.id === f.id && (
                <Box mt="2" overflow="auto" maxH="80vh" borderWidth="1px" borderColor="line">
                  <img src={shown.url} alt={`${docLabel(f.evidence.document_id)}, page ${f.evidence.page}`} onLoad={() => void loaded(f)}
                    onError={() => { setShown(null); setMsg('The page could not be shown. Try again.'); }}
                    style={{ width: '100%', transform: `rotate(${turn}deg)`, transformOrigin: 'center' }} />
                </Box>
              )}
              {editing === k.key && form(k)}
            </Box>
          );
        })}
      </chakra.ul>
    </Panel>
  );
}
