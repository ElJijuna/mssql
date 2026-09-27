import type sql from 'mssql';
import { buildBatch, chunkRows, track } from './batch';

const fakeRequest = () => ({ input: jest.fn() }) as unknown as sql.Request;
const build = (row: Record<string, unknown>, _request: sql.Request, offset: number) =>
  `STMT(${Object.keys(row).join(',')}@${offset}) ${track('inserted')}`;

describe('chunkRows', () => {
  const rows = [
    { a: 1, b: 2 },
    { a: 1, b: 2 },
    { a: 1, b: 2 },
  ];

  it('splits by row count', () => {
    expect(chunkRows([{}, {}, {}, {}, {}], [0, 1, 2, 3, 4], 2)).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('splits by parameter count', () => {
    expect(chunkRows(rows, [0, 1, 2], 100, 4)).toEqual([[0, 1], [2]]);
  });

  it('only chunks the given indexes', () => {
    expect(chunkRows(rows, [0, 2], 100)).toEqual([[0, 2]]);
  });

  it('returns no chunks for no rows', () => {
    expect(chunkRows([], [], 10)).toEqual([]);
  });
});

describe('buildBatch', () => {
  const rows = [{ name: 'Ana' }, { name: 'Luis', age: 30 }, { name: 'Eva' }];

  it('tags each statement with its global row index and offsets params', () => {
    const batch = buildBatch(rows, [1, 2], fakeRequest(), 'rollback', build);

    expect(batch).toContain(
      "SET @_i = 1; STMT(name,age@0) INSERT INTO @_out VALUES (@_i, 'inserted', NULL);",
    );
    expect(batch).toContain('SET @_i = 2; STMT(name@2)');
  });

  it('wraps the whole chunk in one TRY in rollback mode', () => {
    const batch = buildBatch(rows, [0, 1], fakeRequest(), 'rollback', build);

    expect(batch.match(/BEGIN TRY/g)).toHaveLength(1);
    expect(batch).toContain('WHERE @_errNumber IS NOT NULL');
  });

  it('wraps each row in its own TRY and transaction in continue mode', () => {
    const batch = buildBatch(rows, [0, 1, 2], fakeRequest(), 'continue', build);

    expect(batch.match(/BEGIN TRY BEGIN TRAN;/g)).toHaveLength(3);
    expect(batch).toContain('IF @@TRANCOUNT > 0 ROLLBACK TRAN;');
    expect(batch).toContain('INSERT INTO @_errors VALUES (@_i, ERROR_NUMBER(), ERROR_MESSAGE())');
  });

  it('uses savepoints instead of transactions for continue mode inside a transaction', () => {
    const batch = buildBatch(rows, [0, 1], fakeRequest(), 'continue', build, true);

    expect(batch.match(/SAVE TRAN _row;/g)).toHaveLength(2);
    expect(batch).toContain('IF XACT_STATE() = 1 ROLLBACK TRAN _row;');
    expect(batch).not.toContain('BEGIN TRAN');
  });
});
