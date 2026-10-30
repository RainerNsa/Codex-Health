import { expect, it } from 'vitest';
import type { FactRow } from './api.ts';
import { trust } from './EvidencePanel.tsx';

const fact = (verified: boolean | null, confidence_band: FactRow['confidence_band']) => ({
  id: 'f', key: 'k', value: { type: 'tri_state', value: 'no' }, source: 'ai', note: null, as_of_date: null, single_source: false, confidence_band,
  evidence: verified === null ? null : { document_id: 'd', page: 1, quote: 'SYNTHETIC', verified },
}) as FactRow;

it('the label never says more than the reading earned', () => {
  expect(trust(fact(true, 'high')).text).toBe('Quote found on the page');
  expect(trust(fact(true, 'medium')).text).toBe('Quote found on the page');
  expect(trust(fact(true, 'low')).text).toBe('Low confidence');
  expect(trust(fact(true, null)).text).toBe('Low confidence');
  expect(trust(fact(false, 'high')).text).toBe('Quote not found on the page');
  expect(trust(fact(false, 'low')).text).toBe('Quote not found on the page');
  expect(trust(fact(null, null)).text).toBe('Documents disagree');
});
