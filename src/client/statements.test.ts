import type sql from 'mssql';
import { t } from '../types/SqlParam';
import { bindRow, bindWhere, buildInsertStatement, keyPredicate } from './statements';

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

describe('bindWhere', () => {
  it('builds equalities, IS NULL and IN, numbering params from the offset', () => {
    const { request, asRequest } = fakeRequest();

    expect(bindWhere({ tenant: 7, status: ['a', 'b'], deletedAt: null }, asRequest, 3)).toEqual({
      predicate: '[tenant] = @p3 AND [status] IN (@p4, @p5) AND [deletedAt] IS NULL',
      params: 3,
    });
    expect(request.input.mock.calls).toEqual([
      ['p3', 7],
      ['p4', 'a'],
      ['p5', 'b'],
    ]);
  });

  it('adds OR IS NULL when an array contains null', () => {
    expect(bindWhere({ status: ['a', null] }, fakeRequest().asRequest, 0).predicate).toBe(
      '([status] IN (@p0) OR [status] IS NULL)',
    );
    expect(bindWhere({ status: [null] }, fakeRequest().asRequest, 0).predicate).toBe(
      '[status] IS NULL',
    );
  });

  it('matches nothing for an empty array', () => {
    expect(bindWhere({ id: [] }, fakeRequest().asRequest, 0)).toEqual({
      predicate: '1 = 0',
      params: 0,
    });
  });

  it('returns an empty predicate for an empty where', () => {
    expect(bindWhere({}, fakeRequest().asRequest, 0)).toEqual({ predicate: '', params: 0 });
  });
});
