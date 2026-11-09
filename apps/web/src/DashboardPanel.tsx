// Dashboard (M6): live counts only, no fabricated stats. Referrals by status, grouped as the Referrals queue groups them,
// and the median time from a referral's creation to its original decision over the last 30 days. Text only, no charts.
import { useEffect, useState } from 'react';
import { Box, Heading, SimpleGrid, Text, chakra } from '@chakra-ui/react';
import { ApiError, getDashboard, type Dashboard, type QueueFilter } from './api.ts';
import { duration, FILTER_LABEL, STATUS_LABEL } from './QueuePanel.tsx';
import { Panel, Sub } from './ui.tsx';

// the same statuses as the API's queue filters, so a count here matches what that queue tab lists
const GROUPS: [QueueFilter, string[]][] = [
  ['open', ['draft', 'ready_for_review', 'on_hold', 'info_requested', 'escalated', 'partial_failure']],
  ['processing', ['processing']],
  ['closed', ['finalized', 'amended']],
];

/** Each queue group's total and its non-empty statuses. */
export function groupCounts(counts: Record<string, number>) {
  return GROUPS.map(([g, statuses]) => ({
    group: g, total: statuses.reduce((n, s) => n + (counts[s] ?? 0), 0),
    statuses: statuses.filter((s) => (counts[s] ?? 0) > 0).map((s) => [s, counts[s]!] as const),
  }));
}

export function DashboardPanel({ facility, user }: { facility: string; user: string }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getDashboard(facility, user).then((d) => { if (live) setData(d); }, (err: unknown) => {
      if (live) setMsg(err instanceof ApiError && err.code === 'forbidden' ? 'The dashboard is for Reviewers and Admins.' : err instanceof ApiError && err.code === 'not_found' ? 'Not a facility this user belongs to.' : 'Could not load the dashboard.');
    });
    return () => { live = false; };
  }, [facility, user]);
  const { median_minutes: median, referrals, days } = data?.decided ?? { median_minutes: null, referrals: 0, days: 30 };
  return (
    <Panel id="dashboard">
      {msg && <Text role="status" fontSize="sm">{msg}</Text>}
      {data && (
        <>
          <SimpleGrid columns={{ base: 1, md: 3 }} gap="3">
            {groupCounts(data.counts).map((g) => (
              <Box key={g.group} as="section" aria-labelledby={`dash-${g.group}`} borderWidth="1px" borderColor="line" borderRadius="l2" p="3">
                <Heading id={`dash-${g.group}`} as="h2" size="xs" color="muted" fontWeight="600">{FILTER_LABEL[g.group]}</Heading>
                <Text fontSize="2xl" fontWeight="700">{g.total}</Text>
                {g.statuses.length > 0 && (
                  <chakra.ul listStyleType="none" fontSize="xs" color="muted">
                    {g.statuses.map(([s, n]) => <li key={s}>{STATUS_LABEL[s] ?? s}: {n}</li>)}
                  </chakra.ul>
                )}
              </Box>
            ))}
          </SimpleGrid>
          <Box as="section" aria-labelledby="dash-time" mt="4">
            <Heading id="dash-time" as="h2" size="xs" color="muted" fontWeight="600">Time to decision, last {days} days</Heading>
            <Text fontSize="sm" mt="1">
              {median === null ? 'No referral has been decided in this period.'
                : `Median ${duration(median)} from a referral being created to its first decision, across ${referrals} referral${referrals === 1 ? '' : 's'}.`}
            </Text>
          </Box>
          <Sub>Counted live from this facility's records when the screen opens. Amendments are not counted as new decisions.</Sub>
        </>
      )}
    </Panel>
  );
}
