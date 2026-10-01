# @pilmee/mssql

Helpers on top of [`mssql`](https://www.npmjs.com/package/mssql) to make common Microsoft SQL Server tasks easier.

- [Install](#install)
- [Migration from mssql](MIGRATION.md)
- [Connect](#connect)
- [Select / findOne](#select--findone) · [Where filters](#where-filters) · [Set operations](#set-operations)
- [Insert](#insert) · [Insert many](#insert-many) · [Merge (upsert)](#merge-upsert) · [Update](#update) · [Delete](#delete)
- [Tagged template queries](#tagged-template-queries) · [Raw SQL and .sql files](#raw-sql-and-sql-files) · [Stored procedures](#stored-procedures) · [Transactions](#transactions)
- [Typed parameters](#typed-parameters)
- [Cancellation and timeouts](#cancellation-and-timeouts) · [Retries](#retries)
- [Error handling](#error-handling)
- [Debug mode](#debug-mode)
- [Events](#events)

## Install

```bash
npm install @pilmee/mssql mssql
```

[`mssql`](https://www.npmjs.com/package/mssql) (v12) is a peer dependency, so your app and this library share the same driver and connection pools. npm 7+ installs it automatically if it is missing.

Also published to GitHub Packages as `@eljijuna/mssql`:

```bash
# .npmrc
@eljijuna:registry=https://npm.pkg.github.com

npm install @eljijuna/mssql mssql
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

### Reuse an existing pool

Pass your application's `mssql.ConnectionPool` directly. It may already be connected; otherwise,
the client connects it on first use without creating another pool.

```ts
import sql from 'mssql';
import { SqlClient } from '@pilmee/mssql';

const pool = new sql.ConnectionPool(config);
await pool.connect();

const client = new SqlClient(pool);
const users = await client.select('dbo.Users', { active: true });
// Raw requests and other clients can keep using this same pool.

await client.close(); // releases the client's reference; the borrowed pool stays open
await pool.close();   // the application owner closes it after all users have finished
```

| Source | Default ownership | Effect of `client.close()` |
| --- | --- | --- |
| Configuration object | Owned | Closes the client-created pool |
| Existing pool | Borrowed | Releases the client reference without closing the pool |
| Existing pool with `{ ownsPool: true }` | Owned | Closes the supplied pool |

Use `new SqlClient(pool, { ownsPool: true })` only when transferring responsibility for shutdown
to that client. Multiple clients can borrow a pool; each keeps its own options and event listeners.
Helpers and transactions use the supplied pool, while raw requests remain outside helper
instrumentation. Drain operations before closing an owned pool. A later `connect()` or helper call
can reuse/reconnect after `client.close()`; closing is not permanent disposal. The external owner
must not close a pool while borrowers are using it.

The `connect` event means the pool became available to this client (including an already connected
borrowed pool); `close` means the client released it, and only an owning client closes the pool.

In every helper, values are sent as parameters and table/column names are bracket-quoted (`dbo.Users` → `[dbo].[Users]`), so user input is never concatenated into the SQL.

## Operations at a glance

| Method | SQL | Returns |
| --- | --- | --- |
| `select(table, where?, options?)` | `SELECT … WHERE … ORDER BY … OFFSET` | rows |
| `findOne(table, where?, options?)` | `SELECT TOP (1)` | row or `null` |
| `set(table, { key }).difference(list)` … | `EXISTS` / `NOT EXISTS` against a JSON list | rows, your items or `boolean` |
| `insert(table, row)` | `INSERT` | generated id |
| `insertMany(table, rows, options?)` | `INSERT` per row, batched | `{ inserted, ids, failures }` |
| `merge(table, rows, { on, ... })` | `UPDATE` if exists, else `INSERT` | `{ inserted, updated, skipped, actions, ids, failures }` |
| `update(table, values, where)` | `UPDATE … WHERE` | rows affected |
| `delete(table, where)` | `DELETE … WHERE` | rows affected |
| ``query`…${value}…` `` / `query(sql, params?)` | any T-SQL, one batch | `{ rows, recordsets, rowsAffected }` |
| `queryFile(file, params?)` | the SQL in a `.sql` file | `{ rows, recordsets, rowsAffected }` |
| `exec(procedure, params?, { output? })` | `EXEC` (RPC) | `{ rows, recordsets, output, returnValue, rowsAffected }` |
| `transaction(async (tx) => …, options?)` | `BEGIN` … `COMMIT` / `ROLLBACK` | whatever the callback returns |

## Select / findOne

```ts
interface User { id: number; name: string; email: string }

const users = await client.select<User>('dbo.Users', { active: true });

const page = await client.select<User>(
  'dbo.Users',
  { role: ['admin', 'editor'] },
  { columns: ['id', 'name'], orderBy: { name: 'asc' }, limit: 20, offset: 40 },
);
// SELECT [id], [name] FROM [dbo].[Users] WHERE [role] IN (@p0, @p1)
// ORDER BY [name] ASC OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY

const user = await client.findOne<User>('dbo.Users', { email: 'ana@example.com' });
// → User | null
```

Omit `where` to read every row. The generic types the rows (defaults to `Record<string, unknown>`).

| Option | Description |
| --- | --- |
| `columns` | Columns to return. Default `*`. |
| `orderBy` | `'name'`, `['lastName', 'firstName']` or `{ createdAt: 'desc', id: 'asc' }` (priority order). |
| `limit` | Max rows (`select` only). Alone it becomes `TOP (n)`. |
| `offset` | Rows to skip (`select` only). Requires `orderBy` so pages are stable; becomes `OFFSET … FETCH NEXT`. |
| `debug` | Same as every helper. |

`findOne` is `select` with `TOP (1)`: it returns the first match, or `null`. Pass `orderBy` to decide which row wins when several match.

## Where filters

`select`, `findOne`, `update` and `delete` share the same `where` object — equalities joined with `AND`:

| Value | SQL |
| --- | --- |
| `{ id: 7 }` | `[id] = @p0` |
| `{ deletedAt: null }` | `[deletedAt] IS NULL` |
| `{ status: ['a', 'b'] }` | `[status] IN (@p0, @p1)` |
| `{ status: ['a', null] }` | `([status] IN (@p0) OR [status] IS NULL)` |
| `{ id: [] }` | `1 = 0` (matches nothing) |
| `{ price: t.decimal(9.99, 10, 2) }` | `[price] = @p0` with an explicit type |

For ranges, `LIKE`, `OR`, joins, etc., use [`query` / `queryFile`](#raw-sql-and-sql-files).

## Set operations

Compare a table with a list you already have — the `Set` methods of JavaScript, computed in SQL Server so the table is never downloaded to compare:

```ts
interface User { id: number; email: string; name: string }

const incoming = [
  { email: 'ana@x.com', name: 'Ana' },
  { email: 'eva@x.com', name: 'Eva' },
]; // objects or plain keys (['ana@x.com', …]); thousands are fine

const users = client.set<User>('dbo.Users', { key: 'email', where: { tenantId: 7 } });

await users.difference(incoming);          // User[]   in the table, not in the list  → e.g. deactivate
await users.missing(incoming);             // your items not in the table            → e.g. create
await users.intersection(incoming);        // User[]   in both                          → e.g. update
await users.symmetricDifference(incoming); // { onlyInDb: User[], onlyInList: your items }
await users.union(incoming);               // { inDb: User[], onlyInList: your items }
await users.isSubsetOf(incoming);          // every table key is in the list
await users.isSupersetOf(incoming);        // every list key is in the table
await users.isDisjointFrom(incoming);      // no key in common
```

| Option | Description |
| --- | --- |
| `key` | Column(s) that identify an element: `'email'` or `['tenantId', 'code']` (then the list holds objects). |
| `where` | Filter for the table side, same as [where filters](#where-filters). |
| `columns`, `orderBy` | Columns and order of the returned rows. |
| `caseSensitive` | Compare text exactly like JavaScript (see below). |

- `difference`, `intersection` and `inDb` return **table rows**; `missing` and `onlyInList` return **your own list items** (objects included), in list order.
- The list travels as **one JSON parameter** read with `OPENJSON`, so it isn't limited to 2100 values (tested with 20,000). Key types and collations are read from the table, so numbers, dates, `uniqueidentifier`s and `t.*` values compare correctly.
- Each method accepts the usual options last: `users.missing(incoming, { timeout: 5_000 })`. Available on `tx` too.

**Differences with JavaScript `Set`** — they follow SQL Server semantics:

| | JavaScript `Set` | Here |
| --- | --- | --- |
| Upper/lower case | `'Ana' !== 'ana'` | Follows the column collation, usually case-insensitive. `caseSensitive: true` compares exactly (can't use indexes). |
| Trailing spaces | `'a' !== 'a '` | Ignored, as in any SQL Server comparison. |
| `null` / `undefined` keys | an element like any other | Ignored on both sides: `NULL` never matches. |
| Duplicated keys in the list | kept once | `missing` returns the first occurrence per key. |

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

`where` follows the [where filters](#where-filters) rules:

```ts
await client.update('dbo.Users', { active: false }, { tenantId: 7, role: ['guest', 'trial'], deletedAt: null });
// UPDATE [dbo].[Users] SET [active] = @p0
// WHERE [tenantId] = @p1 AND [role] IN (@p2, @p3) AND [deletedAt] IS NULL
```

An empty `where` throws `SqlClientError`, so you can't update a whole table by accident.

## Delete

```ts
const removed = await client.delete('dbo.Sessions', { userId: 42 });
// → 3
```

Same [where filters](#where-filters) as `update`, and an empty `where` throws.

## Tagged template queries

Write SQL inline and interpolate values with `${…}`: every value becomes a real parameter (`@p0`, `@p1`…), never text pasted into the SQL. Like every helper, these queries go through debug mode, events, timeouts and retries.

```ts
const { rows } = await client.query<User>`
  SELECT id, name
  FROM dbo.Users
  WHERE tenantId = ${tenantId}
    AND role IN (${roles})          -- arrays expand: IN (@p1__0, @p1__1)
    AND createdAt >= ${t.datetime2(since, 3)}`;
```

Need options (`timeout`, `retry`, `debug`…)? Build the SQL with `tsql` and pass it with the options:

```ts
import { tsql } from '@pilmee/mssql';

await client.query(tsql`DELETE FROM dbo.Sessions WHERE expiresAt < ${new Date()}`, { timeout: 5_000 });
```

**Dynamic SQL without string concatenation** — fragments compose, and their values stay parameters:

```ts
const filters = [tsql`tenantId = ${tenantId}`];

if (search) filters.push(tsql`name LIKE ${`%${search}%`}`);
if (roles.length > 0) filters.push(tsql`role IN (${roles})`);

const direction = sortDesc ? tsql.raw('DESC') : tsql.raw('ASC'); // from a fixed list, never user input

const { rows } = await client.query<User>`
  SELECT ${tsql.join(['id', 'name', 'role'].map(tsql.id))}
  FROM ${tsql.id('dbo.Users')}
  WHERE ${tsql.join(filters, ' AND ')}
  ORDER BY name ${direction}`;
```

| Helper | Inserts | Use it for |
| --- | --- | --- |
| `${value}` | a parameter | every value (numbers, strings, dates, `t.*`, arrays for `IN`) |
| ``tsql`…` `` | the fragment, with its own parameters | optional or repeated pieces of SQL |
| `tsql.id(name)` | a bracket-quoted name (`[dbo].[Users]`) | table/column names that come from variables |
| `tsql.join(items, separator?)` | items separated by `, ` (or `separator`) | column lists, `AND`-ed filters, `VALUES` rows |
| `tsql.raw(text)` | text as-is — **not escaped** | trusted keywords only (e.g. `ASC`/`DESC` from a fixed list) |

Don't put quotes around a value: `WHERE name = '${name}'` would send the text `'@p0'`. That mistake is caught before connecting with a clear error; write `WHERE name = ${name}`.

`tx.query` accepts the same forms inside transactions.

## Raw SQL and .sql files

For anything the helpers don't cover (joins, ranges, `LIKE`, CTEs, functions…) you can also write the SQL with named `@parameters`: inline with `query(sql, params)`, or in `.sql` files with `queryFile`.

```sql
-- sql/users/get-by-tenant.sql
DECLARE @limit int = 50;

SELECT TOP (@limit) u.id, u.name, dbo.fnFullName(u.id) AS fullName
FROM dbo.Users u
WHERE u.tenantId = @tenantId
  AND u.status IN (@statuses);
```

```ts
const client = new SqlClient(config, {
  sqlDir: new URL('./sql', import.meta.url), // base folder for queryFile
});

const { rows } = await client.queryFile<User>('users/get-by-tenant', {
  tenantId: 7,
  statuses: ['active', 'pending'], // arrays expand: IN (@statuses__0, @statuses__1)
});

// Same thing inline
const { rows: admins } = await client.query<User>(
  'SELECT id, name FROM dbo.Users WHERE tenantId = @tenantId AND role = @role',
  { tenantId: 7, role: t.nvarchar('admin', 20) },
);
```

**Parameters**

- Every `@name` in the SQL is bound from `params` by name (`@` optional, case-insensitive), as plain values or `t.*` builders. Values are always sent as real parameters, never pasted into the SQL.
- Arrays expand into a list, so `IN (@ids)` just works; an empty array becomes `IN (NULL)` (matches nothing).
- A missing parameter fails **before connecting** with a clear message: `users/get-by-tenant.sql is missing parameter(s): @statuses`.
- Variables you `DECLARE` in the SQL, `@@` functions, `EXEC` argument names (`EXEC p @arg = @value`) and anything inside comments or strings are not treated as parameters. If the check ever gets a statement wrong (e.g. dynamic SQL), pass `{ validateParams: false }`.

**Nested queries**

Subqueries, CTEs and derived tables need nothing special: parameters work at any nesting level and arrays expand wherever they appear. A report that keeps the SQL in a file:

```sql
-- sql/reports/sales-per-day.sql
-- Orders and revenue per day and store, for customers in the given segments
-- (or picked one by one), optionally limited to some stores.
SELECT
  CAST(o.CreatedAt AS date) AS Day,
  o.StoreId,
  COUNT(*)     AS Orders,
  SUM(o.Total) AS Revenue
FROM dbo.Orders AS o
WHERE o.CustomerId IN (
        SELECT c.Id
        FROM dbo.Customers AS c
        WHERE c.SegmentId IN (@segmentIds)
           OR c.Id IN (@customerIds)
      )
  AND (@allStores = 1 OR o.StoreId IN (@storeIds))
  AND o.CreatedAt >= @from
  AND o.CreatedAt <  @to
GROUP BY CAST(o.CreatedAt AS date), o.StoreId
ORDER BY Day ASC, o.StoreId ASC;
```

```ts
interface SalesPerDay {
  Day: Date;
  StoreId: number;
  Orders: number;
  Revenue: number;
}

const storeIds: number[] = []; // empty = every store

const { rows } = await client.queryFile<SalesPerDay>('reports/sales-per-day', {
  segmentIds: [1, 2],             // → IN (@segmentIds__0, @segmentIds__1)
  customerIds: [501, 502, 503],
  allStores: storeIds.length === 0,
  storeIds,                       // [] → IN (NULL), ignored thanks to @allStores
  from: t.datetime2(new Date('2026-01-01'), 3),
  to: t.datetime2(new Date('2026-02-01'), 3),
});
```

Tips for queries like this:

- **Never build lists with template strings** (`IN (${ids})`): that is SQL injection and breaks on quotes. Pass an array instead.
- **Parenthesize `OR`**: `A OR B AND C` means `A OR (B AND C)`. Keep the `OR` inside the subquery (or in its own parentheses) so the outer `AND` filters apply to every row.
- **Optional filters**: an empty array matches nothing (`IN (NULL)`). For "empty means all", add a flag: `(@allStores = 1 OR o.StoreId IN (@storeIds))`.
- **Day ranges on `datetime` columns**: use `>= @from AND < @to` (next day) instead of `BETWEEN`, which would drop the last day after midnight; group with `CAST(… AS date)`.
- **Very large lists**: each array item is a parameter and SQL Server accepts at most 2100 per request. For thousands of ids, send them as JSON and read them with `OPENJSON` instead.

**Files**

| Client option | Default | Description |
| --- | --- | --- |
| `sqlDir` | working directory | Base folder (`string` or file `URL`). Paths may not escape it: `queryFile('../secret')` throws. `new URL('./sql', import.meta.url)` keeps it independent of where the process starts. |
| `cacheSqlFiles` | `true` | Read each file once. Set `false` in development to pick up edits without restarting. |

- The `.sql` extension is optional: `'users/get-by-tenant'` and `'users/get-by-tenant.sql'` are the same file.
- `sqlDir` is a base directory, and `queryFile` reads one exact path within it. Glob patterns such as `src/**/*.sql` are not expanded. For nested files, use `sqlDir: 'src'` and `queryFile('features/users/list.sql')`.
- An explicit extension such as `.tsql` is accepted. There is no configurable default extension: paths without an extension always receive `.sql`. See the [migration guide](MIGRATION.md) for the full file-loading compatibility table.
- One file = one batch. Files with `GO` separators are rejected (`GO` is an SSMS/sqlcmd feature, not T-SQL).
- Your build must ship the `.sql` files: bundlers don't copy them. Copy the folder in your build step (or Dockerfile), or with Vite/esbuild import the text (`import text from './get-users.sql?raw'`) and use `client.query(text, params)`.
- Debug output and events report operation `queryFile` and start the SQL with a `-- users/get-by-tenant.sql` comment.
- Both work inside transactions: `tx.query(...)`, `tx.queryFile(...)`.

## Stored procedures

```ts
interface Order { id: number; total: number }

const { rows, output, returnValue } = await client.exec<Order>(
  'dbo.GetCustomerOrders',
  { customerId: 7, status: t.nvarchar('open', 20) },  // inputs by name (`@` optional)
  { output: { total: t.int(null), lastOrder: t.datetime2(null, 3) } },
);
// rows             → Order[]           (first result set)
// output.total     → number | null     (typed from the builder)
// output.lastOrder → Date | string | null
// returnValue      → number            (the procedure's RETURN, 0 by default)
```

| Result field | Content |
| --- | --- |
| `rows` | Rows of the first result set (`[]` when there is none) |
| `recordsets` | Every result set, in order, for procedures that return several |
| `output` | OUTPUT parameter values, typed from the `t.*` builders used |
| `returnValue` | The procedure's `RETURN` value |
| `rowsAffected` | Rows affected per statement |

- Input values follow the same rules as everywhere else: plain values are typed by `mssql`, `t.*` sets the exact type.
- OUTPUT parameters need a type, so they always use `t.*`. The value is sent as the initial value — use `null` for pure OUTPUT, or a value for INPUT/OUTPUT parameters.
- The procedure runs as an RPC call (like `request.execute`), not as SQL text. Debug mode prints the equivalent runnable script:

  ```sql
  DECLARE @customerId int = 7;
  DECLARE @total int = NULL;
  EXEC [dbo].[GetCustomerOrders] @customerId = @customerId, @total = @total OUTPUT;
  SELECT @total AS [total];
  ```

- Available on `tx` too: `tx.exec(...)` runs inside the transaction.

## Transactions

`client.transaction` commits when the callback resolves and rolls back when it throws (the error is rethrown). `tx` has the same helpers as the client (`select`, `findOne`, `insert`, `insertMany`, `merge`, `update`, `delete`, `exec`, `query`, `queryFile`):

```ts
const orderId = await client.transaction(async (tx) => {
  const id = await tx.insert('dbo.Orders', { customerId: 7, total: t.decimal(99.9, 10, 2) });

  await tx.insertMany('dbo.OrderLines', lines.map((line) => ({ ...line, orderId: id })));
  await tx.update('dbo.Customers', { lastOrderId: id }, { id: 7 });

  return id; // → transaction() resolves with it
});
```

| Option | Default | Description |
| --- | --- | --- |
| `isolationLevel` | server default (`readCommitted`) | `'readUncommitted'`, `'readCommitted'`, `'repeatableRead'`, `'serializable'` or `'snapshot'` |
| `timeout` | none | Max ms for the whole transaction. See [cancellation and timeouts](#cancellation-and-timeouts). |
| `signal` | none | `AbortSignal` that cancels the transaction. |

```ts
await client.transaction(async (tx) => { /* ... */ }, { isolationLevel: 'serializable' });
```

**Batches inside a transaction** use savepoints instead of their own transaction:

- `onError: 'rollback'` undoes only the rows of that call. If you catch the `BatchRowError`, the rest of the transaction can still commit:

  ```ts
  await client.transaction(async (tx) => {
    await tx.insert('dbo.Imports', { startedAt: new Date() });

    try {
      await tx.insertMany('dbo.Users', rows);
    } catch (error) {
      if (!(error instanceof BatchRowError)) throw error;
      await tx.insert('dbo.ImportErrors', { index: error.index, message: error.sqlMessage });
    }
  }); // commits the import log and the error, without any of the users
  ```

- `onError: 'continue'` isolates each row with its own savepoint, so a failed row never undoes the caller's work.

**Good to know**

- Always `await` the operations. They run one after another (a transaction uses a single connection), so `Promise.all` inside a transaction is safe but not parallel. Operations left un-awaited are still finished before the commit.
- Using `tx` after the callback returned throws `SqlClientError`.
- `tx.request()` gives you a raw `mssql` request bound to the transaction for anything the helpers don't cover. Raw requests are not queued, so don't run them at the same time as other operations.
- With `XACT_ABORT ON` or severe errors SQL Server dooms the whole transaction; the commit then fails and `transaction()` rolls back and throws.

## Typed parameters

Plain values are typed by `mssql` from the JavaScript value. Use the `t` builders — named after the T-SQL types — to set the exact type and its dimensions. They work in every helper, including `where` filters:

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

## Cancellation and timeouts

Every helper accepts `signal` and `timeout` in its options (`select`, `findOne`, `insert`, `insertMany`, `merge`, `update`, `delete`, `exec`, `query`, `queryFile`, and the same on `tx`):

```ts
// Stop a slow report after 5 seconds
const { rows } = await client.queryFile('reports/sales-per-day', params, { timeout: 5_000 });

// Cancel when the HTTP client disconnects
app.get('/users', async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(); // client left before we answered
  });

  const users = await client.select('dbo.Users', { active: true }, { signal: controller.signal });
  res.json(users);
});
```

When the signal aborts or the time is up, the running query is **cancelled on the server** and the call rejects with a `SqlAbortError`:

```ts
import { SqlAbortError } from '@pilmee/mssql';

try {
  await client.insertMany('dbo.Events', events, { timeout: 10_000 });
} catch (error) {
  if (error instanceof SqlAbortError) {
    error.reason;    // 'timeout' | 'abort'
    error.operation; // 'insertMany'
  }
}
```

- `timeout` counts from the moment the call starts and covers **all** its queries (every chunk of a batch). Opening a connection is not interrupted — the pool's `connectionTimeout` bounds that — but nothing is sent once the time is up.
- A signal that is already aborted fails immediately, without connecting.
- Batches: in `'rollback'` mode nothing is saved; in `'continue'` mode the call stops (it is not reported as row failures) and chunks that already finished stay saved.
- The same `AbortSignal` can be reused across many calls: listeners are removed when each query ends.

**Transactions** take their own `timeout` / `signal` for the whole unit of work. Each operation inside is limited by whatever is left (and by its own options, whichever ends first), and the transaction is **never committed** once the time is up or the signal fired — it rolls back and `transaction()` rejects with a `SqlAbortError` whose `operation` is `'transaction'`:

```ts
await client.transaction(
  async (tx) => {
    await tx.insertMany('dbo.OrderLines', lines);
    await tx.exec('dbo.RecalculateStock', { orderId });
  },
  { timeout: 15_000 },
);
```

## Retries

Transient errors — deadlocks (`1205`), Azure SQL failovers (`40613`, `40197`, `4060`…), a busy service (`40501`), resource limits, In-Memory OLTP conflicts and failed connections — are retried automatically with exponential backoff and jitter. The full list is exported as `TRANSIENT_ERROR_NUMBERS`.

Retrying is only done where running the work again is safe:

| Call | Retried by default | What is retried |
| --- | --- | --- |
| `select`, `findOne`, `insert`, `update`, `delete`, `set(…)` methods | yes | the call (a single statement: a deadlock already rolled it back) |
| `insertMany` / `merge` with `onError: 'rollback'` | yes | the whole call (all or nothing) |
| `insertMany` / `merge` with `onError: 'continue'` | yes | only the rows that failed with a transient error; rows already saved are never repeated |
| `exec`, `query`, `queryFile` | **no**, pass `retry: true` | the call — only opt in when the SQL is safe to run twice |
| `transaction(fn)` | **no**, pass `retry: true` | the whole transaction (`fn` runs again from scratch) |
| operations inside `tx` | never | a deadlock kills the whole transaction; retry the transaction instead |

Failed connections (`SqlConnectionError`) are retried by every call that retries, since nothing was executed.

```ts
// Client defaults (shown with their default values)
const client = new SqlClient(config, {
  retry: { attempts: 3, delay: 100, maxDelay: 2_000 },
});

// Per call
await client.select('dbo.Users', {}, { retry: false });                        // never retry this one
await client.exec('dbo.RecalculateTotals', { day }, { retry: true });            // safe to repeat
await client.queryFile('reports/sales-per-day', params, { retry: { attempts: 5 } });

// A transaction that may lose a deadlock: fn runs again from the start
await client.transaction(async (tx) => {
  await tx.update('dbo.Accounts', { balance: from.balance - amount }, { id: from.id });
  await tx.update('dbo.Accounts', { balance: to.balance + amount }, { id: to.id });
}, { retry: true });
```

| Option | Default | Description |
| --- | --- | --- |
| `attempts` | `3` | Retries after the first try. `0` disables retrying. |
| `delay` | `100` | Base wait in ms, doubled on each retry (with jitter). |
| `maxDelay` | `2000` | Maximum wait in ms. |
| `errorNumbers` | `TRANSIENT_ERROR_NUMBERS` | Error numbers to retry. |
| `shouldRetry` | — | `(error, attempt) => boolean`, replaces `errorNumbers` for custom rules. |

- `retry: false` on the client turns it off everywhere; a call's `retry` always wins over the client's.
- `timeout` and `signal` cover every attempt **and** the waits between them; cancellations are never retried.
- With `transaction(fn, { retry: true })`, keep side effects outside the database (emails, HTTP calls, queues) out of `fn` — they would run again.
- Every retry emits a `retry` event, handy for metrics:

  ```ts
  client.on('retry', ({ operation, attempt, number, delayMs }) =>
    logger.warn(`${operation} retry #${attempt} after error ${number} in ${delayMs} ms`),
  );
  ```

Mid-query connection drops (`ESOCKET`, `ECONNRESET`) are not retried by default: the statement may have run before the connection broke. Use `shouldRetry` if your writes are idempotent.

## Error handling

| Error | When |
| --- | --- |
| `SqlClientError` | Base class of every error below. Also thrown for invalid identifiers, empty `where`, missing parameters and unexpected batch errors (original error in `cause`). |
| `BatchRowError` | `insertMany` / `merge` in `'rollback'` mode when a row fails. Has `index`, `row`, `number`, `sqlMessage`. Nothing was saved. |
| `SqlConnectionError` | The pool couldn't connect (subclass of `SqlClientError`). Nothing ran; retried automatically. |
| `SqlAbortError` | The call's `signal` aborted or its `timeout` passed; the query was cancelled. Has `reason` (`'abort'` / `'timeout'`) and `operation`; `cause` is the signal's reason. |

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
| `operation` | `select`, `findOne`, `insert`, `insertMany`, `merge`, `update`, `delete`, `exec`, `query`, `queryFile` or `set` |
| `sql` | SQL text exactly as sent, with `@p0`, `@p1`… placeholders |
| `params` | `[{ name, type, value }]`, e.g. `{ name: 'p0', type: 'nvarchar(100)', value: 'Ana' }` |
| `script` | `DECLARE` per parameter + the SQL, ready to run |

> Debug output includes parameter **values**. Keep it off in production and away from logs that may contain passwords or personal data.

Queries you run directly on the raw pool (`client.connect()` → `pool.request().query(...)`) are not logged; use `mssql`'s own `DEBUG=mssql:*` for those.

## Events

`SqlClient` is an event emitter. Subscribe with `on`, `once` and `off` (chainable) to observe everything the helpers do — for logging, metrics or alerts:

```ts
client
  .on('success', ({ operation, durationMs }) => metrics.timing(`db.${operation}`, durationMs))
  .on('failure', ({ operation, sql, number, error }) => logger.error({ operation, sql, number, error }))
  .on('rowFailure', ({ operation, index, number, message }) => logger.warn({ operation, index, number, message }))
  .on('connectFailure', ({ error }) => alert('SQL Server unreachable', error));
```

| Event | When | Payload |
| --- | --- | --- |
| `connect` | Pool available to this client (opened or reused) | `durationMs` |
| `connectFailure` | Pool failed to open | `durationMs`, `error` |
| `close` | Client released the pool (closed only when owned) | `{}` |
| `query` | A query is about to be sent | `id`, `operation`, `transactionId`, `sql`, `params` |
| `success` | A query completed | `id`, `operation`, `transactionId`, `sql`, `params`, `durationMs`, `rowsAffected` |
| `failure` | A query failed (the method still throws) | `id`, `operation`, `transactionId`, `sql`, `params`, `durationMs`, `error`, `number` |
| `rowFailure` | A row of `insertMany` / `merge` failed, in both `onError` modes | `operation`, `index`, `row`, `number`, `message` |
| `transactionBegin` | A transaction started | `transactionId` |
| `transactionCommit` | A transaction committed | `transactionId`, `durationMs` |
| `transactionRollback` | A transaction rolled back | `transactionId`, `durationMs`, `error` |
| `retry` | A transient error is about to be retried | `operation`, `attempt`, `delayMs`, `error`, `number`, `rows` (continue-mode batches) |

- `id` correlates the `query`, `success` and `failure` of the same execution.
- `transactionId` on `query` / `success` / `failure` links a query to its transaction (`null` outside one).
- A batch query can emit `success` while some of its rows emitted `rowFailure` (`onError: 'continue'`).
- A listener that throws never breaks the query: the error is caught and printed with `console.error`.
- Unsubscribe with `off(event, listener)`, `off(event)` (all listeners), or an `AbortSignal`:

```ts
const controller = new AbortController();

client.on('failure', report, { signal: controller.signal });
controller.abort(); // unsubscribed
```

Event payloads include parameter values (`params`, `row`); treat them like debug output when shipping them to logs.

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
| `npm run db:up` | Start SQL Server 2022 in Docker for integration tests (port 14330, see `compose.yaml`) |
| `npm run test:integration` | Run the integration tests against that server |
| `npm run db:down` | Stop and remove the test server |

### Integration tests

Unit tests mock `mssql`; the integration tests in `test/integration` run the real T-SQL against SQL Server 2022 (batches with per-row `TRY/CATCH`, savepoints, `UPDLOCK/SERIALIZABLE` merges under concurrency, query cancellation, and debug scripts replayed on the server).

```bash
npm run db:up             # first run downloads the image (~1.5 GB); on Apple Silicon it runs under emulation
npm run test:integration
npm run db:down
```

A real deadlock is provoked to check that transaction retries apply each transaction exactly once.

They use the `pilmee_mssql_test` database (created automatically). Point them at another server with `MSSQL_HOST`, `MSSQL_PORT`, `MSSQL_USER`, `MSSQL_PASSWORD` and `MSSQL_DATABASE`. CI runs them on every pull request.

## License

MIT
