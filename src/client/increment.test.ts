import sql from 'mssql';
import { bindInput, inc, SqlIncrement, SqlParam, t } from '../types/SqlParam';
import { type CommandContext, insertCommand, updateCommand } from './commands';

const setup = () => {
  const request = new sql.Request();
  const query = jest.fn().mockResolvedValue({ recordset: [{ count: 3 }], rowsAffected: [1] });
  const ctx = {
    request: () => Promise.resolve(request),
    runner: () => query,
  } as unknown as CommandContext;

  return { request, query, ctx };
};

describe('atomic increments', () => {
  it('defaults to one and accepts zero and negative amounts', () => {
    expect(inc().amount).toBe(1);
    expect(inc(0).amount).toBe(0);
    expect(inc(-2).amount).toBe(-2);
  });

  it('combines increments and replacements in one update', async () => {
    const { ctx, query, request } = setup();

    expect(
      await updateCommand(
        ctx,
        'dbo.Counters',
        { count: inc(2), name: 'Ana', balance: inc(-3) },
        { id: 7 },
        {},
      ),
    ).toBe(1);
    expect(query).toHaveBeenCalledWith(
      request,
      'UPDATE [dbo].[Counters] SET [count] = [count] + @p0, [name] = @p1, [balance] = [balance] + @p2 WHERE [id] = @p3;',
    );
    expect(request.parameters.p0?.value).toBe(2);
    expect(request.parameters.p3?.value).toBe(7);
  });

  it('supports exact decimal and bigint amounts with returning', async () => {
    const { ctx, query, request } = setup();

    expect(
      await updateCommand(
        ctx,
        'Counters',
        { balance: inc(t.decimalExact('0.01', 18, 2)), count: inc(9007199254740993n) },
        { id: 1 },
        { returning: true },
      ),
    ).toEqual([{ count: 3 }]);
    expect(query).toHaveBeenCalledWith(
      request,
      expect.stringContaining('[balance] + CONVERT(decimal(18, 2), @p0)'),
    );
    expect(request.parameters.p1?.value).toBe('9007199254740993');
  });

  it('quotes the destination column', async () => {
    const { ctx, query, request } = setup();

    await updateCommand(ctx, 'Counters', { 'a]b': inc() }, { id: 1 }, {});

    expect(query).toHaveBeenCalledWith(request, expect.stringContaining('[a]]b] = [a]]b] + @p0'));
  });

  it.each([
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    '2',
    true,
    {},
    t.int(null),
    t.nvarchar('2', 10),
    t.bit(true),
  ])('rejects invalid amount %p', (amount) => {
    expect(() => inc(amount as number)).toThrow();
  });

  it.each([
    t.int(2),
    t.bigint('9007199254740993'),
    t.decimal(1.5, 10, 2),
    t.numericExact('-1.25', 10, 2),
    0.5,
  ])('accepts numeric amount %p', (amount) => {
    expect(inc(amount)).toBeInstanceOf(SqlIncrement);
  });

  it('rejects expression use outside update values', async () => {
    const { ctx, request, query } = setup();

    expect(() => bindInput(request, 'p0', inc())).toThrow('only in update');
    await expect(insertCommand(ctx, 'Counters', { count: inc() }, {})).rejects.toThrow(
      'only in update',
    );
    await expect(updateCommand(ctx, 'Counters', { count: 1 }, { id: inc() }, {})).rejects.toThrow(
      'only in update',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('validates manually constructed numeric parameters', () => {
    expect(() => inc(new SqlParam(sql.Int(), 'oops'))).toThrow();
  });
});
