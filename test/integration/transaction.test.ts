import { BatchRowError } from '../../src';
import { count, createClient, ddl } from './helpers';

const client = createClient();

beforeAll(async () => {
  await ddl(
    client,
    'DROP TABLE IF EXISTS dbo.it_tx_lines; DROP TABLE IF EXISTS dbo.it_tx_orders;',
    'CREATE TABLE dbo.it_tx_orders (id int IDENTITY(1, 1) PRIMARY KEY, customer nvarchar(20) NOT NULL);',
    `CREATE TABLE dbo.it_tx_lines (
       id int IDENTITY(1, 1) PRIMARY KEY,
       orderId int NOT NULL REFERENCES dbo.it_tx_orders (id),
       sku nvarchar(20) NOT NULL,
       CONSTRAINT it_tx_lines_sku UNIQUE (orderId, sku)
     );`,
  );
});

beforeEach(async () => {
  await ddl(client, 'DELETE FROM dbo.it_tx_lines; DELETE FROM dbo.it_tx_orders;');
});

afterAll(async () => {
  await client.close();
});

it('commits every operation together', async () => {
  const orderId = await client.transaction(async (tx) => {
    const id = await tx.insert('dbo.it_tx_orders', { customer: 'ana' });

    await tx.insertMany('dbo.it_tx_lines', [
      { orderId: id, sku: 'A' },
      { orderId: id, sku: 'B' },
    ]);

    return id;
  });

  expect(orderId).toEqual(expect.any(Number));
  expect(await count(client, 'dbo.it_tx_lines')).toBe(2);
});

it('rolls everything back when the work throws', async () => {
  await expect(
    client.transaction(async (tx) => {
      await tx.insert('dbo.it_tx_orders', { customer: 'ana' });

      throw new Error('business rule');
    }),
  ).rejects.toThrow('business rule');

  expect(await count(client, 'dbo.it_tx_orders')).toBe(0);
});

it('rolls back only the failed batch when the caller catches it, then commits the rest', async () => {
  await client.transaction(async (tx) => {
    const id = await tx.insert('dbo.it_tx_orders', { customer: 'ana' });

    await expect(
      tx.insertMany('dbo.it_tx_lines', [
        { orderId: id, sku: 'A' },
        { orderId: id, sku: 'A' },
      ]),
    ).rejects.toBeInstanceOf(BatchRowError);

    await tx.insert('dbo.it_tx_lines', { orderId: id, sku: 'C' });
  });

  expect(await count(client, 'dbo.it_tx_orders')).toBe(1);
  await expect(client.select('dbo.it_tx_lines', {}, { columns: ['sku'] })).resolves.toEqual([
    { sku: 'C' },
  ]);
});

it('isolates failed rows with savepoints in continue mode without undoing earlier work', async () => {
  await client.transaction(async (tx) => {
    const id = await tx.insert('dbo.it_tx_orders', { customer: 'ana' });
    const { inserted, failures } = await tx.insertMany(
      'dbo.it_tx_lines',
      [
        { orderId: id, sku: 'A' },
        { orderId: 999, sku: 'X' },
        { orderId: id, sku: 'B' },
      ],
      { onError: 'continue' },
    );

    expect(inserted).toBe(2);
    expect(failures).toEqual([expect.objectContaining({ index: 1, number: 547 })]);
  });

  expect(await count(client, 'dbo.it_tx_orders')).toBe(1);
  expect(await count(client, 'dbo.it_tx_lines')).toBe(2);
});

it('runs Promise.all operations one after another on the transaction connection', async () => {
  await client.transaction(async (tx) => {
    await Promise.all(
      ['a', 'b', 'c', 'd'].map(async (customer) => tx.insert('dbo.it_tx_orders', { customer })),
    );
  });

  expect(await count(client, 'dbo.it_tx_orders')).toBe(4);
});

it('applies the isolation level', async () => {
  const level = await client.transaction(
    async (tx) => {
      const { rows } = await tx.query<{ level: number }>(
        'SELECT transaction_isolation_level AS level FROM sys.dm_exec_sessions WHERE session_id = @@SPID',
      );

      return rows[0]?.level;
    },
    { isolationLevel: 'serializable' },
  );

  expect(level).toBe(4);
});
