import type { SqlRetryEvent, SqlTransaction } from '../../src';
import { createClient, ddl } from './helpers';

const client = createClient({ retry: { delay: 50 } });

beforeAll(async () => {
  await ddl(
    client,
    'DROP TABLE IF EXISTS dbo.it_retry_a; DROP TABLE IF EXISTS dbo.it_retry_b;',
    'CREATE TABLE dbo.it_retry_a (id int PRIMARY KEY, n int NOT NULL);',
    'CREATE TABLE dbo.it_retry_b (id int PRIMARY KEY, n int NOT NULL);',
  );
});

beforeEach(async () => {
  await ddl(
    client,
    `DELETE FROM dbo.it_retry_a; DELETE FROM dbo.it_retry_b;
     INSERT INTO dbo.it_retry_a VALUES (1, 0); INSERT INTO dbo.it_retry_b VALUES (1, 0);`,
  );
});

afterAll(async () => {
  await client.close();
});

/** Locks `first`, waits, then locks `second`: two of these in opposite order deadlock. */
const lockInOrder = (first: string, second: string) => async (tx: SqlTransaction) => {
  await tx.query(`UPDATE ${first} SET n = n + 1 WHERE id = 1;`);
  await tx.query("WAITFOR DELAY '00:00:00.300';");
  await tx.query(`UPDATE ${second} SET n = n + 1 WHERE id = 1;`);
};
const counters = async () => {
  const { rows } = await client.query<{ a: number; b: number }>(
    'SELECT (SELECT n FROM dbo.it_retry_a) AS a, (SELECT n FROM dbo.it_retry_b) AS b;',
  );

  return rows[0];
};

it('a real deadlock makes one transaction fail without retry', async () => {
  const results = await Promise.allSettled([
    client.transaction(lockInOrder('dbo.it_retry_a', 'dbo.it_retry_b')),
    client.transaction(lockInOrder('dbo.it_retry_b', 'dbo.it_retry_a')),
  ]);
  const rejected = results.filter((result) => result.status === 'rejected');

  expect(rejected).toHaveLength(1);
  expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ number: 1205 });
  expect(await counters()).toEqual({ a: 1, b: 1 });
});

it('retries the deadlock victim transaction until both commit', async () => {
  const retries: SqlRetryEvent[] = [];
  const listener = (event: SqlRetryEvent) => retries.push(event);

  client.on('retry', listener);

  try {
    await Promise.all([
      client.transaction(lockInOrder('dbo.it_retry_a', 'dbo.it_retry_b'), { retry: true }),
      client.transaction(lockInOrder('dbo.it_retry_b', 'dbo.it_retry_a'), { retry: true }),
    ]);
  } finally {
    client.off('retry', listener);
  }

  expect(retries).toEqual([
    expect.objectContaining({ operation: 'transaction', attempt: 1, number: 1205 }),
  ]);
  // Each transaction applied exactly once: the victim's first attempt was rolled back.
  expect(await counters()).toEqual({ a: 2, b: 2 });
});
