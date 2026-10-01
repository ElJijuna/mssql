import sql from 'mssql';
import type { CommandContext } from './commands';
import { buildPage, type PageOptions, pageCommand } from './page';

const options: PageOptions = { orderBy: { score: 'desc' }, key: 'id', limit: 2 };
const build = (overrides: Partial<PageOptions> = {}) =>
  buildPage('Users', { ...options, ...overrides }, new sql.Request());

describe('cursor pagination', () => {
  it('fetches an extra row and appends a unique tie-breaker', () => {
    expect(build().statement).toBe(
      'SELECT TOP (3) * FROM [Users] ORDER BY [score] DESC, [id] ASC;',
    );
    expect(build({ limit: undefined }).limit).toBe(50);
  });

  it('binds filters and cursor values without collisions', () => {
    const request = new sql.Request();
    const result = buildPage(
      'Users',
      {
        ...options,
        where: { tenant: 7 },
        after: {
          table: 'Users',
          order: [
            ['score', 'desc'],
            ['id', 'asc'],
          ],
          values: [10, 3],
        },
      },
      request,
    );

    expect(result.statement).toContain('([score] < @p1 OR [score] IS NULL)');
    expect(result.statement).toContain('[score] = @p1 AND [id] > @p2');
    expect(Object.values(request.parameters).map((param): unknown => param.value)).toEqual([
      7, 10, 3,
    ]);
  });

  it.each(['asc', 'desc'] as const)('handles nulls in %s order', (direction) => {
    const result = build({
      orderBy: { score: direction },
      after: {
        table: 'Users',
        order: [
          ['score', direction],
          ['id', 'asc'],
        ],
        values: [null, 3],
      },
    });

    expect(result.statement).toContain(direction === 'asc' ? '[score] IS NOT NULL' : '1 = 0');
    expect(result.statement).toContain('[score] IS NULL AND [id] > @p1');
  });

  it('supports composite keys and projection', () => {
    expect(
      build({ orderBy: [], key: ['tenant', 'id'], columns: ['tenant', 'id'] }).statement,
    ).toContain('[tenant], [id]');
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2147483647])('rejects invalid limit %p', (limit) => {
    expect(() => build({ limit })).toThrow('Page limit');
  });

  it.each([
    { key: [] },
    { key: '' },
    { orderBy: ['id', 'id'] },
    { orderBy: 'dbo.id' },
    { columns: ['id'] },
    { orderBy: { id: 'invalid' } },
    { after: { table: 'Other', order: [], values: [] } },
    {
      after: {
        table: 'Users',
        order: [
          ['score', 'desc'],
          ['id', 'asc'],
        ],
        values: [10],
      },
    },
  ])('rejects invalid options %p', (invalid) => {
    expect(() => build(invalid as Partial<PageOptions>)).toThrow();
  });

  it.each(
    [
      [],
      [{ id: 1, score: 10 }],
      [
        { id: 1, score: 10 },
        { id: 2, score: 10 },
      ],
      [
        { id: 1, score: 10 },
        { id: 2, score: 10 },
        { id: 3, score: 9 },
      ],
    ].map((recordset) => ({ recordset })),
  )('returns rows and continuation for %p', async ({ recordset }) => {
    const runner = jest.fn().mockResolvedValue({ recordset });
    const ctx = {
      request: () => Promise.resolve(new sql.Request()),
      runner: jest.fn(() => runner),
    } as unknown as CommandContext;
    const result = await pageCommand(ctx, 'Users', options);

    expect(result.rows).toEqual(recordset.slice(0, 2));
    expect(result.hasMore).toBe(recordset.length > 2);
    expect(result.nextCursor).toEqual(
      recordset.length > 2
        ? {
            table: 'Users',
            order: [
              ['score', 'desc'],
              ['id', 'asc'],
            ],
            values: [10, 2],
          }
        : null,
    );
    expect(ctx.runner).toHaveBeenCalledWith('page', options);
  });
});
