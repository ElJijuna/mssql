# @pilmee/mssql

Helpers on top of [`mssql`](https://www.npmjs.com/package/mssql) to make common Microsoft SQL Server tasks easier.

> **Beta** — the API may change between releases. Install with `npm install @pilmee/mssql@beta`.

- [Install](#install)
- [Connect](#connect)
- [Insert](#insert) · [Insert many](#insert-many) · [Merge (upsert)](#merge-upsert) · [Update](#update) · [Delete](#delete)
- [Typed parameters](#typed-parameters)
- [Error handling](#error-handling)
- [Debug mode](#debug-mode)

## Install

```bash
npm install @pilmee/mssql@beta
```

Also published to GitHub Packages as `@eljijuna/mssql`:

```bash
# .npmrc
@eljijuna:registry=https://npm.pkg.github.com

npm install @eljijuna/mssql@beta
```

## Connect

```ts
import { SqlClient } from '@pilmee/mssql';

const client = new SqlClient({
  server: 'localhost',
  database: 'master',
  user: 'sa',
  password: process.env.MSSQL_PASSWORD,
  options: { trustServerCertificate: true },
});

// Helpers connect on first use. The raw mssql pool is still available:
const pool = await client.connect();
const result = await pool.request().query('SELECT 1 AS ok');

await client.close();
```

In every helper, values are sent as parameters and table/column names are bracket-quoted (`dbo.Users` → `[dbo].[Users]`), so user input is never concatenated into the SQL.

## Operations at a glance

| Method | SQL | Returns |
| --- | --- | --- |
| `insert(table, row)` | `INSERT` | generated id |
| `insertMany(table, rows, options?)` | `INSERT` per row, batched | `{ inserted, ids, failures }` |
| `merge(table, rows, { on, ... })` | `UPDATE` if exists, else `INSERT` | `{ inserted, updated, skipped, actions, ids, failures }` |
| `update(table, values, where)` | `UPDATE … WHERE` | rows affected |
| `delete(table, where)` | `DELETE … WHERE` | rows affected |

## Insert

```ts
const id = await client.insert('dbo.Users', { name: 'Ana', email: 'ana@example.com' });
// → 42 (null if the table has no identity column)
```

An empty object inserts `DEFAULT VALUES`. The id comes from `SCOPE_IDENTITY()`, so it works on tables with triggers.

## Insert many

Rows are sent in chunks (500 by default, one round trip each) and every row is tagged with its position, so you always know which one failed. Rows may have different columns.

**All or nothing** (default, `onError: 'rollback'`): runs in a transaction; if a row fails nothing is saved and a `BatchRowError` is thrown.

```ts
import { BatchRowError } from '@pilmee/mssql';

try {
  const { ids } = await client.insertMany('dbo.Users', [
    { name: 'Ana', email: 'ana@example.com' },
    { name: 'Luis', email: 'luis@example.com' },
  ]);
  // ids → [101, 102]
} catch (error) {
  if (error instanceof BatchRowError) {
    console.error(`Row ${error.index} failed (${error.number}): ${error.sqlMessage}`, error.row);
  }
}
```

**Best effort** (`onError: 'continue'`): every row is attempted; failures are reported, never thrown.

```ts
const { inserted, ids, failures } = await client.insertMany('dbo.Users', rows, { onError: 'continue' });
// inserted → 2
// ids      → [101, null, 102]   (null = failed)
// failures → [{ index: 1, row: {...}, number: 2627, message: 'Violation of UNIQUE KEY constraint...' }]
```

If SQL Server or the driver rejects a whole chunk (an unknown column, or a value refused before sending), its rows are retried one by one so each failure is still attributed to its row and the rest still go in.

## Merge (upsert)

Inserts rows that don't exist and updates the ones that do, matching on the `on` column(s):

```ts
const result = await client.merge(
  'dbo.Users',
  [
    { email: 'ana@example.com', name: 'Ana María' }, // exists  → updated
    { email: 'eva@example.com', name: 'Eva' },       // missing → inserted
  ],
  { on: 'email' },
);
// result.inserted → 1
// result.updated  → 1
// result.actions  → ['updated', 'inserted']
// result.ids      → [null, 103]
```

| Option | Default | Description |
| --- | --- | --- |
| `on` | — (required) | Key column(s): `'email'` or `['tenantId', 'code']`. Every row must include them. |
| `update` | all non-key columns in the row | Columns to update when the row exists. `false` = insert missing rows only, leave existing ones untouched (`skipped`). |
| `onError` | `'rollback'` | Same as [insert many](#insert-many). |
| `chunkSize` | `500` | Same as [insert many](#insert-many). |

```ts
// Composite key, only refresh the price
await client.merge('dbo.Prices', rows, { on: ['storeId', 'sku'], update: ['price'] });

// Insert-if-missing
await client.merge('dbo.Tags', [{ name: 'sql' }, { name: 'node' }], { on: 'name', update: false });
```

How it works: each row runs `IF EXISTS (… WITH (UPDLOCK, SERIALIZABLE)) UPDATE … ELSE INSERT …`. The lock keeps two concurrent merges from inserting the same key. It does **not** use the T-SQL `MERGE` statement, which fails as a whole without telling you which row broke and has known concurrency and trigger issues. `null` key values are matched with `IS NULL`. A row missing a key column is rejected before anything is sent (a `BatchRowError`, or a failure with `number: null` in `continue` mode).

## Update

```ts
const affected = await client.update('dbo.Users', { name: 'Ana María', active: true }, { id: 42 });
// → 1
```

`where` is a set of equalities joined with `AND`; `null` becomes `IS NULL`:

```ts
await client.update('dbo.Users', { active: false }, { tenantId: 7, deletedAt: null });
// UPDATE [dbo].[Users] SET [active] = @p0 WHERE [tenantId] = @p1 AND [deletedAt] IS NULL
```

An empty `where` throws `SqlClientError`, so you can't update a whole table by accident. For ranges, `IN`, `LIKE`, etc., use the raw pool (`client.connect()`).

## Delete

```ts
const removed = await client.delete('dbo.Sessions', { userId: 42 });
// → 3
```

Same `where` rules as [update](#update): equalities joined with `AND`, `null` → `IS NULL`, and an empty `where` throws.

## Typed parameters

Plain values are typed by `mssql` from the JavaScript value. Use the `t` builders — named after the T-SQL types — to set the exact type and its dimensions. They work in every helper (`insert`, `insertMany`, `merge`, `update`, `delete`):

```ts
import { t } from '@pilmee/mssql';

await client.insert('dbo.Products', {
  name: t.nvarchar('Keyboard', 100),       // nvarchar(100)
  description: t.nvarchar(text, 'max'),    // nvarchar(max)
  price: t.decimal(49.99, 10, 2),          // decimal(10, 2)
  sku: t.char('KB-001', 6),                // char(6)
  createdAt: t.datetime2(new Date(), 3),   // datetime2(3)
  externalId: t.uniqueidentifier(uuid),
  stock: 10,                               // inferred
});
```

| Kind | Builders |
| --- | --- |
| Integers / exact | `bit`, `tinyint`, `smallint`, `int`, `bigint`, `decimal(v, p, s)`, `numeric(v, p, s)`, `money`, `smallmoney` |
| Approximate | `float`, `real` |
| Strings | `char(v, n)`, `nchar(v, n)`, `varchar(v, n \| 'max')`, `nvarchar(v, n \| 'max')` |
| Binary | `binary(v, n)`, `varbinary(v, n \| 'max')` |
| Date / time | `date`, `time(v, scale)`, `datetime`, `datetime2(v, scale)`, `datetimeoffset(v, scale)`, `smalldatetime` |
| Other | `uniqueidentifier`, `xml` |

## Error handling

| Error | When |
| --- | --- |
| `SqlClientError` | Base class. Connection failures, invalid identifiers, empty `where`, unexpected batch errors (original error in `cause`). |
| `BatchRowError` | `insertMany` / `merge` in `'rollback'` mode when a row fails. Has `index`, `row`, `number`, `sqlMessage`. Nothing was saved. |

In `'continue'` mode batch helpers don't throw; each entry in `failures` has `index`, `row`, `number` and `message`. `number` is the SQL Server error number (e.g. `2627` unique key, `547` foreign key, `515` NOT NULL, `2628` truncation), or `null` when the error came from the driver or from validation.

## Debug mode

Print the SQL each helper sends — with its parameters — as a script you can paste into SSMS / Azure Data Studio.

**Every call**, on the client:

```ts
const client = new SqlClient(config, { debug: process.env.NODE_ENV === 'development' });
```

**A single call**, with the `debug` option (available on every helper):

```ts
await client.insert('dbo.Users', { name: t.nvarchar('Ana', 100), age: 30 }, { debug: true });
await client.update('dbo.Users', { name: 'Ana' }, { id: 42 }, { debug: true });
await client.insertMany('dbo.Users', rows, { debug: true });
await client.merge('dbo.Users', rows, { on: 'email', debug: true });
```

Output (`console.debug`):

```sql
-- [@pilmee/mssql] insert
DECLARE @p0 nvarchar(100) = N'Ana';
DECLARE @p1 int = 30;
INSERT INTO [dbo].[Users] ([name], [age]) VALUES (@p0, @p1); SELECT SCOPE_IDENTITY() AS id;
```

The call-level option wins, so `{ debug: false }` silences one call while debug is on for the client. Batch helpers log one entry per chunk sent (and per row when a rejected chunk is retried row by row).

**Custom logger**: pass a function instead of `true` to receive structured entries:

```ts
import type { SqlDebugEntry } from '@pilmee/mssql';

const client = new SqlClient(config, {
  debug: (entry: SqlDebugEntry) => logger.debug({ op: entry.operation, sql: entry.sql, params: entry.params }),
});
```

| Field | Content |
| --- | --- |
| `operation` | `insert`, `insertMany`, `merge`, `update` or `delete` |
| `sql` | SQL text exactly as sent, with `@p0`, `@p1`… placeholders |
| `params` | `[{ name, type, value }]`, e.g. `{ name: 'p0', type: 'nvarchar(100)', value: 'Ana' }` |
| `script` | `DECLARE` per parameter + the SQL, ready to run |

> Debug output includes parameter **values**. Keep it off in production and away from logs that may contain passwords or personal data.

Queries you run directly on the raw pool (`client.connect()` → `pool.request().query(...)`) are not logged; use `mssql`'s own `DEBUG=mssql:*` for those.

## Scripts

| Script | Description |
| --- | --- |
| `npm run build` | Build ESM + CJS bundles with type declarations (tsup) |
| `npm run typecheck` | Type-check with `tsc` |
| `npm run lint` | Lint with ESLint (`super-configs/eslint/ts` + `jest`) |
| `npm run format` | Format and fix with Biome (`super-configs/biome`) |
| `npm test` | Run unit tests (Jest) |
| `npm run docs` | Generate API docs with TypeDoc (`super-configs/typedoc`) |
| `npm run check` | Typecheck + lint + format check + tests |

## License

MIT
