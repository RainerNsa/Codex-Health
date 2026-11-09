import { expect, it } from 'vitest';
import { arrayLiteral } from './backend.ts';

it('arrayLiteral writes a Postgres array literal as node-pg does, quoting and escaping each element', () => {
  expect(arrayLiteral(['draft', 'on_hold'])).toBe('{"draft","on_hold"}');
  expect(arrayLiteral(['a"b', 'c\\d', null, ['x']])).toBe('{"a\\"b","c\\\\d",NULL,{"x"}}');
  expect(arrayLiteral([])).toBe('{}');
});
