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
