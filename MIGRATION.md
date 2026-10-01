# Migration plan: `mssql` to `@pilmee/mssql`

This guide targets the API in this repository (`@pilmee/mssql` 1.0.1). The package adds helpers on top of `mssql`; it is not a drop-in replacement for its exports. Keep `mssql` installed and migrate one repository method at a time. No database schema or data migration is required by adopting the wrapper.

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
| `result.rowsAffected` | `result.rowsAffected` for `query`, `queryFile`, and `exec` |
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
| Single INSERT | `insert` | Returns an identity or `null`, not the full driver result |
| UPDATE / DELETE | `update` / `delete` | Returns affected-row count; rejects empty filters |
| Many INSERTs | `insertMany` | Transactional by default; returns aligned ids and failure details |
| Upsert | `merge` | Uses locked UPDATE/INSERT logic; verify keys, triggers, and concurrency |
| Joins, OR, ranges, complex SQL | `query` / `queryFile` | Preserve the existing SQL |

```ts
const users = await client.select<User>('dbo.Users', { tenantId, active: true });
const user = await client.findOne<User>('dbo.Users', { id });
const insertedId = await client.insert('dbo.Users', { name: t.nvarchar(name, 100) });
const affected = await client.update('dbo.Users', { active: false }, { id });
```

Do not replace `request.bulk` mechanically with `insertMany`: batching individual inserts has different SQL, throughput, and identity semantics. Keep streaming, TVPs, prepared statements, and batch-specific workflows on raw `mssql` requests unless separately redesigned. See the [official driver API](https://github.com/tediousjs/node-mssql#documentation) for those retained paths.

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

## 7. Move SQL into files when useful

The current API supports a base directory and one exact file per call. It does **not** accept glob patterns or automatically discover/register/execute a directory of files.

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

### Directory, extension, and `src/**/*.sql`

| Requirement | Current support |
| --- | --- |
| Base directory | Yes: `sqlDir: 'src'`, relative to the process working directory, or a file URL |
| Nested files | Yes: `queryFile('features/users/list.sql')` within that base |
| Omit extension | Yes: `queryFile('features/users/list')` appends `.sql` |
| Explicit different extension | Yes: `queryFile('features/users/list.tsql')` reads that exact file |
| Configure a default extension | No: there is no `sqlExtension` option; omitted extensions always become `.sql` |
| `sqlDir: 'src/**/*.sql'` | No: interpreted as a literal directory path |
| `queryFile('src/**/*.sql')` | No: interpreted as a literal file path, normally yielding file-not-found |
| Discover all matching files | No built-in glob/list/preload API |

For files distributed under `src`, use `sqlDir: 'src'` and provide the specific relative filename for each query. For a custom extension, include it on every call. If glob discovery is required, perform it in application/build tooling, select a concrete file, and pass its path relative to `sqlDir` to `queryFile`. Discovery alone should not execute every SQL file: files can have different parameters and database effects.

The loader reads UTF-8, caches successfully loaded files by default, and removes a UTF-8 BOM. Its path check rejects paths that lexically escape an explicitly configured `sqlDir`; it does not resolve symlinks for containment. Without `sqlDir`, paths resolve against the working directory. Files containing `GO` batch separators are rejected. This API is for queries, not a schema migration runner with ordering or a migration history table.

Copy SQL files into the release artifact while preserving their relative paths. A module-relative URL resolves from the built module, so if `src/db.ts` becomes `dist/db.js`, ship `dist/sql/...` for the example above. Bundling does not automatically include SQL assets. Alternatively, import SQL as text with supported bundler tooling and pass that text to `query`.

**Exit criterion:** a smoke query runs from the packaged artifact under the deployment working directory, with all expected SQL files present.

## 8. Review errors, retries, cancellation, and observability

Start with `retry: false` to isolate the API migration. Then opt into retries deliberately: CRUD helpers normally retry transient failures; raw query helpers, procedures, and transaction callbacks require per-call opt-in. Transaction retries rerun the entire callback. Keep HTTP calls, emails, and other external side effects outside retryable callbacks.

Review each catch block. Validation throws `SqlClientError`, connection failures use `SqlConnectionError`, cancellation uses `SqlAbortError`, and rollback-mode batch row failures use `BatchRowError`. Ordinary server query errors can still be driver errors; do not assume every thrown error is wrapped. In `onError: 'continue'` batches, inspect `failures` explicitly.

Preserve configuration-level driver timeouts. Helper `{ timeout, signal }` additionally bounds/cancels operations; transaction options apply to the whole callback's database work. Opening a connection is bounded by the driver's `connectionTimeout`.

Add success/failure/retry metrics through client events. Debug scripts and event payloads can contain parameter values, so apply the application's existing log redaction rules. Retained raw requests need their own instrumentation.

## 9. Validate and roll out incrementally

1. Type-check and run the application's existing tests after each migrated repository method.
2. Use a real SQL Server test database to compare reads and verify writes, identity behavior, procedures, transaction rollback, and concurrent upserts.
3. Exercise missing parameters/files, empty lists, custom types, cancellation, failed connections, and retry behavior.
4. Build the deployment artifact and run it with the real directory layout and SQL assets.
5. Deploy a small group of migrated read paths first. Compare latency, pool usage, failures, and returned data.
6. Migrate writes after their transaction and failure behavior passes validation. Compare write outcomes using isolated test data, not duplicate production execution.
7. Expand gradually and remove obsolete adapters/pool owners after all callers have moved.

**Release criteria:** unchanged application contracts, correct database effects, complete packaged assets, no pool leaks, and acceptable latency/error metrics.

## 10. Keep rollback simple

Keep the old repository implementation available behind the application's existing rollout mechanism until the new path is stable. Both paths should expose the same application result shapes. Select exactly one path for each write. If rollback is needed, switch new work back to the old implementation, drain in-flight work, and close any client pools that are no longer used.

Because adopting the wrapper itself requires no schema change, rollback normally restores the application code and dependency lockfile. Any schema or data changes introduced alongside it need their own rollback plan.
