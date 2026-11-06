// Criteria versions (M6): each version of the organisation's rule set, what it changed from the one before, and how many
// of this facility's decisions were made under it. Every recommendation records the version it used. Text only, no HTML.
import { useEffect, useState } from 'react';
import { Badge, Box, Flex, Heading, Text, chakra } from '@chakra-ui/react';
import { ApiError, getCriteria, type CriteriaVersion } from './api.ts';
import { Panel, Sub } from './ui.tsx';

const KIND_LABEL: Record<string, string> = { hard_stop: 'Hard stop', review: 'Review', favorable: 'Favours admission', payer: 'Payer' };

/** What a version changed, in words, naming rules by their names in that version (a removed rule by its id). */
export function changeSummary(v: CriteriaVersion, first: boolean): string {
  if (first) return `First version: ${v.rules.length} rule${v.rules.length === 1 ? '' : 's'}.`;
  const name = (id: string) => v.rules.find((r) => r.id === id)?.name ?? id;
  const parts = [
    v.added.length ? `Added: ${v.added.map(name).join(', ')}.` : '',
    v.changed.length ? `Changed: ${v.changed.map(name).join(', ')}.` : '',
    v.removed.length ? `Removed: ${v.removed.join(', ')}.` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : 'No rule changed; the criteria document reference or order may have.';
}

export function CriteriaPanel({ facility, user }: { facility: string; user: string }) {
  const [data, setData] = useState<{ current: number | null; versions: CriteriaVersion[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getCriteria(facility, user).then((d) => { if (live) setData(d); }, (err: unknown) => {
      if (live) setMsg(err instanceof ApiError && err.code === 'forbidden' ? 'Criteria versions are for Reviewers and Admins.' : err instanceof ApiError && err.code === 'not_found' ? 'Not a facility this user belongs to.' : 'Could not load the criteria versions.');
    });
    return () => { live = false; };
  }, [facility, user]);
  return (
    <Panel id="criteria">
      {msg && <Text role="status" fontSize="sm">{msg}</Text>}
      {data && data.versions.length === 0 && <Sub>No rule set yet. An Admin sets one under Facility settings.</Sub>}
      {data && data.versions.length > 0 && (
        <chakra.ol listStyleType="none">
          {data.versions.map((v, i) => (
            <Box as="li" key={v.version} borderTopWidth={i ? '1px' : '0'} borderColor="line" py="3">
              <Flex wrap="wrap" align="center" gap="2">
                <Heading as="h2" size="sm">Version {v.version}</Heading>
                {v.version === data.current && <Badge bg="infoSoft" color="info">In force</Badge>}
                <Text fontSize="sm" color="muted" ml="auto">{new Date(v.created_at).toLocaleString()}{v.created_by_name ? ` · ${v.created_by_name}` : ''}</Text>
              </Flex>
              <Text mt="1" fontSize="sm">{changeSummary(v, i === data.versions.length - 1)}</Text>
              <Text mt="1" fontSize="sm" color="muted">Criteria document: {v.criteria_document_ref} · {v.decisions} decision{v.decisions === 1 ? '' : 's'} at this facility used it</Text>
              <chakra.details mt="1" fontSize="sm">
                <chakra.summary cursor="pointer">The {v.rules.length} rules</chakra.summary>
                <chakra.ul mt="1" pl="4">
                  {v.rules.map((r) => <li key={r.id}>{r.name} <Text as="span" color="muted">({KIND_LABEL[r.kind] ?? r.kind}{r.enabled ? '' : ', off in the rule set'})</Text></li>)}
                </chakra.ul>
              </chakra.details>
            </Box>
          ))}
        </chakra.ol>
      )}
    </Panel>
  );
}
