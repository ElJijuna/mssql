import { SqlQueryCatalog } from '../../src';
import { createClient } from './helpers';

const sqlCatalog = SqlQueryCatalog.fromQueries({
  'math/add': 'SELECT @left + @right AS total;',
  'math/sets': 'SELECT @value AS first; SELECT @value + 1 AS second;',
});
const client = createClient({ sqlCatalog });

afterAll(async () => {
  await client.close();
});

it('executes named queries with bound parameters', async () => {
  const result = await client.queryNamed<{ total: number }>('math/add', { left: 2, right: 3 });

  expect(result.rows).toEqual([{ total: 5 }]);
});

it('returns multiple result sets inside a transaction', async () => {
  const result = await client.transaction(async (tx) => tx.queryNamed('math/sets', { value: 7 }));

  expect(result.recordsets).toEqual([[{ first: 7 }], [{ second: 8 }]]);
});
