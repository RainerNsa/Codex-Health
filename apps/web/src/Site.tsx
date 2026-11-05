// The public front of the product: what it does, how it is built to be safe, where it stands, and the way into the demo.
// Copy states only what the code does today (CONSTRAINTS: no accuracy, compliance or customer claims; CI greps for them).
import type { ReactNode } from 'react';
import { Box, Button, Flex, Grid, Heading, Link, List, Text, chakra } from '@chakra-ui/react';
import {
  ArrowRightIcon, CheckCircleIcon, CloudIcon, DatabaseIcon, EnvelopeSimpleIcon, FileMagnifyingGlassIcon, LinkSimpleIcon, ListChecksIcon,
  QuestionIcon, ScalesIcon, ShieldCheckIcon, UploadSimpleIcon, UserCheckIcon, WarningCircleIcon, type Icon,
} from '@phosphor-icons/react';
import { Logo } from './Logo.tsx';

export const DEMO_PATH = '/demo.html';
const CONTACT = import.meta.env.VITE_CONTACT_EMAIL as string | undefined; // set at build time; no address lives in the repo

const STEPS: { icon: Icon; title: string; body: string }[] = [
  { icon: UploadSimpleIcon, title: 'Upload the packet', body: 'PDFs, scans and faxed pages, up to 20 documents for each referral.' },
  { icon: FileMagnifyingGlassIcon, title: 'Read it into facts', body: 'The AI reads each page into Yes, No or Unknown facts. A fact is kept only when its quote is found word for word on the page.' },
  { icon: ScalesIcon, title: 'Apply your criteria', body: "The facility's own rules, not the AI, give Admit, Needs Review or Do Not Admit, with the reasons. The same facts always give the same answer." },
  { icon: UserCheckIcon, title: 'Staff decide', body: 'A reviewer checks the facts that matter against the page image, then decides. An override needs a reason, and some decisions need a second Admin.' },
];

const SAFEGUARDS: { icon: Icon; title: string; body: string }[] = [
  { icon: ScalesIcon, title: 'The AI never decides', body: 'It reads. Rules the facility wrote make the recommendation, and a person makes the decision.' },
  { icon: QuestionIcon, title: 'Unknown stays unknown', body: 'A fact the packet does not settle is never treated as No. It goes to a person.' },
  { icon: LinkSimpleIcon, title: 'Every fact shows its source', body: 'The document, the page and the exact quote, next to the page image.' },
  { icon: DatabaseIcon, title: 'Facilities are walled off in the database', body: "Each facility's records are separated by row-level security in the database itself, not only in application code." },
  { icon: ShieldCheckIcon, title: 'A tamper-evident record', body: 'Every read and change is written to an append-only, hash-chained audit log that holds ids, never patient details.' },
  { icon: CloudIcon, title: 'Documents stay in one AWS account', body: 'Built for Amazon Textract and Bedrock under a business associate agreement. No real patient data is used before that agreement is in place.' },
];

const BUILT = [
  'Referral intake, document upload and file checks',
  'Page images rendered in a sandbox',
  'Fact review with the source page beside each fact',
  'Facility criteria, recommendation and reasons',
  'Decisions, overrides and two-person co-sign',
  'Hash-chained audit log and the deletion job',
];
const NEXT = [
  'Refusing a final decision until its hard stops are checked against the page',
  'Real sign-in with multi-factor authentication',
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

const DemoButton = ({ size = 'lg' }: { size?: 'md' | 'lg' }) => (
  <Button asChild size={size} colorPalette="brand"><a href={DEMO_PATH}>Open the demo <ArrowRightIcon aria-hidden="true" /></a></Button>
);

// A still picture of the reviewer screen, drawn in markup so it stays sharp and follows the theme. All of it is synthetic.
function ReferralPicture() {
  const facts: { key: string; value: string; tone: 'admit' | 'stop' | 'review'; source: string; quote: string }[] = [
    { key: 'Ventilator use', value: 'No', tone: 'admit', source: 'Discharge summary, page 3', quote: 'Weaned from the ventilator on day 4, on room air since.' },
    { key: 'IV antibiotics', value: 'Yes', tone: 'admit', source: 'Physician orders, page 2', quote: 'Continue IV antibiotics for 10 days.' },
    { key: 'Recent aggression', value: 'Unknown', tone: 'review', source: 'Not stated in the packet', quote: 'Sent to a person, never read as No.' },
  ];
  return (
    <Box role="img" aria-label="Example referral screen with synthetic data: three facts with their sources and a Needs Review recommendation" bg="surface" color="ink" borderRadius="l3" borderWidth="1px" borderColor="line" boxShadow="lg" overflow="hidden">
      <Flex justify="space-between" align="center" gap="3" px="4" py="3" borderBottomWidth="1px" borderColor="line">
        <Text fontWeight="700">ZZTEST, Patient</Text>
        <Text fontSize="xs" color="muted" fontFamily="mono">synthetic</Text>
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
              <Text fontWeight="700" color={f.tone === 'review' ? 'review' : 'ink'}>{f.value}</Text>
            </Flex>
            <Text fontSize="xs" color="muted" mt="1">{f.source}</Text>
            <Text fontSize="sm" mt="1" fontStyle="italic">“{f.quote}”</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function Checklist({ items, done }: { items: string[]; done: boolean }) {
  const Glyph = done ? CheckCircleIcon : ListChecksIcon;
  return (
    <List.Root listStyleType="none" display="grid" gap="2.5">
      {items.map((item) => (
        <List.Item key={item} display="flex" gap="2.5" alignItems="start">
          <Box as="span" color={done ? 'admit' : 'muted'} mt="0.5" flexShrink={0}><Glyph size={18} aria-hidden="true" /></Box>
          {item}
        </List.Item>
      ))}
    </List.Root>
  );
}

export function Site() {
  return (
    <Box colorPalette="brand" minH="100dvh" bg="canvas">
      <Box bg="rail" color="railInk" css={{ '--chakra-colors-brand-solid': 'var(--chakra-colors-signal)', '--chakra-colors-brand-contrast': '#0c141c' }}>
        <Box as="header">
          <Wrap>
            <Flex align="center" justify="space-between" gap="4" py="4" wrap="wrap">
              <Logo />
              <Flex as="nav" aria-label="Site" align="center" gap={{ base: '3', md: '6' }} wrap="wrap" fontSize="sm">
                <Link href="#how" color="railInk" display={{ base: 'none', md: 'inline' }}>How it works</Link>
                <Link href="#safeguards" color="railInk" display={{ base: 'none', md: 'inline' }}>Safeguards</Link>
                <Link href="#status" color="railInk" display={{ base: 'none', md: 'inline' }}>Where it stands</Link>
                <DemoButton size="md" />
              </Flex>
            </Flex>
          </Wrap>
        </Box>
        <Box as="section" aria-label="Introduction"><Wrap>
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
                <DemoButton />
                <Button asChild size="lg" variant="outline" color="railInk" borderColor="railInk" _hover={{ bg: 'whiteAlpha.200' }}><a href="#how">How it works</a></Button>
              </Flex>
              <Text mt="5" fontSize="sm">In development. The demo holds synthetic data only.</Text>
            </Box>
            <ReferralPicture />
          </Grid>
        </Wrap></Box>
      </Box>

      <Box as="main">
        <Section id="problem" title="The problem" lead="A referral packet decides whether a facility can safely take a patient. It is also the hardest document in the building to read quickly.">
          <Grid templateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' }} gap="4">
            <Card icon={FileMagnifyingGlassIcon} title="Long, mixed packets">Discharge summaries, orders, therapy notes and insurance pages, often scanned or faxed. The facts that decide an admission are scattered across them.</Card>
            <Card icon={ListChecksIcon} title="Criteria in people's heads">Each facility has its own rules for what it can take. They live in a binder or in an experienced admissions lead's memory.</Card>
            <Card icon={QuestionIcon} title="Answers without sources">An AI answer with no source still has to be checked line by line, and it is hard to defend when the decision is questioned.</Card>
          </Grid>
        </Section>

        <Section id="how" title="How it works" lead="AI does the reading. The facility's rules make the recommendation. A person makes the decision.">
          <Grid templateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(4, minmax(0, 1fr))' }} gap="4">
            {STEPS.map((s, i) => <Card key={s.title} icon={s.icon} title={s.title} step={i + 1}>{s.body}</Card>)}
          </Grid>
        </Section>

        <Section id="safeguards" title="Safeguards" lead="Referral packets hold some of the most sensitive data there is. These are built into the product, not added on.">
          <Grid templateColumns={{ base: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))', lg: 'repeat(3, minmax(0, 1fr))' }} gap="4">
            {SAFEGUARDS.map((s) => <Card key={s.title} icon={s.icon} title={s.title}>{s.body}</Card>)}
          </Grid>
        </Section>

        <Section id="status" title="Where it stands" lead="The whole product runs end to end on synthetic referrals today. Real patient data waits for the agreements and checks it needs.">
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

        <Section id="demo" title="See it working" lead="Pick a role, open a referral, upload a synthetic packet and walk it from the first page to a recorded decision. Every name in the demo begins with ZZTEST.">
          <Flex gap="3" wrap="wrap">
            <DemoButton />
            {CONTACT && <Button asChild size="lg" variant="outline"><a href={`mailto:${CONTACT}`}><EnvelopeSimpleIcon aria-hidden="true" /> Talk to the founders</a></Button>}
          </Flex>
        </Section>
      </Box>

      <Box as="footer" borderTopWidth="1px" borderColor="line" py="8">
        <Wrap>
          <Flex justify="space-between" gap="4" wrap="wrap" color="muted" fontSize="sm">
            <Text>© {new Date().getFullYear()} Codex Health</Text>
            <Text>In development and not in clinical use. Never upload real patient documents to the demo.</Text>
          </Flex>
        </Wrap>
      </Box>
    </Box>
  );
}
