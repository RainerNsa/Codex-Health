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

/** What the chain check found, in words. */
export function chainText(c: AuditPage['chain']): string {
  if (c.broken.length === 0) return `Chain intact: all ${c.checked} entries match their recorded hashes and order.`;
  return `Chain broken: ${c.broken.length === 50 ? 'at least 50' : c.broken.length} of ${c.checked} entries no longer match what was written (entries ${c.broken.join(', ')}). Report this to the platform team.`;
}

export function AuditPanel({ facility, user }: { facility: string; user: string }) {
  const [page, setPage] = useState<AuditPage | null>(null);
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
      {page && <Callout tone={page.chain.broken.length ? 'stop' : 'admit'} role={page.chain.broken.length ? 'alert' : 'status'}>{chainText(page.chain)}</Callout>}
      {page && <Sub>Every read and change is recorded here and cannot be edited or deleted. On the server deployment a daily job also copies the latest entry to locked storage, so a rewrite of the newest entries would show there; that job does not run in this test environment. Opening this screen is recorded.</Sub>}
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
                <Table.Row key={e.seq} bg="transparent" color={page.chain.broken.includes(e.seq) ? 'stop' : undefined}>
                  <Table.Cell fontFamily="mono">{e.seq}{page.chain.broken.includes(e.seq) ? ' (broken)' : ''}</Table.Cell>
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
