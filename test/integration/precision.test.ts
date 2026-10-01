import { SqlClientError, t } from '../../src';
import { createClient, ddl } from './helpers';

const client = createClient();
const amount = '12345678901234567890.123456789012345678';

beforeAll(async () => {
  await ddl(
    client,
    'DROP TABLE IF EXISTS dbo.it_precision;',
    'CREATE TABLE dbo.it_precision (id bigint IDENTITY(9007199254740993, 1) PRIMARY KEY, code int NOT NULL UNIQUE, amount decimal(38,18));',
  );
});

afterAll(async () => {
  await client.close();
});

it('preserves identity and decimal precision across single, batch, merge, and transaction writes', async () => {
  await expect(
    client.insert('dbo.it_precision', { code: 1, amount: t.decimalExact(amount, 38, 18) }),
  ).resolves.toBe('9007199254740993');
  await expect(
    client.insertMany('dbo.it_precision', [{ code: 2, amount: t.numericExact(amount, 38, 18) }]),
  ).resolves.toMatchObject({ ids: ['9007199254740994'] });
  await expect(
    client.merge('dbo.it_precision', [{ code: 3, amount: t.decimalExact(amount, 38, 18) }], {
      on: 'code',
    }),
  ).resolves.toMatchObject({ ids: ['9007199254740995'] });
  await expect(
    client.transaction(async (tx) =>
      tx.insert('dbo.it_precision', { code: 4, amount: t.decimalExact(amount, 38, 18) }),
    ),
  ).resolves.toBe('9007199254740996');

  const { rows } = await client.query<{ id: string; amount: string }>(
    'SELECT CONVERT(varchar(40), id) AS id, CONVERT(varchar(50), amount) AS amount FROM dbo.it_precision ORDER BY code;',
  );

  expect(rows).toEqual(
    ['9007199254740993', '9007199254740994', '9007199254740995', '9007199254740996'].map((id) => ({
      id,
      amount,
    })),
  );
});

it('round-trips BIGINT limits and exact decimals without JS number conversion', async () => {
  const { rows } = await client.query<{ id: string; amount: string }>(
    'SELECT CONVERT(varchar(40), @id) AS id, CONVERT(varchar(50), @amount) AS amount;',
    { id: t.bigint(9223372036854775807n), amount: t.decimalExact(amount, 38, 18) },
  );

  expect(rows).toEqual([{ id: '9223372036854775807', amount }]);
});

it('normalizes real SQL Server errors without losing their number', async () => {
  let caught: unknown;

  try {
    await client.query("THROW 50001, 'precision contract test', 1;");
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(SqlClientError);
  expect(caught).toMatchObject({
    code: 'SQL_QUERY_ERROR',
    driverCode: 'EREQUEST',
    number: 50001,
    operation: 'query',
    cause: expect.any(Error) as Error,
  });
});
