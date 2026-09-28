import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, tsql } from '../../src';
import { createClient, ddl } from './helpers';

const client = createClient();

let sqlDir: string | undefined;

beforeAll(async () => {
  await ddl(
    client,
    'DROP TABLE IF EXISTS dbo.it_raw_orders; DROP TABLE IF EXISTS dbo.it_raw_customers;',
    'CREATE TABLE dbo.it_raw_customers (id int PRIMARY KEY, segmentId int NOT NULL);',
    `CREATE TABLE dbo.it_raw_orders (
       id int IDENTITY(1, 1) PRIMARY KEY,
       customerId int NOT NULL,
       storeId int NOT NULL,
       total decimal(10, 2) NOT NULL,
       createdAt datetime2(3) NOT NULL
     );`,
    `INSERT INTO dbo.it_raw_customers (id, segmentId) VALUES (1, 10), (2, 10), (3, 20), (4, 30);
     INSERT INTO dbo.it_raw_orders (customerId, storeId, total, createdAt) VALUES
       (1, 1, 10, '2026-01-01T10:00:00'), (2, 1, 5, '2026-01-01T12:00:00'), (3, 2, 7, '2026-01-02T09:00:00'),
       (4, 2, 99, '2026-01-02T09:00:00'), (1, 3, 1, '2026-02-10T09:00:00');`,
    'DROP PROCEDURE IF EXISTS dbo.it_raw_customer_stats;',
    `CREATE PROCEDURE dbo.it_raw_customer_stats @customerId int, @orders int OUTPUT, @label nvarchar(50) OUTPUT AS
     BEGIN
       SET NOCOUNT ON;
       SELECT id, total FROM dbo.it_raw_orders WHERE customerId = @customerId ORDER BY id;
       SELECT SUM(total) AS amount FROM dbo.it_raw_orders WHERE customerId = @customerId;
       SELECT @orders = COUNT(*) FROM dbo.it_raw_orders WHERE customerId = @customerId;
       SET @label = CONCAT(@label, N' #', @customerId);
       RETURN 7;
     END;`,
  );

  sqlDir = await mkdtemp(join(tmpdir(), 'pilmee-mssql-it-'));
  await mkdir(join(sqlDir, 'reports'));
  await writeFile(
    join(sqlDir, 'reports', 'sales-per-day.sql'),
    `-- Orders and revenue per day and store, for customers in the given segments (or picked one by one).
     DECLARE @minTotal decimal(10, 2) = 0;
     SELECT CAST(o.createdAt AS date) AS day, o.storeId, COUNT(*) AS orders, SUM(o.total) AS revenue
     FROM dbo.it_raw_orders AS o
     WHERE o.customerId IN (
             SELECT c.id FROM dbo.it_raw_customers AS c
             WHERE c.segmentId IN (@segmentIds) OR c.id IN (@customerIds)
           )
       AND (@allStores = 1 OR o.storeId IN (@storeIds))
       AND o.createdAt >= @from AND o.createdAt < @to
       AND o.total >= @minTotal
     GROUP BY CAST(o.createdAt AS date), o.storeId
     ORDER BY day, o.storeId;`,
  );
});

afterAll(async () => {
  await client.close();

  if (sqlDir) {
    await rm(sqlDir, { recursive: true, force: true });
  }
});

describe('exec', () => {
  it('returns every result set, typed outputs and the return value', async () => {
    const { rows, recordsets, output, returnValue } = await client.exec<{
      id: number;
      total: number;
    }>(
      'dbo.it_raw_customer_stats',
      { customerId: 1 },
      { output: { orders: t.int(null), label: t.nvarchar('customer', 50) } },
    );

    expect(rows).toEqual([
      { id: 1, total: 10 },
      { id: 5, total: 1 },
    ]);
    expect(recordsets[1]).toEqual([{ amount: 11 }]);
    expect(output).toEqual({ orders: 2, label: 'customer #1' });
    expect(returnValue).toBe(7);
  });
});

describe('query / queryFile', () => {
  it('expands arrays and ignores declared variables', async () => {
    const { rows } = await client.query<{ id: number }>(
      'DECLARE @limit int = 2; SELECT TOP (@limit) id FROM dbo.it_raw_customers WHERE id IN (@ids) ORDER BY id DESC;',
      { ids: [1, 2, 3] },
    );

    expect(rows).toEqual([{ id: 3 }, { id: 2 }]);
  });

  it('runs a nested report from a file with optional filters', async () => {
    const fileClient = createClient({ sqlDir: sqlDir ?? '.' });

    try {
      const params = {
        segmentIds: [10],
        customerIds: [3],
        from: t.datetime2(new Date('2026-01-01T00:00:00Z'), 3),
        to: t.datetime2(new Date('2026-02-01T00:00:00Z'), 3),
      };
      const all = await fileClient.queryFile('reports/sales-per-day', {
        ...params,
        allStores: true,
        storeIds: [],
      });
      const store1 = await fileClient.queryFile('reports/sales-per-day', {
        ...params,
        allStores: false,
        storeIds: [1],
      });

      expect(all.rows).toEqual([
        { day: new Date('2026-01-01T00:00:00Z'), storeId: 1, orders: 2, revenue: 15 },
        { day: new Date('2026-01-02T00:00:00Z'), storeId: 2, orders: 1, revenue: 7 },
      ]);
      expect(store1.rows).toHaveLength(1);
    } finally {
      await fileClient.close();
    }
  });
});

describe('tagged templates', () => {
  it('runs a parameterized, composed query on the server', async () => {
    const segment = 10;
    const extraCustomers = [3];
    const onlyBigOrders = (min: number) => tsql`AND o.total >= ${t.decimal(min, 10, 2)}`;
    const { rows } = await client.query<{ customerId: number; orders: number }>`
      SELECT o.customerId, COUNT(*) AS orders
      FROM ${tsql.id('dbo.it_raw_orders')} AS o
      WHERE o.customerId IN (
              SELECT c.id FROM dbo.it_raw_customers AS c
              WHERE c.segmentId = ${segment} OR c.id IN (${extraCustomers})
            )
        ${onlyBigOrders(5)}
      GROUP BY o.customerId
      ORDER BY o.customerId ${tsql.raw('ASC')}`;

    expect(rows).toEqual([
      { customerId: 1, orders: 1 },
      { customerId: 2, orders: 1 },
      { customerId: 3, orders: 1 },
    ]);
  });

  it('sends values as parameters, never as SQL', async () => {
    const attack = "x'; DROP TABLE dbo.it_raw_orders; --";
    const { rows } =
      await client.query`SELECT COUNT(*) AS total FROM dbo.it_raw_customers WHERE CAST(id AS nvarchar(50)) = ${attack}`;

    expect(rows).toEqual([{ total: 0 }]);
    await expect(
      client.query('SELECT COUNT(*) AS total FROM dbo.it_raw_orders'),
    ).resolves.toMatchObject({
      rows: [{ total: 5 }],
    });
  });
});
