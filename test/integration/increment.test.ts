import { inc, t } from '../../src';
import { createClient, ddl } from './helpers';

const client = createClient();

beforeAll(async () => {
  await ddl(
    client,
    'DROP TABLE IF EXISTS dbo.AtomicCounters;',
    'CREATE TABLE dbo.AtomicCounters (id int PRIMARY KEY, count int NULL, balance decimal(18,2) NOT NULL);',
  );
});

beforeEach(async () => {
  await client.query('TRUNCATE TABLE dbo.AtomicCounters;');
  await client.insert('dbo.AtomicCounters', {
    id: 1,
    count: 0,
    balance: t.decimalExact('10.00', 18, 2),
  });
});

afterAll(async () => {
  await ddl(client, 'DROP TABLE IF EXISTS dbo.AtomicCounters;');
  await client.close();
});

it('does not lose concurrent increments', async () => {
  await Promise.all(
    Array.from({ length: 20 }, async () =>
      client.update('dbo.AtomicCounters', { count: inc() }, { id: 1 }),
    ),
  );

  expect(await client.findOne('dbo.AtomicCounters', { id: 1 }, { columns: ['count'] })).toEqual({
    count: 20,
  });
});

it('subtracts exact decimals and returns the resulting row', async () => {
  const rows = await client.update(
    'dbo.AtomicCounters',
    { count: inc(2), balance: inc(t.decimalExact('-0.01', 18, 2)) },
    { id: 1 },
    { returning: ['count'] },
  );

  expect(rows).toEqual([{ count: 2 }]);

  const { rows: balances } = await client.query(
    'SELECT CONVERT(varchar(40), balance) AS balance FROM dbo.AtomicCounters;',
  );

  expect(balances[0]?.balance).toBe('9.99');
});

it('preserves null arithmetic and empty-match behavior', async () => {
  await client.update('dbo.AtomicCounters', { count: null }, { id: 1 });

  expect(
    await client.update(
      'dbo.AtomicCounters',
      { count: inc() },
      { id: 1 },
      { returning: ['count'] },
    ),
  ).toEqual([{ count: null }]);
  expect(await client.update('dbo.AtomicCounters', { count: inc() }, { id: 99 })).toBe(0);
});

it('rolls back increments with their transaction', async () => {
  await expect(
    client.transaction(async (tx) => {
      await tx.update('dbo.AtomicCounters', { count: inc(3) }, { id: 1 });

      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');

  expect(await client.findOne('dbo.AtomicCounters', { id: 1 }, { columns: ['count'] })).toEqual({
    count: 0,
  });
});
