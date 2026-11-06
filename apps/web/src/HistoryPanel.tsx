// History (M6): the facility's decisions, newest first, with what kind of decision each was. Codes, flags and staff names
// only; opening a referral (an audited read) shows its reasons and full record. Text only, no HTML.
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, HStack, Table, Text, VisuallyHidden } from '@chakra-ui/react';
import { ApiError, listDecisions, type HistoryRow, type HistoryFilter } from './api.ts';
import { Panel, Sub } from './ui.tsx';

const OUTCOME_LABEL: Record<string, string> = { admit: 'Admit', needs_review: 'Needs Review', do_not_admit: 'Do Not Admit' };
const FILTERS: { label: string; f: HistoryFilter }[] = [
  { label: 'All decisions', f: {} }, { label: 'Admit', f: { outcome: 'admit' } }, { label: 'Do Not Admit', f: { outcome: 'do_not_admit' } }, { label: 'Overrides', f: { override: true } },
];

/** What kind of decision this was, in words: the flags a reader of the history looks for. */
export function decisionFlags(d: HistoryRow): string[] {
  return [
    ...(d.amendment ? ['Amendment'] : []),
    ...(d.hard_stop_override ? ['Hard stop overridden'] : d.override ? ['Differs from recommendation'] : []),
    ...(d.cosigned ? [`Co-signed${d.cosigned_by_name ? ` by ${d.cosigned_by_name}` : ''}`] : []),
  ];
}

export function HistoryPanel({ facility, user, onOpen }: { facility: string; user: string; onOpen: (referral: string) => void }) {
  const [filter, setFilter] = useState(0);
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const latest = useRef(0); // only the latest request may update the list
  const load = async (i: number, after?: string) => {
    setMsg(null);
    const mine = (latest.current += 1);
    try {
      const page = await listDecisions(facility, user, FILTERS[i]!.f, after);
      if (mine !== latest.current) return;
      setFilter(i);
      setRows(after ? [...(rows ?? []), ...page.decisions] : page.decisions);
      setNext(page.next);
    } catch (err) {
      if (mine !== latest.current) return;
      setRows(null);
      setMsg(err instanceof ApiError && err.code === 'forbidden' ? 'History is for Reviewers and Admins.' : err instanceof ApiError && err.code === 'not_found' ? 'Not a facility this user belongs to.' : 'Could not load the history.');
    }
  };
  const first = useRef(load);
  useEffect(() => { void first.current(0); }, []);
  return (
    <Panel id="history" action={
      <HStack gap="1" wrap="wrap">
        {FILTERS.map((x, i) => <Button key={x.label} size="xs" variant={rows !== null && filter === i ? 'solid' : 'outline'} aria-pressed={rows !== null && filter === i} onClick={() => void load(i)}>{x.label}</Button>)}
      </HStack>}>
      {msg && <Text role="status" fontSize="sm">{msg}</Text>}
      {rows && rows.length === 0 && <Sub>No decisions match.</Sub>}
      {rows && rows.length > 0 && (
        <Table.ScrollArea tabIndex={0} position="relative">
          <Table.Root size="sm">
            <Table.Header><Table.Row bg="transparent">
              <Table.ColumnHeader>Decided</Table.ColumnHeader><Table.ColumnHeader>Decision</Table.ColumnHeader><Table.ColumnHeader>Recommended</Table.ColumnHeader><Table.ColumnHeader>By</Table.ColumnHeader><Table.ColumnHeader>Criteria</Table.ColumnHeader><Table.ColumnHeader><VisuallyHidden>Open</VisuallyHidden></Table.ColumnHeader>
            </Table.Row></Table.Header>
            <Table.Body>
              {rows.map((d) => (
                <Table.Row key={d.id} bg="transparent">
                  <Table.Cell whiteSpace="nowrap">{new Date(d.decided_at).toLocaleString()}</Table.Cell>
                  <Table.Cell>
                    <Badge bg={d.decision === 'admit' ? 'admitSoft' : 'stopSoft'} color={d.decision === 'admit' ? 'admit' : 'stop'}>{OUTCOME_LABEL[d.decision]}</Badge>
                    {decisionFlags(d).length > 0 && <Text fontSize="xs" color="muted" mt="0.5">{decisionFlags(d).join(' · ')}</Text>}
                  </Table.Cell>
                  <Table.Cell>{OUTCOME_LABEL[d.recommended_outcome] ?? d.recommended_outcome}</Table.Cell>
                  <Table.Cell>{d.decided_by_name ?? 'unknown user'}</Table.Cell>
                  <Table.Cell>version {d.rule_set_version}</Table.Cell>
                  <Table.Cell textAlign="end"><Button size="xs" variant="outline" onClick={() => onOpen(d.referral_id)}>Open<VisuallyHidden> referral {d.referral_id.slice(0, 8)}</VisuallyHidden></Button></Table.Cell>
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
