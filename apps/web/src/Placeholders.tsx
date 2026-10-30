// Navigable placeholders (dev-alignment 3.1): screens the product will have, shown now so the shape of the app is
// clear, holding no data until their milestone. Each says what it will hold and what to use until then.
import { Box, Heading, Text, chakra } from '@chakra-ui/react';
import { ChartBarIcon, ClockCounterClockwiseIcon, ListChecksIcon, ShieldCheckIcon, SlidersHorizontalIcon, TrayIcon, UsersThreeIcon, type Icon } from '@phosphor-icons/react';

export type Screen = 'referrals' | 'settings' | 'dashboard' | 'history' | 'audit' | 'criteria' | 'users';

export const SCREENS: { id: Screen; label: string; icon: Icon }[] = [
  { id: 'referrals', label: 'Referrals', icon: TrayIcon },
  { id: 'dashboard', label: 'Dashboard', icon: ChartBarIcon },
  { id: 'history', label: 'History', icon: ClockCounterClockwiseIcon },
  { id: 'audit', label: 'Audit trail', icon: ShieldCheckIcon },
  { id: 'criteria', label: 'Criteria versions', icon: ListChecksIcon },
  { id: 'settings', label: 'Facility settings', icon: SlidersHorizontalIcon },
  { id: 'users', label: 'Users', icon: UsersThreeIcon },
];

const PLACEHOLDER: Partial<Record<Screen, { holds: string; meanwhile: string }>> = {
  dashboard: {
    holds: 'Referral counts by status and time from receipt to decision for this facility, built from the events recorded today.',
    meanwhile: 'The Referrals screen lists what needs staff, what is processing and what is decided.',
  },
  history: {
    holds: 'Every decided referral with its decisions, co-signs and amendments, searchable by date and outcome.',
    meanwhile: 'The Decided view on the Referrals screen lists decided referrals; opening one shows its full decision history.',
  },
  audit: {
    holds: "The facility's audit log, with its hash-chain check and the daily anchors, for Admins.",
    meanwhile: 'The audit log is already written for every read and change; this screen only makes it browsable.',
  },
  criteria: {
    holds: "The organisation's rule set versions, what changed between them, and which version each decision used.",
    meanwhile: 'Facility settings shows the rule set version in force; every recommendation records the version it used.',
  },
  users: {
    holds: 'Inviting staff to this facility and assigning their roles, with sign-in and multi-factor authentication.',
    meanwhile: 'Roles are provisioned by the platform; the local build uses fixed synthetic users.',
  },
};

export function Nav({ screen, onSelect }: { screen: Screen; onSelect: (s: Screen) => void }) {
  return (
    <Box as="nav" aria-label="Screens" display="grid" gap="0.5">
      {SCREENS.map((s) => (
        <chakra.button key={s.id} type="button" aria-current={screen === s.id ? 'page' : undefined} onClick={() => onSelect(s.id)}
          display="flex" alignItems="center" gap="2.5" px="2.5" py="1.5" borderRadius="l2" fontSize="sm" textAlign="left" cursor="pointer" whiteSpace="nowrap"
          fontWeight={screen === s.id ? '600' : '400'} bg={screen === s.id ? 'whiteAlpha.200' : 'transparent'} opacity={screen === s.id ? 1 : 0.85} _hover={{ bg: 'whiteAlpha.100', opacity: 1 }}>
          <s.icon size={18} weight={screen === s.id ? 'bold' : 'regular'} aria-hidden="true" />
          {s.label}{PLACEHOLDER[s.id] ? <chakra.span srOnly> (coming at M6)</chakra.span> : null}
        </chakra.button>
      ))}
    </Box>
  );
}

export function Placeholder({ screen }: { screen: Screen }) {
  const p = PLACEHOLDER[screen];
  if (!p) return null;
  const label = SCREENS.find((s) => s.id === screen)?.label ?? screen;
  return (
    <Box as="section" aria-labelledby="placeholder" bg="surface" borderWidth="1px" borderStyle="dashed" borderColor="line" borderRadius="l2" p="6" maxW="44rem">
      <Heading id="placeholder" as="h2" size="md">{label}</Heading>
      <Text mt="1" fontSize="xs" textTransform="uppercase" letterSpacing="0.06em" color="muted">Arrives at M6. No data on this screen yet.</Text>
      <Text mt="3" fontSize="sm">It will hold: {p.holds}</Text>
      <Text mt="2" fontSize="sm" color="muted">Until then: {p.meanwhile}</Text>
    </Box>
  );
}

/** Whether a screen is a placeholder (for tests and the nav). */
export const isPlaceholder = (s: Screen) => PLACEHOLDER[s] !== undefined;
