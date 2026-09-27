import type sql from 'mssql';
import { buildInsertBatch, buildInsertStatement, chunkRows } from './insertSql';

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
    expect(request.input).toHaveBeenCalledWith('p5', 1);
    expect(request.input).toHaveBeenCalledWith('p6', 2);
  });

  it('uses DEFAULT VALUES for an empty row', () => {
    expect(buildInsertStatement('[T]', {}, fakeRequest().asRequest)).toBe(
      'INSERT INTO [T] DEFAULT VALUES;',
    );
  });
});

describe('chunkRows', () => {
  it('splits by row count', () => {
    expect(chunkRows([{}, {}, {}, {}, {}], 2)).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('splits by parameter count', () => {
    const rows = [
      { a: 1, b: 2 },
      { a: 1, b: 2 },
      { a: 1, b: 2 },
    ];

    expect(chunkRows(rows, 100, 4)).toEqual([[0, 1], [2]]);
  });

  it('returns no chunks for no rows', () => {
    expect(chunkRows([], 10)).toEqual([]);
  });
});

describe('buildInsertBatch', () => {
  const rows = [{ name: 'Ana' }, { name: 'Luis', age: 30 }, { name: 'Eva' }];

  it('tags each insert with its global row index and keeps params unique', () => {
    const { request, asRequest } = fakeRequest();
    const batch = buildInsertBatch('dbo.Users', rows, [1, 2], asRequest, 'rollback');

    expect(batch).toContain(
      'SET @_i = 1; INSERT INTO [dbo].[Users] ([name], [age]) VALUES (@p0, @p1);',
    );
    expect(batch).toContain('SET @_i = 2; INSERT INTO [dbo].[Users] ([name]) VALUES (@p2);');
    expect(request.input.mock.calls).toEqual([
      ['p0', 'Luis'],
      ['p1', 30],
      ['p2', 'Eva'],
    ]);
  });

  it('wraps the whole chunk in one TRY in rollback mode', () => {
    const batch = buildInsertBatch('T', rows, [0, 1], fakeRequest().asRequest, 'rollback');

    expect(batch.match(/BEGIN TRY/g)).toHaveLength(1);
    expect(batch).toContain('WHERE @_errNumber IS NOT NULL');
  });

  it('wraps each row in its own TRY in continue mode', () => {
    const batch = buildInsertBatch('T', rows, [0, 1, 2], fakeRequest().asRequest, 'continue');

    expect(batch.match(/BEGIN TRY/g)).toHaveLength(3);
    expect(batch).toContain('INSERT INTO @_errors VALUES (@_i, ERROR_NUMBER(), ERROR_MESSAGE())');
  });
});
