// Audit trail (M6): the facility's append-only audit log for Admins, newest first, with its hash chain checked on every
// load. Ids, codes and staff names only: the log never holds patient data. Text only, no HTML.
import { useEffect, useRef, useState } from 'react';
import { Button, Table, Text, VisuallyHidden } from '@chakra-ui/react';
import { ApiError, getAudit, type AuditEntry, type AuditPage } from './api.ts';
import { Callout, Panel, Sub } from './ui.tsx';

/** Who acted, in words: a staff member by name, a system identity by what it is. */
export function actorLabel(e: AuditEntry): string {
  if (e.actor_name) return e.actor_name;
  const [kind] = e.actor.split(':');
  return kind === 'user' ? 'unknown user' : kind === 'worker' ? 'document reader' : `system (${kind})`;
}

type Chain = NonNullable<AuditPage['chain']>;
/** What the chain check found, in words, claiming no more than it shows. 50 is the API's cap on reported breaks. */
export function chainText(c: Chain): string {
  if (c.checked === 0) return 'Nothing has been recorded at this facility yet.';
  if (c.broken.length === 0) return `No inconsistencies found in ${c.checked} entries: each matches its recorded hash and follows the one before.`;
  return `Inconsistent: ${c.broken.length === 50 ? 'at least 50' : c.broken.length} of ${c.checked} entries no longer match what was written (entries ${c.broken.join(', ')}). Report this to the platform team.`;
}

export function AuditPanel({ facility, user }: { facility: string; user: string }) {
  const [page, setPage] = useState<AuditPage | null>(null);
  const [chain, setChain] = useState<Chain | null>(null); // checked on the first page of the whole log; later pages reuse it
  const [entity, setEntity] = useState<string | null>(null); // one entity's trail, or the whole log
  const [msg, setMsg] = useState<string | null>(null);
  const latest = useRef(0);
  const load = async (e: string | null, before?: string) => {
    setMsg(null);
    const mine = (latest.current += 1);
    try {
      const p = await getAudit(facility, user, e ?? undefined, before);
      if (mine !== latest.current) return;
      setEntity(e);
      if (p.chain) setChain(p.chain);
      setPage(before && page ? { ...p, entries: [...page.entries, ...p.entries] } : p);
    } catch (err) {
      if (mine !== latest.current) return;
      setPage(null);
      setMsg(err instanceof ApiError && err.code === 'forbidden' ? 'The audit trail is for Admins.' : err instanceof ApiError && err.code === 'not_found' ? 'Not a facility this user belongs to.' : 'Could not load the audit trail.');
    }
  };
  const first = useRef(load);
  useEffect(() => { void first.current(null); }, []);
  return (
    <Panel id="audit" action={entity && <Button size="xs" variant="outline" onClick={() => void load(null)}>Show the whole log</Button>}>
      {msg && <Text role="status" fontSize="sm">{msg}</Text>}
      {chain && <Callout tone={chain.broken.length ? 'stop' : 'info'} role={chain.broken.length ? 'alert' : 'status'}>{chainText(chain)}</Callout>}
      {page && <Sub>Changes, decisions and the opening and listing of referrals are recorded here. The application can only add entries, never change or remove them. The check above finds changes to earlier entries; removing or rewriting the newest ones is caught only by comparing with a daily copy kept in locked storage, which is built but not yet running anywhere. Opening this screen is recorded.</Sub>}
      {entity && <Text mt="2" fontSize="sm">Showing the trail of <Text as="span" fontFamily="mono">{entity.slice(0, 8)}</Text> only.</Text>}
      {page && page.entries.length === 0 && <Sub>No entries.</Sub>}
      {page && page.entries.length > 0 && (
        <Table.ScrollArea tabIndex={0} position="relative" mt="3">
          <Table.Root size="sm">
            <Table.Header><Table.Row bg="transparent">
              <Table.ColumnHeader>Entry</Table.ColumnHeader><Table.ColumnHeader>When</Table.ColumnHeader><Table.ColumnHeader>Who</Table.ColumnHeader><Table.ColumnHeader>What</Table.ColumnHeader><Table.ColumnHeader>On</Table.ColumnHeader>
            </Table.Row></Table.Header>
            <Table.Body>
              {page.entries.map((e) => (
                <Table.Row key={e.seq} bg="transparent" color={chain?.broken.includes(e.seq) ? 'stop' : undefined}>
                  <Table.Cell fontFamily="mono">{e.seq}{chain?.broken.includes(e.seq) ? ' (inconsistent)' : ''}</Table.Cell>
                  <Table.Cell whiteSpace="nowrap">{new Date(e.at).toLocaleString()}</Table.Cell>
                  <Table.Cell>{actorLabel(e)}</Table.Cell>
                  <Table.Cell>{e.action.replaceAll(/[._]/g, ' ')}</Table.Cell>
                  <Table.Cell>
                    {e.entity_type.replaceAll('_', ' ')}{' '}
                    {e.entity_id && (entity === e.entity_id
                      ? <Text as="span" fontFamily="mono">{e.entity_id.slice(0, 8)}</Text>
                      : <Button size="xs" variant="ghost" fontFamily="mono" onClick={() => void load(e.entity_id)}>{e.entity_id.slice(0, 8)}<VisuallyHidden>: show only this {e.entity_type.replaceAll('_', ' ')}'s trail</VisuallyHidden></Button>)}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        </Table.ScrollArea>
      )}
      {page?.next && <Button mt="2" size="xs" variant="outline" onClick={() => void load(entity, page.next ?? undefined)}>Load older entries</Button>}
    </Panel>
  );
}
