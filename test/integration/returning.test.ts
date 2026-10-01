import { createClient, ddl } from './helpers';

const client = createClient();

beforeAll(async () => {
  await ddl(
    client,
    'DROP TABLE IF EXISTS dbo.ReturningRows;',
    `CREATE TABLE dbo.ReturningRows (
    id int IDENTITY PRIMARY KEY,
    name nvarchar(100) NOT NULL DEFAULT N'Guest',
    nameLength AS LEN(name),
    version rowversion
  );`,
  );
});

beforeEach(async () => {
  await client.query('TRUNCATE TABLE dbo.ReturningRows;');
});

afterAll(async () => {
  await ddl(client, 'DROP TABLE IF EXISTS dbo.ReturningRows;');
  await client.close();
});

it('returns identities, defaults, computed values and rowversion in one write', async () => {
  const [row] = await client.insert<{
    id: number;
    name: string;
    nameLength: number;
    version: Buffer;
  }>('dbo.ReturningRows', {}, { returning: true });

  expect(row).toMatchObject({ id: 1, name: 'Guest', nameLength: 5 });
  expect(Buffer.isBuffer(row?.version)).toBe(true);
});

it('returns all affected rows, old deleted values and empty results', async () => {
  await client.insertMany('dbo.ReturningRows', [{ name: 'Ana' }, { name: 'Luis' }]);

  const updated = await client.update<{ id: number; name: string }>(
    'dbo.ReturningRows',
    { name: 'Changed' },
    { id: [1, 2] },
    { returning: ['id', 'name'] },
  );

  expect(updated.map((row) => row.id).sort()).toEqual([1, 2]);
  expect(updated.every((row) => row.name === 'Changed')).toBe(true);

  const deleted = await client.delete('dbo.ReturningRows', { id: [1, 2] }, { returning: ['name'] });

  expect(deleted).toEqual([{ name: 'Changed' }, { name: 'Changed' }]);
  expect(
    await client.update('dbo.ReturningRows', { name: 'Nobody' }, { id: 99 }, { returning: true }),
  ).toEqual([]);
  expect(await client.delete('dbo.ReturningRows', { id: 99 }, { returning: true })).toEqual([]);
});

it('does not commit a returned row when the surrounding transaction rolls back', async () => {
  await expect(
    client.transaction(async (tx) => {
      const rows = await tx.insert(
        'dbo.ReturningRows',
        { name: 'Rollback' },
        { returning: ['id'] },
      );

      expect(rows).toHaveLength(1);

      throw new Error('rollback requested');
    }),
  ).rejects.toThrow('rollback requested');

  expect(await client.select('dbo.ReturningRows')).toEqual([]);
});
