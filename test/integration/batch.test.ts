import { BatchRowError, type SqlClient, t } from '../../src';
import { count, createClient, ddl } from './helpers';

const client = createClient();

interface Product {
  id: number;
  sku: string;
  name: string;
  price: number;
  stock: number;
}

beforeAll(async () => {
  await ddl(
    client,
    'DROP TABLE IF EXISTS dbo.it_batch_products;',
    `CREATE TABLE dbo.it_batch_products (
       id int IDENTITY(1, 1) PRIMARY KEY,
       storeId int NOT NULL DEFAULT 1,
       sku nvarchar(20) NOT NULL,
       name nvarchar(50) NOT NULL,
       price decimal(10, 2) NOT NULL DEFAULT 0,
       stock tinyint NOT NULL DEFAULT 0,
       CONSTRAINT it_batch_products_sku UNIQUE (storeId, sku)
     );`,
  );
});

beforeEach(async () => {
  await ddl(client, 'TRUNCATE TABLE dbo.it_batch_products;');
});

afterAll(async () => {
  await client.close();
});

const rows = (count_: number, from = 0) =>
  Array.from({ length: count_ }, (_, i) => ({
    sku: `SKU-${String(from + i)}`,
    name: `Product ${String(from + i)}`,
  }));

describe('insertMany', () => {
  it('inserts every row across chunks and returns aligned ids', async () => {
    const { inserted, ids, failures } = await client.insertMany('dbo.it_batch_products', rows(25), {
      chunkSize: 10,
    });

    expect(inserted).toBe(25);
    expect(failures).toEqual([]);
    expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('saves nothing and reports the failing row in rollback mode', async () => {
    const input = [...rows(3), { sku: 'SKU-1', name: 'Duplicate' }, ...rows(2, 10)];

    let error: unknown;

    try {
      await client.insertMany('dbo.it_batch_products', input, { chunkSize: 2 });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BatchRowError);
    expect(error).toMatchObject({
      index: 3,
      number: 2627,
      row: { sku: 'SKU-1', name: 'Duplicate' },
    });
    expect(await count(client, 'dbo.it_batch_products')).toBe(0);
  });

  it('keeps the valid rows and reports the rest in continue mode', async () => {
    const { inserted, ids, failures } = await client.insertMany(
      'dbo.it_batch_products',
      [
        { sku: 'A', name: 'Ok' },
        { sku: 'A', name: 'Duplicate' },
        { sku: 'B', name: null },
        { sku: 'C', name: 'Ok' },
      ],
      { onError: 'continue' },
    );

    expect(inserted).toBe(2);
    expect(ids[0]).toEqual(expect.any(Number));
    expect(ids.slice(1, 3)).toEqual([null, null]);
    expect(failures.map(({ index, number }) => [index, number])).toEqual([
      [1, 2627],
      [2, 515],
    ]);
    expect(await count(client, 'dbo.it_batch_products')).toBe(2);
  });

  it('retries row by row when the driver rejects a value of the chunk', async () => {
    const { inserted, failures } = await client.insertMany(
      'dbo.it_batch_products',
      [
        { sku: 'A', name: 'Ok', stock: t.tinyint(5) },
        { sku: 'B', name: 'Too much stock', stock: t.tinyint(300) },
        { sku: 'C', name: 'Ok', stock: t.tinyint(7) },
      ],
      { onError: 'continue' },
    );

    expect(inserted).toBe(2);
    expect(failures).toEqual([expect.objectContaining({ index: 1, number: null })]);
  });

  it('reports every row when the chunk has an unknown column', async () => {
    const { inserted, failures } = await client.insertMany(
      'dbo.it_batch_products',
      [
        { sku: 'A', name: 'Ok' },
        { sku: 'B', name: 'Bad', color: 'red' },
      ],
      { onError: 'continue' },
    );

    expect(inserted).toBe(1);
    expect(failures).toEqual([expect.objectContaining({ index: 1, number: 207 })]);
  });
});

describe('merge', () => {
  it('inserts missing rows, updates existing ones and skips unchanged', async () => {
    await client.insertMany('dbo.it_batch_products', [{ sku: 'A', name: 'Old A', price: 1 }]);

    const result = await client.merge(
      'dbo.it_batch_products',
      [
        { sku: 'A', name: 'New A', price: t.decimal(9.99, 10, 2) },
        { sku: 'B', name: 'New B', price: t.decimal(5.5, 10, 2) },
        { sku: 'A' },
      ],
      { on: 'sku' },
    );

    expect(result).toMatchObject({
      inserted: 1,
      updated: 1,
      skipped: 1,
      actions: ['updated', 'inserted', 'skipped'],
    });
    expect(result.ids[1]).toEqual(expect.any(Number));
    await expect(
      client.select<Product>(
        'dbo.it_batch_products',
        {},
        { columns: ['sku', 'name', 'price'], orderBy: 'sku' },
      ),
    ).resolves.toEqual([
      { sku: 'A', name: 'New A', price: 9.99 },
      { sku: 'B', name: 'New B', price: 5.5 },
    ]);
  });

  it('supports composite keys, limited update columns and insert-only', async () => {
    await client.insertMany('dbo.it_batch_products', [
      { storeId: 1, sku: 'A', name: 'Keep', price: 1 },
    ]);

    await client.merge(
      'dbo.it_batch_products',
      [
        { storeId: 1, sku: 'A', name: 'Ignored', price: 2 },
        { storeId: 2, sku: 'A', name: 'Store 2', price: 3 },
      ],
      {
        on: ['storeId', 'sku'],
        update: ['price'],
      },
    );
    const insertOnly = await client.merge(
      'dbo.it_batch_products',
      [{ storeId: 1, sku: 'A', name: 'Nope' }],
      {
        on: ['storeId', 'sku'],
        update: false,
      },
    );

    expect(insertOnly.actions).toEqual(['skipped']);
    await expect(
      client.select(
        'dbo.it_batch_products',
        {},
        { columns: ['storeId', 'name', 'price'], orderBy: 'storeId' },
      ),
    ).resolves.toEqual([
      { storeId: 1, name: 'Keep', price: 2 },
      { storeId: 2, name: 'Store 2', price: 3 },
    ]);
  });

  it('never inserts the same key twice under concurrency', async () => {
    const clients: SqlClient[] = Array.from({ length: 5 }, () => createClient());

    try {
      const results = await Promise.all(
        clients.map(async (other, i) =>
          other.merge('dbo.it_batch_products', [{ sku: 'RACE', name: `Writer ${String(i)}` }], {
            on: 'sku',
          }),
        ),
      );

      expect(results.filter((result) => result.inserted === 1)).toHaveLength(1);
      expect(results.filter((result) => result.updated === 1)).toHaveLength(4);
      expect(await count(client, 'dbo.it_batch_products')).toBe(1);
    } finally {
      await Promise.all(clients.map(async (other) => other.close()));
    }
  });
});
