# @pilmee/mssql

Helpers on top of [`mssql`](https://www.npmjs.com/package/mssql) to make common Microsoft SQL Server tasks easier.

> **Beta** — the API may change between releases. Install with `npm install @pilmee/mssql@beta`.

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

## Usage

```ts
import { SqlClient } from '@pilmee/mssql';

const client = new SqlClient({
  server: 'localhost',
  database: 'master',
  user: 'sa',
  password: process.env.MSSQL_PASSWORD,
  options: { trustServerCertificate: true },
});

const pool = await client.connect();
const result = await pool.request().query('SELECT 1 AS ok');

await client.close();
```

### Insert a row and get its id

```ts
const id = await client.insert('dbo.Users', { name: 'Ana', email: 'ana@example.com' });
// → 42 (or null if the table has no identity column)
```

Values are sent as parameters and table/column names are bracket-quoted, so user input is never concatenated into the SQL.

### Insert many rows

`insertMany` sends the rows in chunks (one T-SQL batch per chunk, 500 rows by default) and tells you which row failed.

**All or nothing** (default, `onError: 'rollback'`): runs in a transaction; if a row fails nothing is saved and an `InsertManyError` is thrown.

```ts
import { InsertManyError } from '@pilmee/mssql';

try {
  const { ids } = await client.insertMany('dbo.Users', [
    { name: 'Ana', email: 'ana@example.com' },
    { name: 'Luis', email: 'luis@example.com' },
  ]);
  // ids → [101, 102]
} catch (error) {
  if (error instanceof InsertManyError) {
    console.error(`Row ${error.index} failed (${error.number}): ${error.sqlMessage}`, error.row);
  }
}
```

**Best effort** (`onError: 'continue'`): every row is attempted; failures are returned instead of thrown.

```ts
const { inserted, ids, failures } = await client.insertMany('dbo.Users', rows, { onError: 'continue' });
// inserted → 2
// ids      → [101, null, 102]   (null = failed)
// failures → [{ index: 1, row: {...}, number: 2627, message: 'Violation of UNIQUE KEY constraint...' }]
```

Rows can have different columns and can use typed parameters (`t.nvarchar(...)`). Chunks are also split automatically to stay under SQL Server's 2100-parameter limit; tune the size with `chunkSize`.

### Typed parameters

Plain values are typed by `mssql` from the JavaScript value. Use the `t` builders — named after the T-SQL types — to set the exact type and its dimensions:

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
