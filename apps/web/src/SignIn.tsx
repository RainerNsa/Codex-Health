// The stand-in sign-in for the test environment: choose one of the seeded synthetic users and a facility. No password and no real account; the
// API knows the caller only by the local auth stub's header. Real sign-in (Cognito, with MFA) replaces this screen.
import { useState, type FormEvent } from 'react';
import { Box, Button, Flex, Heading, Link, Text, chakra } from '@chakra-ui/react';
import { ArrowLeftIcon, SignInIcon } from '@phosphor-icons/react';
import { Logo } from './Logo.tsx';
import { Callout, Field, Select } from './ui.tsx';

// shortcut: the seeded facilities; a user's own list comes with real sign-in (M6), since listing them needs a new read policy
export const SEED_FACILITIES = [
  { id: '00000000-0000-4000-8000-00000000f0a1', label: 'ZZTEST Alpha Facility 1' },
  { id: '00000000-0000-4000-8000-00000000f0a2', label: 'ZZTEST Alpha Facility 2' },
  { id: '00000000-0000-4000-8000-00000000f0b1', label: 'ZZTEST Beta Facility 1' },
  { id: '00000000-0000-4000-8000-00000000f0b2', label: 'ZZTEST Beta Facility 2' },
];
export const SEED_USERS = [
  { id: '00000000-0000-4000-8000-0000000000e2', label: 'ZZTEST Reviewer', can: 'Creates referrals, enters facts and decides.' },
  { id: '00000000-0000-4000-8000-0000000000e1', label: 'ZZTEST Admin', can: 'Everything a Reviewer can, plus facility settings, co-sign and amend.' },
  { id: '00000000-0000-4000-8000-0000000000e3', label: 'ZZTEST Viewer', can: 'Read only.' },
];

export type Session = { user: string; facility: string };
const KEY = 'codex-health.demo-session';

/** A stored session, only if both ids are seeded ones; anything else means signed out. */
export function parseSession(raw: string | null): Session | null {
  try {
    const s = JSON.parse(raw ?? '') as Partial<Session> | null;
    return SEED_USERS.some((u) => u.id === s?.user) && SEED_FACILITIES.some((f) => f.id === s?.facility) ? { user: s!.user!, facility: s!.facility! } : null;
  } catch {
    return null;
  }
}

export const loadSession = () => parseSession(sessionStorage.getItem(KEY));
export function storeSession(s: Session | null) {
  if (s) sessionStorage.setItem(KEY, JSON.stringify({ user: s.user, facility: s.facility }));
  else sessionStorage.removeItem(KEY);
}

export function SignIn({ onSignIn }: { onSignIn: (s: Session) => void }) {
  const [user, setUser] = useState(SEED_USERS[0]!.id);
  const [facility, setFacility] = useState(SEED_FACILITIES[0]!.id);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSignIn({ user, facility });
  };
  return (
    <Box colorPalette="brand" minH="100dvh" bg="canvas">
      {/* the rail is navy in both themes, so its focus ring uses the signal colour */}
      <Box as="header" bg="rail" color="railInk" css={{ '--chakra-colors-brand-solid': 'var(--chakra-colors-signal)' }}>
        <Flex maxW="72rem" mx="auto" px={{ base: '4', md: '6' }} py="4" align="center" justify="space-between" gap="4" wrap="wrap">
          <Logo />
          <Link href="/" color="railInk" fontSize="sm"><ArrowLeftIcon aria-hidden="true" /> Back to the site</Link>
        </Flex>
      </Box>
      <Box as="main" maxW="32rem" mx="auto" px="4" py={{ base: '8', md: '12' }}>
        <Heading as="h1" size="xl" fontWeight="700">Sign in</Heading>
        <Text mt="2" color="muted">Choose an account and a facility. This is a test environment: its accounts have no password and its referrals are test data.</Text>
        <Box mt="4"><Callout tone="review">Never upload real patient documents to the test environment.</Callout></Box>
        <chakra.form onSubmit={submit} mt="6" bg="surface" borderWidth="1px" borderColor="line" borderRadius="l2" p="4" display="grid" gap="5">
          <fieldset>
            <chakra.legend fontWeight="600" fontSize="sm" mb="2">Sign in as</chakra.legend>
            <Box display="grid" gap="2">
              {SEED_USERS.map((u) => (
                <chakra.label key={u.id} display="flex" gap="3" alignItems="start" p="3" cursor="pointer" borderWidth="1px" borderRadius="l2"
                  borderColor={user === u.id ? 'brand.solid' : 'line'} bg={user === u.id ? 'brand.subtle' : 'transparent'}>
                  <chakra.input type="radio" name="demo-user" value={u.id} checked={user === u.id} onChange={() => setUser(u.id)} aria-labelledby={`who-${u.id}`} aria-describedby={`can-${u.id}`} mt="0.5" flexShrink={0} />
                  <Box>
                    <Text id={`who-${u.id}`} fontWeight="600">{u.label}</Text>
                    <Text id={`can-${u.id}`} fontSize="sm" color="muted">{u.can}</Text>
                  </Box>
                </chakra.label>
              ))}
            </Box>
          </fieldset>
          <Field label="Facility" hint="Only ZZTEST Alpha Facility 1 has prepared referrals. The others show that one facility never sees another's referrals.">
            <Select value={facility} onChange={setFacility}>{SEED_FACILITIES.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</Select>
          </Field>
          <Button type="submit" justifySelf="start"><SignInIcon aria-hidden="true" /> Sign in</Button>
        </chakra.form>
      </Box>
    </Box>
  );
}
