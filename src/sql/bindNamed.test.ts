import sql from 'mssql';
import { SqlClientError } from '../errors/SqlClientError';
import { t } from '../types/SqlParam';
import { analyzeSql } from './analyze';
import { assertParameters, bindNamedParameters } from './bindNamed';

const bind = (text: string, params: Record<string, unknown>) => {
  const request = new sql.Request();
  const statement = bindNamedParameters(request, text, analyzeSql(text), params);

  return { request, statement };
};

describe('bindNamedParameters', () => {
  it('binds by name, with or without @, keeping the SQL as is', () => {
    const { request, statement } = bind('SELECT * FROM T WHERE a = @a AND b = @b', {
      a: 1,
      '@b': t.nvarchar('x', 10),
    });

    expect(statement).toBe('SELECT * FROM T WHERE a = @a AND b = @b');
    expect(request.parameters.a?.value).toBe(1);
    expect(request.parameters.b).toMatchObject({ value: 'x', length: 10 });
  });

  it('expands arrays in every reference', () => {
    const { request, statement } = bind('SELECT * FROM T WHERE id IN (@ids) OR parent IN (@IDS)', {
      ids: [1, 2],
    });

    expect(statement).toBe(
      'SELECT * FROM T WHERE id IN (@ids__0, @ids__1) OR parent IN (@ids__0, @ids__1)',
    );
    expect(Object.keys(request.parameters)).toEqual(['ids__0', 'ids__1']);
  });

  it('turns an empty array into NULL so IN matches nothing', () => {
    expect(bind('SELECT * FROM T WHERE id IN (@ids)', { ids: [] }).statement).toBe(
      'SELECT * FROM T WHERE id IN (NULL)',
    );
  });

  it('does not touch array names inside strings or comments', () => {
    expect(bind("SELECT '@ids' -- @ids\nWHERE id IN (@ids)", { ids: [1] }).statement).toBe(
      "SELECT '@ids' -- @ids\nWHERE id IN (@ids__0)",
    );
  });
});

describe('assertParameters', () => {
  const check = (text: string, params: Record<string, unknown>) => () =>
    assertParameters(analyzeSql(text), params, 'query');

  it('matches names case-insensitively and with or without @', () => {
    expect(check('SELECT @TenantId, @b', { tenantid: 1, '@B': 2 })).not.toThrow();
  });

  it('lists every missing parameter', () => {
    expect(check('SELECT @a, @b, @c', { b: 1 })).toThrow(
      new SqlClientError('query is missing parameter(s): @a, @c'),
    );
  });
});

describe('nested queries', () => {
  const salesPerDay = `
    SELECT CAST(o.CreatedAt AS date) AS Day, o.StoreId, COUNT(*) AS Orders, SUM(o.Total) AS Revenue
    FROM dbo.Orders AS o
    WHERE o.CustomerId IN (
            SELECT c.Id FROM dbo.Customers AS c
            WHERE c.SegmentId IN (@segmentIds) OR c.Id IN (@customerIds)
          )
      AND (@allStores = 1 OR o.StoreId IN (@storeIds))
      AND o.CreatedAt >= @from AND o.CreatedAt < @to
    GROUP BY CAST(o.CreatedAt AS date), o.StoreId`;

  it('finds parameters at every nesting level', () => {
    expect(analyzeSql(salesPerDay).required).toEqual([
      'segmentIds',
      'customerIds',
      'allStores',
      'storeIds',
      'from',
      'to',
    ]);
  });

  it('expands arrays inside subqueries and keeps the optional-filter pattern working', () => {
    const { request, statement } = bind(salesPerDay, {
      segmentIds: [1, 2],
      customerIds: [],
      allStores: true,
      storeIds: [],
      from: new Date('2026-01-01'),
      to: new Date('2026-02-01'),
    });

    expect(statement).toContain(
      'WHERE c.SegmentId IN (@segmentIds__0, @segmentIds__1) OR c.Id IN (NULL)',
    );
    expect(statement).toContain('AND (@allStores = 1 OR o.StoreId IN (NULL))');
    expect(Object.keys(request.parameters)).toEqual([
      'segmentIds__0',
      'segmentIds__1',
      'allStores',
      'from',
      'to',
    ]);
  });
});
