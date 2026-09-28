import sql from 'mssql';
import { SqlClientError } from '../errors/SqlClientError';
import { buildSelect, orderByClause } from './select';

const build = (where: Record<string, unknown>, options: Parameters<typeof buildSelect>[2] = {}) =>
  buildSelect('dbo.Users', where, options, new sql.Request());

describe('buildSelect', () => {
  it('selects every column of every row by default', () => {
    expect(build({})).toBe('SELECT * FROM [dbo].[Users];');
  });

  it('filters, picks columns and orders', () => {
    expect(
      build({ active: true }, { columns: ['id', 'name'], orderBy: { name: 'asc', id: 'desc' } }),
    ).toBe(
      'SELECT [id], [name] FROM [dbo].[Users] WHERE [active] = @p0 ORDER BY [name] ASC, [id] DESC;',
    );
  });

  it('uses TOP for a limit without offset', () => {
    expect(build({}, { limit: 10 })).toBe('SELECT TOP (10) * FROM [dbo].[Users];');
  });

  it('uses OFFSET / FETCH for pages', () => {
    expect(build({}, { orderBy: 'id', limit: 20, offset: 40 })).toBe(
      'SELECT * FROM [dbo].[Users] ORDER BY [id] ASC OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY;',
    );
    expect(build({}, { orderBy: 'id', offset: 5 })).toBe(
      'SELECT * FROM [dbo].[Users] ORDER BY [id] ASC OFFSET 5 ROWS;',
    );
  });

  it('requires orderBy for offset', () => {
    expect(() => build({}, { offset: 10 })).toThrow('`offset` requires `orderBy`');
  });

  it.each([-1, 1.5, Number.NaN])('rejects invalid limit %p', (limit) => {
    expect(() => build({}, { limit })).toThrow(SqlClientError);
  });

  it('binds the where values on the request', () => {
    const request = new sql.Request();

    buildSelect('Users', { id: 7 }, {}, request);

    expect(request.parameters.p0?.value).toBe(7);
  });
});

describe('orderByClause', () => {
  it.each([
    [undefined, ''],
    ['name', ' ORDER BY [name] ASC'],
    [['last', 'first'], ' ORDER BY [last] ASC, [first] ASC'],
    [{ createdAt: 'desc' as const }, ' ORDER BY [createdAt] DESC'],
    [[], ''],
  ])('builds %p', (orderBy, expected) => {
    expect(orderByClause(orderBy)).toBe(expected);
  });

  it('rejects invalid directions', () => {
    expect(() => orderByClause({ id: 'up' as 'asc' })).toThrow(
      'Invalid sort direction "up" for "id"',
    );
  });
});
