// The Codex Health mark: a heavy round C with a small health cross in its opening. Drawn on a 64 grid; the C takes the
// text colour, the cross the signal colour.
import { Flex, Text } from '@chakra-ui/react';

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="4 4 56 56" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M52 18A25 25 0 1 0 52 46l-7-6a16 16 0 1 1 0-16z" />
      <path fill="var(--chakra-colors-signal)" d="M47.5 25h5v4.5h4.5v5h-4.5v4.5h-5v-4.5h-4.5v-5h4.5z" />
    </svg>
  );
}

export function Logo() {
  return (
    <Flex align="center" gap="2.5" aria-label="Codex Health" role="img">
      <LogoMark />
      <Text as="span" fontWeight="700" fontSize="lg" letterSpacing="-0.01em" lineHeight="1">Codex Health</Text>
    </Flex>
  );
}
