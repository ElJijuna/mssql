import { SqlClientError } from '../errors/SqlClientError';
import { t } from '../types/SqlParam';
import { buildSetStatement, type KeyColumn, listToJson, toKeyColumn } from './set';

const column = (
  type: string,
  extra: Partial<{ precision: number; scale: number; collation: string | null }> = {},
) => toKeyColumn({ name: 'col', type, precision: 0, scale: 0, collation: null, ...extra });

describe('toKeyColumn', () => {
  it('reads text keys as nvarchar(max) and keeps their collation', () => {
    expect(column('varchar', { collation: 'SQL_Latin1_General_CP1_CI_AS' })).toEqual({
      name: 'col',
      declaration: 'nvarchar(max)',
      collation: 'SQL_Latin1_General_CP1_CI_AS',
    });
  });

  it('keeps precision and scale where they matter', () => {
    expect(column('decimal', { precision: 10, scale: 2 }).declaration).toBe('decimal(10, 2)');
    expect(column('datetime2', { scale: 3 }).declaration).toBe('datetime2(3)');
    expect(column('int').declaration).toBe('int');
    expect(column('uniqueidentifier').declaration).toBe('uniqueidentifier');
  });

  it('rejects types that cannot be keys and unexpected collations', () => {
    expect(() => column('varbinary')).toThrow(SqlClientError);
    expect(() => column('nvarchar', { collation: "x'; DROP" })).toThrow(SqlClientError);
  });
});

describe('listToJson', () => {
  it('turns keys and objects into indexed entries', () => {
    expect(JSON.parse(listToJson(['a', 'b'], ['email']))).toEqual([
      { i: 0, k0: 'a' },
      { i: 1, k0: 'b' },
    ]);
    expect(JSON.parse(listToJson([{ email: 'a', name: 'x' }], ['email']))).toEqual([
      { i: 0, k0: 'a' },
    ]);
  });

  it('supports composite keys, t builders, dates and bigint', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');

    expect(
      JSON.parse(
        listToJson(
          [{ tenantId: t.int(1), code: 'A', at: date, big: 9007199254740993n }],
          ['tenantId', 'code', 'at', 'big'],
        ),
      ),
    ).toEqual([{ i: 0, k0: 1, k1: 'A', k2: '2026-01-02T03:04:05.000Z', k3: '9007199254740993' }]);
  });

  it('skips items with a NULL key part but keeps the original indexes', () => {
    expect(JSON.parse(listToJson(['a', null, 'c'], ['email']))).toEqual([
      { i: 0, k0: 'a' },
      { i: 2, k0: 'c' },
    ]);
  });

  it('reports items that do not carry the key', () => {
    expect(() => listToJson([{ name: 'x' }], ['email'])).toThrow(
      'List item 0 has no "email" property',
    );
    expect(() => listToJson(['x'], ['tenantId', 'code'])).toThrow(
      'must be an object with tenantId, code',
    );
  });
});

describe('buildSetStatement', () => {
  const email: KeyColumn = {
    name: 'email',
    declaration: 'nvarchar(max)',
    collation: 'Latin1_General_CI_AS',
  };
  const id: KeyColumn = { name: 'id', declaration: 'int', collation: null };

  it('reads the list once per statement with OPENJSON typed from the catalog', () => {
    const statement = buildSetStatement('symmetricDifference', 'dbo.Users', [email], '', {});

    expect(
      statement.match(/WITH \[__list\] AS \(SELECT \* FROM OPENJSON\(@__list\)/g),
    ).toHaveLength(2);
    expect(statement).toContain("[k0] nvarchar(max) '$.k0'");
  });

  it('compares text with the column collation, or exactly when case-sensitive', () => {
    expect(buildSetStatement('difference', 'Users', [email], '', {})).toContain(
      '[__a].[email] = [__l].[k0] COLLATE Latin1_General_CI_AS',
    );
    expect(
      buildSetStatement('difference', 'Users', [email], '', { caseSensitive: true }),
    ).toContain(
      '[__a].[email] COLLATE Latin1_General_100_BIN2 = [__l].[k0] COLLATE Latin1_General_100_BIN2',
    );
  });

  it('uses NOT EXISTS and ignores NULL keys on the table side', () => {
    const statement = buildSetStatement('difference', 'Users', [id], '[tenantId] = @p0', {
      columns: ['id'],
      orderBy: 'id',
    });

    expect(statement).toContain(
      'SELECT [__a].[id] FROM [Users] AS [__a] WHERE [tenantId] = @p0 AND [__a].[id] IS NOT NULL AND NOT EXISTS (SELECT 1 FROM [__list] AS [__l] WHERE [__a].[id] = [__l].[k0]) ORDER BY [id] ASC;',
    );
    expect(statement).not.toContain('NOT IN');
  });

  it('returns the first list index per key for missing items', () => {
    expect(buildSetStatement('missing', 'Users', [email], '', {})).toContain(
      'SELECT MIN([__l].[i]) AS [i] FROM [__list] AS [__l] WHERE NOT EXISTS',
    );
  });

  it('answers boolean checks with a single row', () => {
    expect(buildSetStatement('isDisjointFrom', 'Users', [id], '', {})).toContain(
      'SELECT CASE WHEN EXISTS',
    );
  });
});
