// The Codex Health mark: a C drawn as a square citation bracket holding a health cross, because every answer in the
// product shows its source. Drawn on a 64 grid; the bracket takes the text colour, the cross the signal colour.
import { Flex, Text } from '@chakra-ui/react';

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="8 6 49 52" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M13 11h39v8H21v26h31v8H13z" />
      <path fill="var(--chakra-colors-signal)" d="M36 23h6v6h6v6h-6v6h-6v-6h-6v-6h6z" />
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
