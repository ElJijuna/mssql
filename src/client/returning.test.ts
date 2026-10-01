import sql from 'mssql';
import { type CommandContext, deleteCommand, insertCommand, updateCommand } from './commands';
import { outputClause } from './returning';

const setup = (rows: Record<string, unknown>[] = [{ id: 7, name: 'Ana' }]) => {
  const request = new sql.Request();
  const query = jest.fn().mockResolvedValue({ recordset: rows, rowsAffected: [rows.length] });
  const ctx = {
    request: () => Promise.resolve(request),
    runner: jest.fn(() => query),
  } as unknown as CommandContext;

  return { request, query, ctx };
};

describe('returning written rows', () => {
  it('inserts with a projection and bound values', async () => {
    const { ctx, request, query } = setup();
    const rows = await insertCommand(
      ctx,
      'dbo.Users',
      { name: 'Ana' },
      { returning: ['id', 'name'] },
    );

    expect(rows).toEqual([{ id: 7, name: 'Ana' }]);
    expect(query).toHaveBeenCalledWith(
      request,
      'INSERT INTO [dbo].[Users] ([name]) OUTPUT INSERTED.[id], INSERTED.[name] VALUES (@p0);',
    );
    expect(request.parameters.p0?.value).toBe('Ana');
  });

  it('supports DEFAULT VALUES and all columns', async () => {
    const { ctx, request, query } = setup();

    await insertCommand(ctx, 'Users', {}, { returning: true });

    expect(query).toHaveBeenCalledWith(
      request,
      'INSERT INTO [Users] OUTPUT INSERTED.* DEFAULT VALUES;',
    );
  });

  it('returns updated values with collision-free filter bindings', async () => {
    const { ctx, request, query } = setup();

    await updateCommand(ctx, 'Users', { name: 'Ana' }, { id: 7 }, { returning: true });

    expect(query).toHaveBeenCalledWith(
      request,
      'UPDATE [Users] SET [name] = @p0 OUTPUT INSERTED.* WHERE [id] = @p1;',
    );
    expect(request.parameters.p1?.value).toBe(7);
  });

  it('returns deleted values and empty arrays for no matches', async () => {
    const { ctx, request, query } = setup([]);

    expect(await deleteCommand(ctx, 'Users', { id: 7 }, { returning: ['id'] })).toEqual([]);
    expect(query).toHaveBeenCalledWith(
      request,
      'DELETE FROM [Users] OUTPUT DELETED.[id] WHERE [id] = @p0;',
    );
  });

  it('keeps safeguards for updates and deletes', async () => {
    const { ctx } = setup();

    await expect(
      updateCommand(ctx, 'Users', { name: 'Ana' }, {}, { returning: true }),
    ).rejects.toThrow('non-empty');
    await expect(updateCommand(ctx, 'Users', {}, { id: 7 }, { returning: true })).rejects.toThrow(
      'at least one',
    );
    await expect(deleteCommand(ctx, 'Users', {}, { returning: true })).rejects.toThrow('non-empty');
  });

  it('quotes output identifiers', () => {
    expect(outputClause('INSERTED', ['a]b'])).toBe(' OUTPUT INSERTED.[a]]b]');
  });

  it.each([[], ['id', 'id'], ['dbo.id'], [''], false, 'id'])(
    'rejects invalid projection %p',
    (returning) => {
      expect(() => outputClause('INSERTED', returning as true | string[])).toThrow('returning');
    },
  );
});
