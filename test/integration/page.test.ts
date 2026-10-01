import type { SqlCursor } from '../../src';
import { createClient, ddl } from './helpers';

const client = createClient();

beforeAll(async () => {
  await ddl(
    client,
    'DROP TABLE IF EXISTS dbo.CursorPages;',
    'CREATE TABLE dbo.CursorPages (id int PRIMARY KEY, score int NULL, tenant int NOT NULL);',
  );
  await client.insertMany('dbo.CursorPages', [
    { id: 1, score: null, tenant: 7 },
    { id: 2, score: 10, tenant: 7 },
    { id: 3, score: 10, tenant: 7 },
    { id: 4, score: 20, tenant: 7 },
    { id: 5, score: 10, tenant: 8 },
  ]);
});

afterAll(async () => {
  await ddl(client, 'DROP TABLE IF EXISTS dbo.CursorPages;');
  await client.close();
});

it.each(['asc', 'desc'] as const)(
  'traverses ties, nulls and filters in %s order',
  async (direction) => {
    const ids: number[] = [];

    let after: SqlCursor | undefined;

    do {
      const page = await client.page<{ id: number; score: number | null }>('dbo.CursorPages', {
        orderBy: { score: direction },
        key: 'id',
        where: { tenant: 7 },
        limit: 1,
        after,
      });

      ids.push(...page.rows.map((row) => row.id));
      after = page.nextCursor ?? undefined;
    } while (after);

    expect(ids).toEqual(direction === 'asc' ? [1, 2, 3, 4] : [4, 2, 3, 1]);
  },
);

it('uses the transaction connection', async () => {
  await client.transaction(async (tx) => {
    const page = await tx.page('dbo.CursorPages', { orderBy: 'id', key: 'id', limit: 2 });

    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });
});
