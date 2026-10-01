import { SqlPrecisionError } from '../errors/SqlPrecisionError';
import { parseIdentity } from './identity';

describe('identity precision', () => {
  it.each([
    ['42', 42],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
    ['9007199254740992', '9007199254740992'],
    ['9007199254740993', '9007199254740993'],
    ['-9007199254740993', '-9007199254740993'],
    ['99999999999999999999999999999999999999', '99999999999999999999999999999999999999'],
    [null, null],
  ])('decodes %s without rounding', (input, expected) => {
    expect(parseIdentity(input)).toBe(expected);
  });

  it('rejects a value already returned as an unsafe number', () => {
    expect(() => parseIdentity(9007199254740992)).toThrow(SqlPrecisionError);
  });
});
