import { SqlAbortError } from '../../src';
import { count, createClient, ddl } from './helpers';

const client = createClient();

beforeAll(async () => {
  await ddl(
    client,
    'DROP TABLE IF EXISTS dbo.it_cancel; CREATE TABLE dbo.it_cancel (id int PRIMARY KEY);',
  );
});

afterAll(async () => {
  await client.close();
});

it('cancels a slow query on timeout and the pool keeps working', async () => {
  const started = Date.now();

  await expect(
    client.query("WAITFOR DELAY '00:00:10'; SELECT 1 AS done;", {}, { timeout: 300 }),
  ).rejects.toMatchObject({
    name: 'SqlAbortError',
    reason: 'timeout',
  });
  expect(Date.now() - started).toBeLessThan(5_000);

  await expect(client.query('SELECT 1 AS ok')).resolves.toMatchObject({ rows: [{ ok: 1 }] });
});

it('cancels a running query when the signal aborts', async () => {
  const controller = new AbortController();
  const running = client.query("WAITFOR DELAY '00:00:10'", {}, { signal: controller.signal });

  setTimeout(() => {
    controller.abort();
  }, 200);

  await expect(running).rejects.toBeInstanceOf(SqlAbortError);
});

it('rolls back a transaction that times out', async () => {
  await expect(
    client.transaction(
      async (tx) => {
        await tx.insert('dbo.it_cancel', { id: 1 });
        await tx.query("WAITFOR DELAY '00:00:10'");
      },
      { timeout: 500 },
    ),
  ).rejects.toMatchObject({ reason: 'timeout', operation: 'transaction' });

  expect(await count(client, 'dbo.it_cancel')).toBe(0);
});
