// The public front of the product: what it sets out to do, how it does each part, where it stands, and the way to sign in.
// Copy states only what the code does today (CONSTRAINTS: no accuracy, compliance or customer claims; CI greps for them).
import type { ReactNode } from 'react';
import { Box, Button, Flex, Grid, Heading, Link, List, Text, chakra } from '@chakra-ui/react';
import {
  ArrowRightIcon, CheckCircleIcon, EnvelopeSimpleIcon, FileMagnifyingGlassIcon, ListChecksIcon, LockKeyIcon, ScalesIcon,
  ShieldCheckIcon, SignInIcon, UploadSimpleIcon, UserCheckIcon, WarningCircleIcon, type Icon,
} from '@phosphor-icons/react';
import { Logo } from './Logo.tsx';

export const APP_PATH = '/app.html';
const CONTACT = import.meta.env.VITE_CONTACT_EMAIL as string | undefined; // set at build time; no address lives in the repo

const OBJECTIVES: { icon: Icon; title: string; aim: string; how: string[] }[] = [
  {
    icon: FileMagnifyingGlassIcon, title: 'A sound answer from every packet',
    aim: 'Pull the facts that decide an admission out of a long, mixed referral packet, without losing where each one came from.',
    how: [
      'The AI reads every page into Yes, No or Unknown facts.',
      'A fact counts only when its quote is found word for word on the page; otherwise it stays Unknown.',
      'Facts the packet does not settle are flagged as missing information, never filled in.',
    ],
  },
  {
    icon: ScalesIcon, title: "The facility's own criteria, applied the same way every time",
    aim: 'Turn the rules an admissions team already works by into a recommendation that does not depend on who is on shift.',
    how: [
      'Each organisation writes its criteria as rules: hard stops, items that need review, and items that favour admission.',
      'A deterministic engine, separate from the AI, gives Admit, Needs Review or Do Not Admit, with the rules that fired.',
      'Every recommendation records the criteria version it used.',
    ],
  },
  {
    icon: UserCheckIcon, title: 'People stay in charge',
    aim: 'Support the admissions team. The AI never makes the decision.',
    how: [
      'A reviewer sees the page image behind a fact before confirming it.',
      'Unknown is never read as No: it goes to a person.',
      'Overriding a recommendation needs a reason, and some decisions need a second Admin to co-sign.',
    ],
  },
  {
    icon: ShieldCheckIcon, title: 'Every decision can be explained later',
    aim: 'When a decision is questioned months later, show what was known, what the rules said and who decided.',
    how: [
      'Every change, and every read of patient data, goes into an append-only, hash-chained audit log.',
      'Facts record the model, prompt and extractor versions that produced them.',
      'Decisions keep their full history, co-signs and amendments included.',
    ],
  },
  {
    icon: LockKeyIcon, title: 'Patient data protected from the start',
    aim: 'Treat referral packets as some of the most sensitive data there is, from the first line of code.',
    how: [
      "Each facility's records are separated by row-level security in the database itself.",
      'Documents stay encrypted in one AWS account, and AI runs only through Amazon Bedrock under a business associate agreement.',
      'No real patient data is used until those agreements are in place.',
    ],
  },
];

const STEPS: { icon: Icon; title: string; body: string }[] = [
  { icon: UploadSimpleIcon, title: 'Upload the packet', body: 'PDFs, scans and faxed pages, up to 20 documents for each referral.' },
  { icon: FileMagnifyingGlassIcon, title: 'Read it into facts', body: 'Each fact links to its document, page and exact quote.' },
  { icon: ScalesIcon, title: 'Apply your criteria', body: 'Your rules give the recommendation and the reasons for it.' },
  { icon: UserCheckIcon, title: 'Decide and record', body: 'A reviewer checks the facts that matter against the page, then decides. The decision is recorded.' },
];

const BUILT = [
  'Referral intake, document upload and file checks',
  'Page images rendered in an isolated sandbox',
  'Fact review with the source page beside each fact',
  'Facility criteria, recommendation and reasons',
  'Decisions, overrides and two-person co-sign',
  'Hash-chained audit log and record deletion',
];
const NEXT = [
  'Refusing a final decision until its hard stops are checked against the page',
  'Production sign-in with multi-factor authentication',
  'First runs on Amazon Textract and Bedrock',
  'A criteria workshop with a clinician',
  "A pilot alongside a facility's current process",
];

const Wrap = ({ children }: { children: ReactNode }) => <Box maxW="72rem" mx="auto" px={{ base: '4', md: '6' }}>{children}</Box>;

function Section({ id, title, lead, children }: { id: string; title: string; lead?: string; children: ReactNode }) {
  return (
    <Box as="section" id={id} aria-labelledby={`${id}-title`} py={{ base: '12', md: '16' }} borderTopWidth="1px" borderColor="line">
      <Wrap>
        <Heading id={`${id}-title`} as="h2" size="2xl" fontWeight="700" letterSpacing="-0.01em">{title}</Heading>
        {lead && <Text mt="3" maxW="44rem" color="muted" fontSize="lg">{lead}</Text>}
        <Box mt="8">{children}</Box>
      </Wrap>
    </Box>
  );
}

function Card({ icon: Glyph, title, children, step }: { icon: Icon; title: string; children: ReactNode; step?: number }) {
  return (
    <Box bg="surface" borderWidth="1px" borderColor="line" borderRadius="l3" p="5">
      <Flex align="center" gap="2.5" color="brand.fg">
        <Glyph size={22} aria-hidden="true" />
        {step && <Text as="span" fontFamily="mono" fontSize="sm" color="muted">Step {step}</Text>}
      </Flex>
      <Heading as="h3" size="md" fontWeight="700" mt="3">{title}</Heading>
      <Text mt="2" color="muted">{children}</Text>
    </Box>
  );
}

function Checklist({ items, done }: { items: string[]; done: boolean }) {
  const Glyph = done ? CheckCircleIcon : ArrowRightIcon;
  return (
    <List.Root listStyleType="none" display="grid" gap="2.5">
      {items.map((item) => (
        <List.Item key={item} display="flex" gap="2.5" alignItems="start">
          <Box as="span" color={done ? 'admit' : 'brand.fg'} mt="0.5" flexShrink={0}><Glyph size={18} aria-hidden="true" /></Box>
          {item}
        </List.Item>
      ))}
    </List.Root>
  );
}

function Objective({ n, icon: Glyph, title, aim, how }: (typeof OBJECTIVES)[number] & { n: number }) {
  return (
    <Grid as="article" templateColumns={{ base: 'minmax(0, 1fr)', md: 'minmax(0, 2fr) minmax(0, 3fr)' }} gap={{ base: '4', md: '8' }} bg="surface" borderWidth="1px" borderColor="line" borderRadius="l3" p={{ base: '5', md: '6' }}>
      <Box>
        <Flex align="center" gap="2.5" color="brand.fg">
          <Glyph size={22} aria-hidden="true" />
          <Text as="span" fontFamily="mono" fontSize="sm" color="muted">Objective {n}</Text>
        </Flex>
        <Heading as="h3" size="lg" fontWeight="700" mt="3">{title}</Heading>
        <Text mt="2" color="muted">{aim}</Text>
      </Box>
      <Box>
        <Text fontSize="sm" fontWeight="600" textTransform="uppercase" letterSpacing="0.06em" color="muted" mb="3">How Codex Health does it</Text>
        <Checklist items={how} done />
      </Box>
    </Grid>
  );
}

// A still picture of the reviewer screen, drawn in markup so it stays sharp and follows the theme. The example is synthetic.
function ReferralPicture() {
  const facts: { key: string; value: string; review?: boolean; source: string; quote: string | null }[] = [
    { key: 'Ventilator use', value: 'No', source: 'Discharge summary, page 3', quote: 'Weaned from the ventilator on day 4, on room air since.' },
    { key: 'IV antibiotics', value: 'Yes', source: 'Physician orders, page 2', quote: 'Continue IV antibiotics for 10 days.' },
    { key: 'Recent aggression', value: 'Unknown', review: true, source: 'Not stated in the packet', quote: null },
  ];
  return (
    <Box role="img" aria-label="Example referral, with test data: three facts with their sources and a Needs Review recommendation" bg="surface" color="ink" borderRadius="l3" borderWidth="1px" borderColor="line" boxShadow="lg" overflow="hidden">
      <Flex justify="space-between" align="center" gap="3" px="4" py="3" borderBottomWidth="1px" borderColor="line">
        <Text fontWeight="700">ZZTEST, Patient</Text>
        <Text fontSize="xs" color="muted">Referral received today</Text>
      </Flex>
      <Flex align="center" gap="2" mx="4" mt="4" px="3" py="2" bg="reviewSoft" borderWidth="1px" borderColor="review" borderRadius="l2" fontSize="sm">
        <WarningCircleIcon size={18} aria-hidden="true" />
        <Text><chakra.span fontWeight="700">Needs Review:</chakra.span> missing information</Text>
      </Flex>
      <Box as="ul" listStyleType="none" p="4" display="grid" gap="3">
        {facts.map((f) => (
          <Box as="li" key={f.key} borderWidth="1px" borderColor="line" borderRadius="l2" p="3">
            <Flex justify="space-between" gap="3">
              <Text fontWeight="600">{f.key}</Text>
              <Text fontWeight="700" color={f.review ? 'review' : 'ink'}>{f.value}</Text>
            </Flex>
            <Text fontSize="xs" color="muted" mt="1">{f.source}</Text>
            {f.quote
              ? <Text fontSize="sm" mt="1" fontStyle="italic">“{f.quote}”</Text>
              : <Text fontSize="sm" mt="1">Sent to a person, never read as No.</Text>}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

const SignInButton = ({ size = 'lg', variant = 'solid' }: { size?: 'md' | 'lg'; variant?: 'solid' | 'outline' }) => (
  <Button asChild size={size} variant={variant} colorPalette="brand"><a href={APP_PATH}><SignInIcon aria-hidden="true" /> Sign in</a></Button>
);
const ContactButton = ({ to }: { to: string }) => (
  <Button asChild size="lg" colorPalette="brand"><a href={`mailto:${to}`}><EnvelopeSimpleIcon aria-hidden="true" /> Get in touch</a></Button>
);

export function Site() {
  return (
    <Box colorPalette="brand" minH="100dvh" bg="canvas">
      <Box bg="rail" color="railInk" css={{ '--chakra-colors-brand-solid': 'var(--chakra-colors-signal)', '--chakra-colors-brand-contrast': '#0c141c' }}>
        <Box as="header">
          <Wrap>
            <Flex align="center" justify="space-between" gap="4" py="4" wrap="wrap">
              <Logo />
              <Flex as="nav" aria-label="Site" align="center" gap={{ base: '3', md: '6' }} wrap="wrap" fontSize="sm">
                <Link href="#objectives" color="railInk" display={{ base: 'none', md: 'inline' }}>Objectives</Link>
                <Link href="#how" color="railInk" display={{ base: 'none', md: 'inline' }}>How it works</Link>
                <Link href="#roadmap" color="railInk" display={{ base: 'none', md: 'inline' }}>Roadmap</Link>
                <SignInButton size="md" />
              </Flex>
            </Flex>
          </Wrap>
        </Box>
        <Box as="section" aria-label="Introduction">
          <Wrap>
            <Grid templateColumns={{ base: 'minmax(0, 1fr)', lg: 'minmax(0, 1.1fr) minmax(0, 1fr)' }} gap={{ base: '10', lg: '14' }} alignItems="center" py={{ base: '12', md: '20' }}>
              <Box>
                <Text fontSize="sm" fontWeight="600" color="railInk" textTransform="uppercase" letterSpacing="0.08em">Admissions decision support for skilled nursing</Text>
                <Heading as="h1" mt="4" fontSize={{ base: '4xl', md: '5xl' }} lineHeight="1.1" fontWeight="700" letterSpacing="-0.02em" color="white">
                  Admission decisions you can trace back to the page.
                </Heading>
                <Text mt="5" fontSize="lg" maxW="36rem">
                  Codex Health reads a hospital referral packet into Yes, No and Unknown facts, each linked to the page it came from.
                  Your facility's own criteria turn those facts into a recommendation. Your staff make the decision, and every step is recorded.
                </Text>
                <Flex mt="8" gap="3" wrap="wrap">
                  {CONTACT ? <ContactButton to={CONTACT} /> : <SignInButton />}
                  <Button asChild size="lg" variant="outline" color="railInk" borderColor="railInk" _hover={{ bg: 'whiteAlpha.200' }}><a href="#objectives">See what it does <ArrowRightIcon aria-hidden="true" /></a></Button>
                </Flex>
              </Box>
              <ReferralPicture />
            </Grid>
          </Wrap>
        </Box>
      </Box>

      <Box as="main">
        <Section id="problem" title="The problem" lead="A referral packet decides whether a facility can safely take a patient. It is also the hardest document in the building to read quickly.">
          <Grid templateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' }} gap="4">
            <Card icon={FileMagnifyingGlassIcon} title="Long, mixed packets">Discharge summaries, orders, therapy notes and insurance pages, often scanned or faxed. The facts that decide an admission are scattered across them.</Card>
            <Card icon={ListChecksIcon} title="Criteria in people's heads">Each facility has its own rules for what it can take. They live in a binder or in an experienced admissions lead's memory.</Card>
            <Card icon={WarningCircleIcon} title="Answers without sources">An AI answer with no source still has to be checked line by line, and it is hard to defend when the decision is questioned.</Card>
          </Grid>
        </Section>

        <Section id="objectives" title="What Codex Health sets out to do" lead="Five objectives shape the product. Each one is met in the software itself, not left to policy.">
          <Grid gap="4">
            {OBJECTIVES.map((o, i) => <Objective key={o.title} n={i + 1} {...o} />)}
          </Grid>
        </Section>

        <Section id="how" title="How it works" lead="AI does the reading. The facility's rules make the recommendation. A person makes the decision.">
          <Grid templateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' }} gap="4">
            {STEPS.map((s, i) => <Card key={s.title} icon={s.icon} title={s.title} step={i + 1}>{s.body}</Card>)}
          </Grid>
        </Section>

        <Section id="roadmap" title="Roadmap" lead="The product runs end to end today on test referrals. Real patient data waits for the agreements and checks it needs.">
          <Grid templateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }} gap="4">
            <Box bg="surface" borderWidth="1px" borderColor="line" borderRadius="l3" p="5">
              <Heading as="h3" size="md" fontWeight="700" mb="4">Built</Heading>
              <Checklist items={BUILT} done />
            </Box>
            <Box bg="surface" borderWidth="1px" borderColor="line" borderRadius="l3" p="5">
              <Heading as="h3" size="md" fontWeight="700" mb="4">Next</Heading>
              <Checklist items={NEXT} done={false} />
            </Box>
          </Grid>
        </Section>

        <Section id="contact" title="Work with us" lead="We are looking for skilled nursing operators to shape the criteria and run a first pilot, and for partners to fund the path there.">
          <Flex gap="3" wrap="wrap">
            {CONTACT && <ContactButton to={CONTACT} />}
            <SignInButton variant={CONTACT ? 'outline' : 'solid'} />
          </Flex>
        </Section>
      </Box>

      <Box as="footer" borderTopWidth="1px" borderColor="line" py="8">
        <Wrap>
          <Flex justify="space-between" gap="4" wrap="wrap" color="muted" fontSize="sm">
            <Text>© {new Date().getFullYear()} Codex Health</Text>
            <Text>Codex Health is in development and not yet in clinical use.</Text>
          </Flex>
        </Wrap>
      </Box>
    </Box>
  );
}
