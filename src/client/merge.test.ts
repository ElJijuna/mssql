import type sql from 'mssql';
import { buildMergeStatement, missingKey, normalizeKeys } from './merge';

const fakeRequest = () => ({ input: jest.fn() }) as unknown as sql.Request;

describe('buildMergeStatement', () => {
  const row = { tenant: 1, code: 'A', name: 'Alpha', price: 10 };

  it('updates non-key columns when the row exists, inserts otherwise', () => {
    const statement = buildMergeStatement('dbo.Items', ['tenant', 'code'], undefined)(
      row,
      fakeRequest(),
      0,
    );

    expect(statement).toBe(
      'IF EXISTS (SELECT 1 FROM [dbo].[Items] WITH (UPDLOCK, SERIALIZABLE) WHERE [tenant] = @p0 AND [code] = @p1) ' +
        "BEGIN UPDATE [dbo].[Items] SET [name] = @p2, [price] = @p3 WHERE [tenant] = @p0 AND [code] = @p1; INSERT INTO @_out VALUES (@_i, 'updated', NULL); END " +
        "ELSE BEGIN INSERT INTO [dbo].[Items] ([tenant], [code], [name], [price]) VALUES (@p0, @p1, @p2, @p3); INSERT INTO @_out VALUES (@_i, 'inserted', SCOPE_IDENTITY()); END;",
    );
  });

  it('only updates the listed columns', () => {
    const statement = buildMergeStatement('Items', ['code'], ['price'])(row, fakeRequest(), 0);

    expect(statement).toContain('SET [price] = @p3 WHERE');
  });

  it('skips existing rows when update is false', () => {
    const statement = buildMergeStatement('Items', ['code'], false)(row, fakeRequest(), 0);

    expect(statement).not.toContain('UPDATE');
    expect(statement).toContain("INSERT INTO @_out VALUES (@_i, 'skipped', NULL);");
  });

  it('skips existing rows when the row only has key columns', () => {
    expect(
      buildMergeStatement('Items', ['code'], undefined)({ code: 'A' }, fakeRequest(), 0),
    ).toContain("'skipped'");
  });
});

describe('missingKey', () => {
  it('reports missing key columns', () => {
    expect(missingKey(['a', 'b'])({ a: 1 })).toBe('Missing key column(s): b');
    expect(missingKey(['a'])({ a: null })).toBeNull();
  });
});

describe('normalizeKeys', () => {
  it('accepts a single key or a list', () => {
    expect(normalizeKeys('id')).toEqual(['id']);
    expect(normalizeKeys(['a', 'b'])).toEqual(['a', 'b']);
  });
});
