import type sql from 'mssql';
import { t } from '../types/SqlParam';
import { bindRow, buildInsertStatement, keyPredicate } from './statements';

const fakeRequest = () => {
  const request = { input: jest.fn() };

  return { request, asRequest: request as unknown as sql.Request };
};

describe('buildInsertStatement', () => {
  it('numbers parameters from the given offset', () => {
    const { request, asRequest } = fakeRequest();

    expect(buildInsertStatement('[T]', { a: 1, b: 2 }, asRequest, 5)).toBe(
      'INSERT INTO [T] ([a], [b]) VALUES (@p5, @p6);',
    );
    expect(request.input.mock.calls).toEqual([
      ['p5', 1],
      ['p6', 2],
    ]);
  });

  it('uses DEFAULT VALUES for an empty row', () => {
    expect(buildInsertStatement('[T]', {}, fakeRequest().asRequest)).toBe(
      'INSERT INTO [T] DEFAULT VALUES;',
    );
  });
});

describe('keyPredicate', () => {
  it('joins equalities with AND and uses IS NULL for null values', () => {
    const row = { a: 1, b: null, c: t.int(null), d: undefined };
    const params = bindRow(row, fakeRequest().asRequest, 0);

    expect(keyPredicate(['a', 'b', 'c', 'd'], row, params)).toBe(
      '[a] = @p0 AND [b] IS NULL AND [c] IS NULL AND [d] IS NULL',
    );
  });
});
