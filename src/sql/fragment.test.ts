import { SqlClientError } from '../errors/SqlClientError';
import { t } from '../types/SqlParam';
import { compileFragment, isTemplateStringsArray, tsql } from './fragment';

describe('tsql / compileFragment', () => {
  it('turns every value into a numbered parameter', () => {
    const tenantId = 7;
    const name = t.nvarchar("O'Brien", 50);

    expect(
      compileFragment(tsql`SELECT * FROM T WHERE tenantId = ${tenantId} AND name = ${name}`),
    ).toEqual({
      text: 'SELECT * FROM T WHERE tenantId = @p0 AND name = @p1',
      params: { p0: 7, p1: name },
    });
  });

  it('keeps arrays as one parameter so IN expands later', () => {
    expect(compileFragment(tsql`SELECT * FROM T WHERE id IN (${[1, 2, 3]})`)).toEqual({
      text: 'SELECT * FROM T WHERE id IN (@p0)',
      params: { p0: [1, 2, 3] },
    });
  });

  it('inlines nested fragments and numbers their values in order', () => {
    const onlyActive = tsql`AND active = ${true}`;
    const { text, params } = compileFragment(
      tsql`SELECT * FROM T WHERE tenantId = ${7} ${onlyActive} AND role = ${'admin'}`,
    );

    expect(text).toBe('SELECT * FROM T WHERE tenantId = @p0 AND active = @p1 AND role = @p2');
    expect(params).toEqual({ p0: 7, p1: true, p2: 'admin' });
  });

  it('renders an empty fragment as nothing', () => {
    expect(compileFragment(tsql`SELECT 1 ${tsql``}`).text).toBe('SELECT 1 ');
  });

  it('quotes identifiers and inserts raw text as-is', () => {
    expect(
      compileFragment(
        tsql`SELECT ${tsql.id('name')} FROM ${tsql.id('dbo.Users')} ORDER BY id ${tsql.raw('DESC')}`,
      ),
    ).toEqual({
      text: 'SELECT [name] FROM [dbo].[Users] ORDER BY id DESC',
      params: {},
    });
  });

  it('joins values and fragments', () => {
    const columns = tsql.join(['id', 'name'].map(tsql.id));
    const rows = tsql.join([tsql`(${1}, ${'a'})`, tsql`(${2}, ${'b'})`]);

    expect(compileFragment(tsql`INSERT INTO T (${columns}) VALUES ${rows}`)).toEqual({
      text: 'INSERT INTO T ([id], [name]) VALUES (@p0, @p1), (@p2, @p3)',
      params: { p0: 1, p1: 'a', p2: 2, p3: 'b' },
    });
    expect(compileFragment(tsql`SELECT ${tsql.join([])}`).text).toBe('SELECT ');
    expect(compileFragment(tsql.join([tsql`a = ${1}`, tsql`b = ${2}`], ' AND ')).text).toBe(
      'a = @p0 AND b = @p1',
    );
  });

  it('rejects values inside string literals or comments', () => {
    const name = 'Ana';

    expect(() => compileFragment(tsql`SELECT * FROM T WHERE name = '${name}'`)).toThrow(
      SqlClientError,
    );
    expect(() => compileFragment(tsql`SELECT * FROM T -- ${name}`)).toThrow(
      'Template value(s) @p0 ended up inside',
    );
  });

  it('allows the same template to mention its own declared variables', () => {
    expect(compileFragment(tsql`DECLARE @limit int = ${10}; SELECT TOP (@limit) * FROM T`)).toEqual(
      {
        text: 'DECLARE @limit int = @p0; SELECT TOP (@limit) * FROM T',
        params: { p0: 10 },
      },
    );
  });
});

describe('isTemplateStringsArray', () => {
  it('recognizes tagged template strings only', () => {
    const capture = (strings: TemplateStringsArray) => strings;

    expect(isTemplateStringsArray(capture`x`)).toBe(true);
    expect(isTemplateStringsArray(['x'])).toBe(false);
    expect(isTemplateStringsArray('x')).toBe(false);
  });
});
