import sql from 'mssql';
import type { QueryRunner } from '../debug/debug';
import { SqlClientError } from '../errors/SqlClientError';
import { t } from '../types/SqlParam';
import type { CommandContext } from './commands';
import {
  buildSetStatement,
  type KeyColumn,
  listToJson,
  type SetRunner,
  SqlSet,
  toKeyColumn,
} from './set';

const result = (
  recordsets?: Array<Array<Record<string, unknown>>>,
  recordset: Array<Record<string, unknown>> = [],
) =>
  ({ recordsets, recordset, rowsAffected: [], output: {} }) as unknown as sql.IResult<
    Record<string, unknown>
  >;
const catalog = [
  { name: 'email', type: 'nvarchar', precision: 0, scale: 0, collation: 'Latin1_General_CI_AS' },
];
const harness = () => {
  const query = jest.fn<ReturnType<QueryRunner>, Parameters<QueryRunner>>();
  const requests: sql.Request[] = [];
  const context: CommandContext = {
    runner: jest.fn(() => query),
    request: () => {
      const request = new sql.Request();

      requests.push(request);

      return Promise.resolve(request);
    },
    connection: () => Promise.reject(new Error('Set operations must not open a transaction')),
    rowFailure: jest.fn(),
    sqlFile: () => Promise.reject(new Error('Set operations must not load a SQL file')),
  };
  const run: SetRunner = async (work, options) => work(context, options);

  query.mockResolvedValueOnce(result([], catalog));

  return {
    query,
    requests,
    context,
    run,
    set: new SqlSet<{ email: string }>('dbo.Users', { key: 'email' }, run),
  };
};

describe('SqlSet execution', () => {
  it('rejects empty key definitions before running a query', () => {
    const { run, query } = harness();

    expect(() => new SqlSet('Users', { key: [] }, run)).toThrow('at least one key');
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['difference', 'intersection'] as const)(
    'returns table rows from %s and forwards call options',
    async (operation) => {
      const { set, query, context } = harness();
      const rows = [{ email: 'db@example.com' }];
      const options = { timeout: 50, retry: false, debug: true };

      query.mockResolvedValue(result([rows]));

      await expect(set[operation](['list@example.com'], options)).resolves.toEqual(rows);
      expect(context.runner).toHaveBeenCalledWith('set', options);
      expect(query.mock.calls[1]?.[1]).toContain(
        operation === 'difference' ? 'AND NOT EXISTS' : 'AND EXISTS',
      );
    },
  );

  it('returns original missing items by their original indexes', async () => {
    const { set, query } = harness();
    const incoming = [
      { email: 'a', payload: {} },
      { email: 'b', payload: {} },
    ];

    query.mockResolvedValue(result([[{ i: 1 }]]));
    const missing = await set.missing(incoming);

    expect(missing).toEqual([incoming[1]]);
    expect(missing[0]).toBe(incoming[1]);
  });

  it.each(['symmetricDifference', 'union'] as const)(
    'maps both result sets from %s',
    async (operation) => {
      const { set, query } = harness();
      const rows = [{ email: 'db' }];
      const incoming = [{ email: 'a' }, { email: 'b' }];

      query.mockResolvedValue(result([rows, [{ i: 1 }]]));
      const actual = await set[operation](incoming);

      expect(actual).toEqual(
        operation === 'union'
          ? { inDb: rows, onlyInList: [incoming[1]] }
          : { onlyInDb: rows, onlyInList: [incoming[1]] },
      );
      expect(actual.onlyInList[0]).toBe(incoming[1]);
    },
  );

  it.each(['difference', 'intersection', 'missing', 'symmetricDifference', 'union'] as const)(
    'handles absent recordsets in %s',
    async (operation) => {
      const { set, query } = harness();

      query.mockResolvedValue(result());

      await expect(set[operation]([])).resolves.toEqual(
        operation === 'union'
          ? { inDb: [], onlyInList: [] }
          : operation === 'symmetricDifference'
            ? { onlyInDb: [], onlyInList: [] }
            : [],
      );
    },
  );

  it.each(['isSubsetOf', 'isSupersetOf', 'isDisjointFrom'] as const)(
    'decodes numeric, boolean, false, and empty %s results',
    async (operation) => {
      const { set, query } = harness();

      query
        .mockResolvedValueOnce(result([[{ result: 1 }]]))
        .mockResolvedValueOnce(result([[{ result: true }]]))
        .mockResolvedValueOnce(result([[{ result: 0 }]]))
        .mockResolvedValueOnce(result([[{ result: false }]]))
        .mockResolvedValueOnce(result([[]]))
        .mockResolvedValueOnce(result());

      await expect(set[operation]([])).resolves.toBe(true);
      await expect(set[operation]([])).resolves.toBe(true);
      await expect(set[operation]([])).resolves.toBe(false);
      await expect(set[operation]([])).resolves.toBe(false);
      await expect(set[operation]([])).resolves.toBe(false);
      await expect(set[operation]([])).resolves.toBe(false);
    },
  );

  it('caches successful metadata and binds filters/list values separately', async () => {
    const { run, query, requests } = harness();
    const set = new SqlSet(
      'dbo.Users',
      {
        key: ['EMAIL'],
        where: { tenantId: t.int(7) },
        columns: ['email'],
        orderBy: { email: 'desc' },
      },
      run,
    );

    query.mockResolvedValue(result([[]]));
    await set.difference([{ EMAIL: "a' OR 1=1 --" }]);
    await set.intersection([]);

    expect(query).toHaveBeenCalledTimes(3);
    expect(requests[0]?.parameters.k0?.value).toBe('EMAIL');
    expect(requests[0]?.parameters.table?.value).toBe('[dbo].[Users]');
    expect(requests[1]?.parameters.p0?.value).toBe(7);
    expect(requests[1]?.parameters.__list?.value).toBe('[{"i":0,"k0":"a\' OR 1=1 --"}]');
    expect(query.mock.calls[1]?.[1]).toContain('[tenantId] = @p0');
    expect(query.mock.calls[1]?.[1]).toContain('[__a].[EMAIL]');
    expect(query.mock.calls[1]?.[1]).not.toContain("a' OR 1=1 --");
    expect(query.mock.calls[2]?.[1]).toContain('ORDER BY [email] DESC');
  });

  it('retries metadata discovery after a missing key is fixed', async () => {
    const { set, query } = harness();

    query
      .mockReset()
      .mockResolvedValueOnce(result([], []))
      .mockResolvedValueOnce(result([], catalog))
      .mockResolvedValueOnce(result([[]]));

    await expect(set.difference([])).rejects.toThrow('Key column "email" not found');
    await expect(set.difference([])).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('propagates catalog/query failures and does not cache failed metadata', async () => {
    const { set, query } = harness();
    const failure = new Error('catalog unavailable');

    query
      .mockReset()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(result([], catalog))
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(result([[]]));

    await expect(set.difference([])).rejects.toBe(failure);
    await expect(set.difference([])).rejects.toBe(failure);
    await expect(set.difference([])).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it('rejects malformed items before touching the database', async () => {
    const { set, query } = harness();

    await expect(set.missing([{ wrong: 'key' }])).rejects.toThrow('no "email" property');
    expect(query).not.toHaveBeenCalled();
  });
});

const column = (
  type: string,
  extra: Partial<{ precision: number; scale: number; collation: string | null }> = {},
) => toKeyColumn({ name: 'col', type, precision: 0, scale: 0, collation: null, ...extra });

describe('toKeyColumn', () => {
  it.each(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext'])(
    'supports %s text keys',
    (type) => {
      expect(column(type, { collation: 'Latin1_General_CI_AS' })).toEqual({
        name: 'col',
        declaration: 'nvarchar(max)',
        collation: 'Latin1_General_CI_AS',
      });
    },
  );

  it.each(['time', 'datetime2', 'datetimeoffset'])('preserves the scale of %s keys', (type) => {
    expect(column(type, { scale: 7 }).declaration).toBe(`${type}(7)`);
  });

  it.each(['binary', 'varbinary', 'image', 'xml', 'sql_variant'])(
    'rejects unsupported %s keys',
    (type) => {
      expect(() => column(type)).toThrow("can't be used as a set key");
    },
  );

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
  it('recognizes scalar dates and typed values and drops undefined/typed NULL keys', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');

    expect(
      JSON.parse(
        listToJson([date, t.int(7), t.int(null), undefined, t.bigint(9007199254740993n)], ['id']),
      ),
    ).toEqual([
      { i: 0, k0: date.toISOString() },
      { i: 1, k0: 7 },
      { i: 4, k0: '9007199254740993' },
    ]);
    expect(
      JSON.parse(
        listToJson(
          [
            { a: 1, b: undefined },
            { a: null, b: 2 },
            { a: 0, b: false },
          ],
          ['a', 'b'],
        ),
      ),
    ).toEqual([{ i: 2, k0: 0, k1: false }]);
  });

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
