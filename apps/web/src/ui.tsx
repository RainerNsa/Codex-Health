// The few shared pieces every screen uses, on top of Chakra and the theme tokens.
import type { ReactNode } from 'react';
import { Box, Field as ChakraField, Heading, NativeSelect, Text } from '@chakra-ui/react';

export type Tone = 'admit' | 'review' | 'stop' | 'info';

/** A titled block of the page. */
export function Panel({ id, title, action, children }: { id: string; title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Box as="section" aria-labelledby={title ? id : undefined} bg="surface" borderWidth="1px" borderColor="line" borderRadius="l2" p="4">
      {(title || action) && (
        <Box display="flex" flexWrap="wrap" alignItems="center" gap="3" mb="3">
          {title && <Heading id={id} as="h2" size="sm" fontWeight="700">{title}</Heading>}
          {action}
        </Box>
      )}
      {children}
    </Box>
  );
}

/** A status message: always words, with colour as a second signal. */
export function Callout({ tone, role, children }: { tone: Tone; role?: 'status' | 'alert'; children: ReactNode }) {
  return <Box role={role} bg={`${tone}Soft`} borderWidth="1px" borderColor={tone} borderRadius="l2" px="3" py="2" fontSize="sm">{children}</Box>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <ChakraField.Root>
      <ChakraField.Label fontSize="sm" fontWeight="500">{label}</ChakraField.Label>
      {children}
      {hint && <Text fontSize="xs" color="muted">{hint}</Text>}
    </ChakraField.Root>
  );
}

export function Select({ value, onChange, children, label, required, disabled }: { value: string; onChange: (v: string) => void; children: ReactNode; label?: string; required?: boolean; disabled?: boolean }) {
  return (
    <NativeSelect.Root size="sm" disabled={disabled}>
      <NativeSelect.Field aria-label={label} aria-required={required} value={value} onChange={(e) => onChange(e.target.value)} bg="surface" color="ink">{children}</NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}

export const Sub = ({ children }: { children: ReactNode }) => <Text fontSize="sm" color="muted">{children}</Text>;
