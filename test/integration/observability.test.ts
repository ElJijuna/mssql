import sql from 'mssql';
import { type SqlDebugEntry, t } from '../../src';
import { connectionConfig } from './env';
import { createClient, ddl } from './helpers';

const entries: SqlDebugEntry[] = [];
const client = createClient({ debug: (entry) => entries.push(entry) });

let raw: sql.ConnectionPool;

beforeAll(async () => {
  raw = await new sql.ConnectionPool(connectionConfig()).connect();
  await ddl(
    client,
    'DROP TABLE IF EXISTS dbo.it_obs_items;',
    `CREATE TABLE dbo.it_obs_items (
       id int IDENTITY(1, 1) PRIMARY KEY,
       name nvarchar(100) NOT NULL,
       price decimal(10, 2) NOT NULL,
       createdAt datetime2(3) NOT NULL,
       active bit NOT NULL,
       notes nvarchar(max) NULL
     );
     INSERT INTO dbo.it_obs_items (name, price, createdAt, active, notes) VALUES
       (N'Ana''s item', 9.99, '2026-03-01T10:20:30.123', 1, NULL),
       (N'Other', 5, '2026-03-02T00:00:00', 0, N'x');`,
  );
});

afterAll(async () => {
  await client.close();
  await raw.close();
});

it('prints debug scripts that run in SQL Server and return the same rows', async () => {
  entries.length = 0;

  const rows = await client.select('dbo.it_obs_items', {
    name: t.nvarchar("Ana's item", 100),
    price: t.decimal(9.99, 10, 2),
    createdAt: t.datetime2(new Date('2026-03-01T10:20:30.123Z'), 3),
    active: true,
    notes: null,
    id: [1, 2],
  });
  const [entry] = entries;

  expect(rows).toHaveLength(1);
  expect(entry?.script).toContain("DECLARE @p0 nvarchar(100) = N'Ana''s item';");

  const replayed = await raw.request().query(entry?.script ?? '');

  expect(replayed.recordset).toEqual(rows);
});

it('prints a runnable EXEC script for procedures', async () => {
  await ddl(
    client,
    'DROP PROCEDURE IF EXISTS dbo.it_obs_double;',
    'CREATE PROCEDURE dbo.it_obs_double @value int, @result int OUTPUT AS SET @result = @value * 2;',
  );
  entries.length = 0;

  const { output } = await client.exec(
    'dbo.it_obs_double',
    { value: 21 },
    { output: { result: t.int(null) } },
  );
  const replayed = await raw.request().query(entries[0]?.script ?? '');

  expect(output.result).toBe(42);
  expect(replayed.recordset).toEqual([{ result: 42 }]);
});

it('emits events with SQL Server error numbers', async () => {
  const failures: Array<number | null> = [];
  const listener = ({ number }: { number: number | null }) => failures.push(number);

  client.on('failure', listener);
  await expect(client.query('SELECT * FROM dbo.it_obs_missing_table')).rejects.toThrow();
  client.off('failure', listener);

  expect(failures).toEqual([208]);
});
