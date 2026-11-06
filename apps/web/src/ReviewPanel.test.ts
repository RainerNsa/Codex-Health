import { expect, it } from 'vitest';
import { requestText } from './ReviewPanel.tsx';

it('requestText lists what is needed in order, adds the note, and nothing else', () => {
  expect(requestText(['ventilator_use', 'recent_aggression'], '  Please fax by noon. ')).toBe(
    'We are reviewing this referral for admission and need the following before we can decide:\n\n1. ventilator use\n2. recent aggression\n\nPlease fax by noon.');
  expect(requestText(['iv_antibiotics'], ' ')).not.toContain('\n\n\n');
});
