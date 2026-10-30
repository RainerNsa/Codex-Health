// The referral queue (M3 slice 6): a facility's referrals by status, longest waiting first. Codes and counts only;
// opening a referral is a separate, audited read. Text only, no HTML.
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, HStack, Table, Text, VisuallyHidden } from '@chakra-ui/react';
import { ApiError, listReferrals, type QueueFilter, type QueueRow } from './api.ts';
import { Panel, Sub, type Tone } from './ui.tsx';

/** How long something has waited, at the coarse grain a queue needs. */
export function age(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 1440)} days`;
}

const FILTER_LABEL: Record<QueueFilter, string> = { open: 'Needs staff', processing: 'Processing', closed: 'Decided' };
const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', processing: 'Processing', partial_failure: 'Document failed', ready_for_review: 'Ready for review', on_hold: 'On hold',
  info_requested: 'Information requested', escalated: 'Escalated', finalized: 'Finalized', amended: 'Amended',
};
const STATUS_TONE: Partial<Record<string, Tone>> = { partial_failure: 'stop', on_hold: 'review', info_requested: 'review', escalated: 'review', ready_for_review: 'info', processing: 'info' };
const EMPTY: Record<QueueFilter, string> = { open: 'Nothing needs staff right now.', processing: 'Nothing is being read right now.', closed: 'No decided referrals yet.' };

export function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONE[status];
  return tone ? <Badge bg={`${tone}Soft`} color={tone}>{STATUS_LABEL[status]}</Badge> : <Badge bg="canvas" color="ink">{STATUS_LABEL[status] ?? status}</Badge>;
}

const OUTCOME_LABEL: Record<string, string> = { admit: 'Admit', needs_review: 'Needs Review', do_not_admit: 'Do Not Admit' };
const OUTCOME_TONE: Record<string, string> = { admit: 'admit', needs_review: 'review', do_not_admit: 'stop' };

export function QueuePanel({ facility, user, onOpen }: { facility: string; user: string; onOpen: (id: string) => void }) {
  const [filter, setFilter] = useState<QueueFilter>('open');
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // only the latest request may update the list: a slow earlier answer never mixes into a newer one
  const latest = useRef(0);
  const load = async (f: QueueFilter, after?: string) => {
    setMsg(null);
    const mine = (latest.current += 1);
    try {
      const page = await listReferrals(facility, user, f, after);
      if (mine !== latest.current) return;
      setFilter(f);
      setRows(after ? [...(rows ?? []), ...page.referrals] : page.referrals);
      setNext(page.next);
    } catch (err) {
      if (mine !== latest.current) return;
      setRows(null);
      setMsg(err instanceof ApiError && err.code === 'forbidden' ? 'The queue is for Reviewers and Admins.' : err instanceof ApiError && err.code === 'not_found' ? 'Not a facility this user belongs to.' : 'Could not load the queue.');
    }
  };
  // the queue is the home screen: it opens showing what needs staff
  const first = useRef(load);
  useEffect(() => { void first.current('open'); }, []);
  return (
    <Panel id="queue" action={
      <HStack gap="1">
        {(Object.keys(FILTER_LABEL) as QueueFilter[]).map((f) => (
          <Button key={f} size="xs" variant={rows !== null && filter === f ? 'solid' : 'outline'} aria-pressed={rows !== null && filter === f} onClick={() => void load(f)}>{FILTER_LABEL[f]}</Button>
        ))}
      </HStack>}>
      {msg && <Text role="status" fontSize="sm">{msg}</Text>}
      {rows && rows.length === 0 && <Sub>{EMPTY[filter]}</Sub>}
      {rows && rows.length > 0 && (
        <Table.ScrollArea tabIndex={0} position="relative">
          <Table.Root size="sm">
            <Table.Header><Table.Row bg="transparent">
              <Table.ColumnHeader>Status</Table.ColumnHeader><Table.ColumnHeader>Recommendation</Table.ColumnHeader><Table.ColumnHeader>Documents</Table.ColumnHeader><Table.ColumnHeader>{filter === 'closed' ? 'Last change' : 'Waiting'}</Table.ColumnHeader><Table.ColumnHeader><VisuallyHidden>Open</VisuallyHidden></Table.ColumnHeader>
            </Table.Row></Table.Header>
            <Table.Body>
              {rows.map((r) => (
                <Table.Row key={r.id} bg="transparent">
                  <Table.Cell><StatusPill status={r.status} />{r.cosign_waiting ? ' · waiting for co-sign' : ''}</Table.Cell>
                  <Table.Cell>{r.outcome ? <Badge bg={`${OUTCOME_TONE[r.outcome]}Soft`} color={OUTCOME_TONE[r.outcome]}>{OUTCOME_LABEL[r.outcome]}{r.raw ? ', preliminary' : ''}</Badge> : <Text as="span" color="muted">No facts yet</Text>}</Table.Cell>
                  <Table.Cell>{r.documents}{r.failed_documents ? ` (${r.failed_documents} failed)` : ''}</Table.Cell>
                  <Table.Cell whiteSpace="nowrap" title={new Date(r.updated_at).toLocaleString()}>{filter === 'closed' ? new Date(r.updated_at).toLocaleString() : age(r.updated_at)}</Table.Cell>
                  <Table.Cell textAlign="end"><Button size="xs" variant="outline" onClick={() => onOpen(r.id)}>Open</Button></Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      )}
      {next && <Button mt="2" size="xs" variant="outline" onClick={() => void load(filter, next)}>Load more</Button>}
    </Panel>
  );
}
