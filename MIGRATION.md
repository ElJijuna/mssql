# Migration plan: `mssql` to `@pilmee/mssql`

This guide targets `@pilmee/mssql` 1.2.0. Use version 1.2.0 or newer for the features described below. The package adds helpers on top of `mssql`; it is not a drop-in replacement for its exports. Keep `mssql` installed and migrate one repository method at a time. No database schema or data migration is required by adopting the wrapper.

## 1. Inventory the existing integration

Before editing code, list the application's connection owners, SQL calls, transactions, and consumers of query results. Record:

- Node.js and `mssql` versions, authentication, driver, TLS settings, pool sizes, connection and request timeouts.
- Uses of global `sql.connect`, explicit pools, multiple databases, and shutdown hooks.
- Queries, stored procedures, explicit parameter types, output parameters, multiple result sets, and metadata consumers.
- Streaming, bulk inserts, table-valued parameters, prepared statements, `batch`, and request-specific options.
- Transaction isolation, error handling, retry policies, and external side effects.
- SQL file locations and how those files reach the deployment artifact.

Capture representative outputs and database effects as a baseline. Include no rows, nulls, Unicode, decimal precision, dates, duplicate keys, and failures. Do not run old and new write paths together to compare them.

**Exit criterion:** every call is classified as a helper candidate or a raw-driver call that must remain.

## 2. Establish compatible dependencies

The repository requires Node.js 20 or newer and declares `mssql ^12.0.0` as a peer dependency. If the application uses an older driver, validate that upgrade independently first using the [official node-mssql upgrade notes](https://github.com/tediousjs/node-mssql#11x-to-12x-changes).

```bash
npm install @pilmee/mssql 'mssql@^12.0.0'
npm ls @pilmee/mssql mssql
```

Commit the lockfile. Keep imports from `mssql` for raw requests and features without helper equivalents. ESM and CommonJS are both supported:

```ts
import { SqlClient, t } from '@pilmee/mssql';
```

```js
const { SqlClient, t } = require('@pilmee/mssql');
```

When given a configuration, the wrapper constructs its pool using the default `mssql` import. It also accepts an existing `mssql.ConnectionPool`; the constructor has no separate driver-selection option. Applications using an alternate driver should validate helper compatibility separately rather than assuming default-driver tests cover it.

## 3. Centralize connection ownership

Reuse the existing configuration object; `SqlClientConfig` is `mssql.config`. Connection strings must first become a configuration object. Create one long-lived client per intended database/configuration, not one per HTTP request.

```ts
// db.ts
import { SqlClient } from '@pilmee/mssql';
import { config } from './db-config';

export const client = new SqlClient(config, {
  retry: false, // preserve the initial application's retry behavior
});

export async function startDatabase() {
  await client.connect(); // optional startup health check; helpers otherwise connect lazily
}

export async function stopDatabase() {
  await client.close(); // call after in-flight application work has drained
}
```

`connect()` returns the client's raw `mssql.ConnectionPool`. Repeated calls on the same client reuse that pool. Installing the peer dependency shares the driver implementation, but does not make independently constructed clients or the global `mssql` pool share a connection pool.

If the application already owns a pool, reuse it directly to preserve connection ownership:

```ts
const client = new SqlClient(existingPool, { retry: false });
await client.query('SELECT 1 AS ok');
await client.close(); // borrowed pool stays open; the existing owner closes it at shutdown
```

An unopened supplied pool is connected lazily. `{ ownsPool: true }` explicitly transfers shutdown responsibility to the client; do not enable it for multiple wrappers sharing a pool. Client `connect`/`close` events describe acquiring/releasing the pool, so a borrowed client's `close` event does not indicate that physical connections were closed.

For the least disruptive first change, route existing raw code through the client-owned pool:

```ts
import sql from 'mssql';
import { client } from './db';

const pool = await client.connect();
const result = await pool.request()
  .input('id', sql.Int, id)
  .query('SELECT id, name FROM dbo.Users WHERE id = @id');
const users = result.recordset;
```

Raw requests retain driver behavior and do not acquire helper logging, events, timeouts, or retries. Remove the old pool owner only after all its callers have moved; close each remaining pool through its actual owner.

**Exit criterion:** startup, reconnection/error handling, multiple databases, and graceful shutdown work with the intended number of pools.

## 4. Migrate raw queries without rewriting SQL

Keep the SQL text initially. Replace input binding with named parameter objects and preserve explicit types:

```ts
// Before: pool is an mssql.ConnectionPool
const oldResult = await pool.request()
  .input('tenantId', sql.Int, tenantId)
  .input('status', sql.NVarChar(20), status)
  .query('SELECT id, name FROM dbo.Users WHERE tenantId = @tenantId AND status = @status');
const oldRows = oldResult.recordset;

// After
const { rows } = await client.query<User>(
  'SELECT id, name FROM dbo.Users WHERE tenantId = @tenantId AND status = @status',
  { tenantId: t.int(tenantId), status: t.nvarchar(status, 20) },
);
```

Here `User` is an application-defined row interface. Generics describe expected rows; they do not validate database output at runtime.

| Existing result/use | Helper equivalent or migration action |
| --- | --- |
| `result.recordset` | `result.rows` |
| `result.recordsets` | `result.recordsets`, with helper row typing; retain raw calls for metadata attached by the driver |
| `result.rowsAffected` | `result.rowsAffected` for `query`, `queryFile`, `queryNamed`, and `exec` |
| Driver-specific metadata or options | Keep the raw request |
| `.input(name, sql.Int, value)` | `{ name: t.int(value) }` |
| `.input(name, sql.NVarChar(100), value)` | `{ name: t.nvarchar(value, 100) }` |
| `.input(name, sql.Decimal(10, 2), value)` | `{ name: t.decimal(value, 10, 2) }` |

Named parameters are checked before connecting. A leading `@` is optional in parameter keys. Arrays expand into separate parameters; an empty array produces `IN (NULL)`. Account for SQL Server's 2100-parameter limit. For SQL that the parameter analyzer cannot interpret, review the binding and use `{ validateParams: false }` as the third argument when needed.

Tagged templates are optional: `await client.query\`SELECT id FROM dbo.Users WHERE id = ${id}\``. Interpolations represent values, not identifiers; use `tsql.id` for dynamic table/column names and reserve `tsql.raw` for trusted SQL.

**Exit criterion:** row shapes, result ordering, affected-row counts, parameter types, and failure behavior match the baseline.

## 5. Adopt helpers where their semantics fit

| Existing operation | Candidate | Behavior to verify |
| --- | --- | --- |
| Simple filtered SELECT | `select` | Returns rows directly; equality, null, and array filters are joined with AND |
| First matching row | `findOne` | Returns a row or `null`; use `orderBy` to choose deterministically |
| Single INSERT | `insert` | Returns an identity or `null`; `{ returning }` instead returns written rows |
| UPDATE / DELETE | `update` / `delete` | Returns affected-row count, or rows with `{ returning }`; rejects empty filters |
| Many INSERTs | `insertMany` | Transactional by default; returns aligned ids and failure details |
| Upsert | `merge` | Uses locked UPDATE/INSERT logic; verify keys, triggers, and concurrency |
| Forward cursor pagination | `page` | Requires a declared unique, non-null key and lossless ordering values |
| Read/modify/write counters | `update` with `inc` | Computes from the current database value; no automatic retries by default |
| Joins, OR, ranges, complex SQL | `query` / `queryFile` / `queryNamed` | Preserve the existing SQL |

```ts
const users = await client.select<User>('dbo.Users', { tenantId, active: true });
const user = await client.findOne<User>('dbo.Users', { id });
const insertedId = await client.insert('dbo.Users', { name: t.nvarchar(name, 100) });
const affected = await client.update('dbo.Users', { active: false }, { id });
```

Do not replace `request.bulk` mechanically with `insertMany`: batching individual inserts has different SQL, throughput, and identity semantics. Keep streaming, TVPs, prepared statements, and batch-specific workflows on raw `mssql` requests unless separately redesigned. See the [official driver API](https://github.com/tediousjs/node-mssql#documentation) for those retained paths.

### Replace offset pagination with a cursor when appropriate

Keep `select` with `offset` when callers need arbitrary page numbers. For forward-only
navigation, replace the offset with a continuation cursor:

```ts
// Before: growing offset, including a deterministic tie-breaker
const oldPage = await pool.request()
  .input('tenantId', sql.Int, tenantId)
  .input('offset', sql.Int, offset)
  .input('limit', sql.Int, 50)
  .query(`SELECT * FROM dbo.Events WHERE tenantId = @tenantId
    ORDER BY sequence DESC, id ASC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`);

// After: after is undefined for the first page, then previous.nextCursor ?? undefined
const page = await client.page<EventRow>('dbo.Events', {
  where: { tenantId },
  orderBy: { sequence: 'desc' },
  key: 'id',
  limit: 50,
  after,
});
// page.rows, page.hasMore, page.nextCursor
```

`EventRow` is an application-defined row interface. `key` declares a unique, non-null
column or composite key; missing key terms are appended ascending. The library cannot
verify database uniqueness. Mixed directions and SQL Server null ordering are supported.
The limit defaults to 50. The query fetches one extra row to detect another page;
`nextCursor` is null on the final or empty page.

Keep the table, filters and ordering unchanged between pages. Projection must include
all ordering columns, and ordering names must be unqualified. Use an index that supports
the filters and ordering. Ordering values must round-trip through the driver exactly;
avoid rounded decimal values and sub-millisecond `datetime2` values. Returned cursor
objects are in-memory markers, not authenticated API tokens; preserve Date/Buffer types
and validate untrusted input when transporting them.

Cursor pagination does not preserve offset/page-number semantics or a snapshot across
calls. Updating ordering values can move rows between pages. Use `tx.page` with an
appropriate isolation level when consistent reads are required, and keep any transaction
short rather than retaining it across HTTP page requests.

### Return rows from a write without a follow-up read

If existing code uses `OUTPUT` or reads a row after inserting/updating it, opt into a row
return rather than treating the default identity/count result as a row:

```ts
const [created] = await client.insert<User>(
  'dbo.Users',
  { name: t.nvarchar(name, 100) },
  { returning: ['id', 'name', 'createdAt'] },
);
const updated = await client.update<User>(
  'dbo.Users', { active: false }, { id }, { returning: true },
);
const removed = await client.delete<User>(
  'dbo.Users', { id }, { returning: ['id', 'name'] },
);
```

`returning: true` selects every column; an explicit array selects distinct, unqualified
column names, not SQL expressions. All three overloads return arrays, with `[]` for no
matches. Without the option, identity/count returns remain unchanged. `tx` supports the
same overloads. `insertMany` and `merge` retain their existing batch result contracts.

Writes use direct `OUTPUT INSERTED` or `OUTPUT DELETED` in the same statement. Verify
defaults, computed columns, rowversion and result types. Row order is not guaranteed,
and values retain driver precision limits; the default `insert` identity conversion does
not apply to BIGINT columns returned through `returning`.

SQL Server rejects direct `OUTPUT` when an enabled trigger exists for that write action.
Retain a custom `query` with `OUTPUT INTO` for those tables. OUTPUT values describe the
statement before subsequent trigger changes, not a post-trigger reread. See the
[SQL Server OUTPUT documentation](https://learn.microsoft.com/en-us/sql/t-sql/queries/output-clause-transact-sql).
A returned row inside a transaction does not prove that transaction committed; consume
it only after `transaction()` succeeds.

### Replace application-side increments with atomic arithmetic

Remove read/modify/write counter logic and compute from the current column value:

```ts
import { inc, t } from '@pilmee/mssql';

await client.update('dbo.Counters', {
  count: inc(), // +1
  balance: inc(t.decimalExact('-0.01', 18, 2)), // subtract exactly
  lastChangedBy: userId, // ordinary assignments can share the statement
}, { id }, { retry: false });
```

`inc(amount)` accepts finite numbers, bigint and non-null numeric typed parameters.
It defaults to 1; negative values subtract and zero is accepted. Unsafe integer numbers
are rejected. Use exact decimal builders or bigint where precision matters. SQL Server
applies the destination type, scale, overflow rules and constraints. SQL null arithmetic
is preserved: a null counter stays null; initialize it with a non-null default if needed.

The expression is valid only in `update` values, including `tx.update`, and can be combined
with `returning`. It is rejected in inserts, merge rows, filters and raw parameters.
Updates still require a non-empty filter and return 0 (or [] with `returning`) for no matches.

Updates containing increments do not inherit automatic retries from the client. Explicit
per-call retry policies and retries of the whole transaction callback can repeat an
increment; opt in only when the prior attempt is known not to have committed. Atomic
arithmetic prevents lost increments but does not guarantee exactly-once delivery.

## 6. Migrate procedures and transactions

```ts
const { rows, output, returnValue } = await client.exec<Order>(
  'dbo.GetCustomerOrders',
  { customerId: t.int(customerId) },
  { output: { total: t.int(null) } },
);
```

`Order` is an application-defined row interface. Procedure calls use RPC. Output parameters require typed builders; compare output values, return codes, and all result sets.

```ts
const orderId = await client.transaction(async (tx) => {
  const id = await tx.insert('dbo.Orders', { customerId, total: t.decimal(total, 10, 2) });
  await tx.insertMany('dbo.OrderLines', lines.map((line) => ({ ...line, orderId: id })));
  return id;
}, { isolationLevel: 'readCommitted' });
```

The callback commits when it resolves and rolls back when it throws. Use `tx` for every operation in that unit of work; calling `client` inside it uses the pool outside that transaction. Do not retain `tx` after the callback. `tx.request()` exposes a transaction-bound raw request; await it sequentially with helper operations because raw requests bypass the helper queue.

Preserve the old isolation level. Exercise rollback and doomed transactions. Batch helpers use savepoints inside an existing transaction, so catching a batch error can allow other work to commit; verify that this is the intended application behavior.

## 7. Move SQL into files or a named catalog

Choose `queryFile` for one exact file per call, or preload a `SqlQueryCatalog` to discover
and validate files at startup and execute them by registered name. Discovery never
executes SQL and is not a schema migration runner.

### Preserve exact-file calls

```ts
const client = new SqlClient(config, {
  sqlDir: new URL('./sql/', import.meta.url),
  cacheSqlFiles: process.env.NODE_ENV !== 'development',
  retry: false,
});

const { rows } = await client.queryFile<User>('users/by-tenant', { tenantId });
// Reads <directory containing this module>/sql/users/by-tenant.sql
```

```sql
-- sql/users/by-tenant.sql
SELECT id, name FROM dbo.Users WHERE tenantId = @tenantId;
```

`queryFile` reads UTF-8, removes a BOM and caches successful reads by default. Paths may
not lexically escape an explicit `sqlDir`; this check does not resolve symlinks. Without
`sqlDir`, paths resolve against the working directory. `GO` batch separators are rejected.

### Discover and register named queries

```ts
import { SqlClient, SqlQueryCatalog } from '@pilmee/mssql';

const sqlCatalog = await SqlQueryCatalog.load({
  dir: new URL('./', import.meta.url),
  pattern: 'src/**/*.sql',
});
const client = new SqlClient(config, { sqlCatalog, retry: false });

const { rows } = await client.queryNamed<User>('src/users/by-tenant', { tenantId });
// Registered from src/users/by-tenant.sql relative to dir
```

To migrate an existing exact-file call without changing its name, load the catalog with
the old `sqlDir` as `dir`. For example, `dir: new URL('./sql/', import.meta.url)` and the
default `**/*.sql` pattern register `sql/users/by-tenant.sql` as `users/by-tenant`; replace
`queryFile('users/by-tenant', params)` with `queryNamed('users/by-tenant', params)`.
`sqlCatalog` and `sqlDir` are independent options and may coexist.

| Requirement | Exact files | Named catalog |
| --- | --- | --- |
| Base directory | `sqlDir` | `SqlQueryCatalog.load({ dir })` |
| Nested files | Specific relative filename | Discovered by the configured pattern |
| Omit extension when executing | `.sql` is appended | Registered names omit the final file extension |
| Different extensions | Include the extension in `queryFile` | Use a pattern such as `**/*.tsql` |
| Configure `sqlExtension` | No such option | No such option; discovery patterns select extensions |
| `src/**/*.sql` | Not accepted by `sqlDir` or `queryFile`; treated literally | Accepted as `pattern` relative to `dir` |
| Multiple patterns | One exact file per call | `pattern: ['src/**/*.sql', 'reports/**/*.tsql']` |
| Inspect names and parameters | No listing API | `names()`, `has(name)`, `get(name)` |
| Pick up file edits | `cacheSqlFiles: false` | Load a new catalog and create a new client |

Catalog names are case-sensitive relative paths with `/`. Patterns support `*`, `?` and
`**` as a complete path segment, not braces, character classes or negation. Absolute
patterns and parent traversal are rejected; symlink files and directories are skipped.
Overlapping matches are deduplicated. Names that collide after stripping extensions are
rejected, as are no matches, empty SQL, unreadable files and `GO` batch separators.

Catalog loading does not connect or validate SQL Server syntax/schema. Required parameter
analysis has the same limitations as `queryFile`. Execution checks missing parameters
before connecting unless `validateParams: false` is set. `get(name)` returns
`{ name, path, text, parameters }`; unknown names fail before connecting. Queries share the
existing `QueryResult` shape and typed parameter binding, and run in a transaction through
`tx.queryNamed`. Their events use `operation: 'queryNamed'` with the name in a SQL comment.
Retries require explicit per-call opt-in because catalog SQL may write data.

### Package the SQL with the application

Copy SQL files into the release artifact while preserving their relative paths. A
module-relative URL resolves from the built module: if `src/db.ts` becomes `dist/db.js`,
ship `dist/sql/...` for the exact-file example. Adjust catalog patterns to the deployed
layout; a source pattern such as `src/**/*.sql` will not find files moved to `dist/sql`.
Bundling does not automatically include SQL assets.

For bundled SQL strings or environments without file access, register an explicit map:

```ts
const sqlCatalog = SqlQueryCatalog.fromQueries({
  'users/by-tenant': 'SELECT id, name FROM dbo.Users WHERE tenantId = @tenantId;',
});
const client = new SqlClient(config, { sqlCatalog, retry: false });
const { rows } = await client.queryNamed<User>('users/by-tenant', { tenantId });
```

`fromQueries` performs the same name/text/parameter analysis and rejects an empty map;
its definitions have `path: null`. Catalogs are startup snapshots and can be shared by
several clients. `cacheSqlFiles` affects only `queryFile`, not a preloaded catalog.

**Exit criterion:** catalog loading and smoke queries succeed from the packaged artifact
under the deployment working directory, with all expected names, parameters and assets.

## 8. Review errors, retries, cancellation, and observability

Start with `retry: false` to isolate the API migration. Then opt into retries deliberately. Read helpers (including `page`) and ordinary CRUD helpers normally retry transient failures. Updates containing `inc`, raw query helpers (including `queryNamed`), procedures, and transaction callbacks require per-call opt-in. Transaction retries rerun the entire callback. Keep HTTP calls, emails, and other external side effects outside retryable callbacks.

Review each catch block. Helper driver failures now throw `SqlQueryError` (a `SqlClientError`) with stable library `code`, underlying `driverCode`, SQL Server `number`, originating `operation`, and original `cause`. Validation uses `SqlClientError`, precision validation uses `SqlPrecisionError`, connection failures use `SqlConnectionError`, cancellation uses `SqlAbortError`, and rollback-mode batch row failures use `BatchRowError`. Raw driver requests and application errors thrown by transaction callbacks retain their original errors. In `onError: 'continue'` batches, inspect `failures` explicitly.

### Error and precision compatibility changes

- Replace `error instanceof sql.RequestError` checks on helper calls with `error instanceof SqlClientError` plus `number`/`driverCode`; the original driver object is available in `cause`. Comparing a helper's thrown error to the original driver error by object identity no longer works.
- `insert` now returns `SqlIdentity | null` (`number | string | null`), and batch `ids` use the same identity type. Safe identities remain numbers; larger identities become exact strings. Update application interfaces that previously assumed every generated id was a number. Do not call `Number(id)` on a large string.
- `t.bigint` rejects unsafe numeric values and out-of-range integers. Supply a decimal string or native `bigint` for large values.
- Use `t.decimalExact`/`t.numericExact` with strings for exact input. The existing decimal builders retain driver numeric behavior; string input alone is not an exactness guarantee.
- Exact builders require SQL expressions and cannot be used in `exec` RPC parameters. Use a SQL text call with a declared decimal variable or procedure string parameters instead.
- General SELECT and procedure outputs retain driver representations. Explicitly SELECT decimal/BIGINT columns as sufficiently sized `varchar` when exact output is needed. See [numeric precision](README.md#numeric-precision).

These changes need a compatibility release: the identity return types widen and helper driver errors are wrapped. Validate consumer typechecks and error handling before upgrading.

Preserve configuration-level driver timeouts. Helper `{ timeout, signal }` additionally bounds/cancels operations; transaction options apply to the whole callback's database work. Opening a connection is bounded by the driver's `connectionTimeout`.

Add success/failure/retry metrics through client events. Debug scripts and event payloads can contain parameter values, so apply the application's existing log redaction rules. Retained raw requests need their own instrumentation.

## 9. Validate and roll out incrementally

1. Type-check and run the application's existing tests after each migrated repository method.
2. Use a real SQL Server test database to compare reads and verify writes, identity behavior, procedures, transaction rollback, and concurrent upserts.
3. Exercise missing parameters/files/query names, duplicate catalog names, empty lists, custom types, cancellation, failed connections, and retry behavior.
4. Verify cursor traversal across ties, mixed directions, nulls and filters; compare concurrent increments, write-return projections and transaction rollback. Check trigger compatibility and precision limits.
5. Build the deployment artifact and run it with the real directory layout and SQL assets.
6. Deploy a small group of migrated read paths first. Compare latency, pool usage, failures, and returned data.
7. Migrate writes after their transaction and failure behavior passes validation. Compare write outcomes using isolated test data, not duplicate production execution.
8. Expand gradually and remove obsolete adapters/pool owners after all callers have moved.

**Release criteria:** unchanged application contracts, correct database effects, complete packaged assets, no pool leaks, and acceptable latency/error metrics.

## 10. Keep rollback simple

Keep the old repository implementation available behind the application's existing rollout mechanism until the new path is stable. Both paths should expose the same application result shapes. Select exactly one path for each write. If rollback is needed, switch new work back to the old implementation, drain in-flight work, and close any client pools that are no longer used.

Because adopting the wrapper itself requires no schema change, rollback normally restores the application code and dependency lockfile. Any schema or data changes introduced alongside it need their own rollback plan.
