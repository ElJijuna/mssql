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
