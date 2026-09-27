import sql from 'mssql';
import { SqlClientError } from '../errors/SqlClientError';
import { bindInput } from '../types/SqlParam';
import { quoteIdentifier } from '../utils/quoteIdentifier';

/**
 * Configuration accepted by {@link SqlClient}. Same shape as `mssql`'s `config`.
 */
export type SqlClientConfig = sql.config;

/**
 * Column/value pairs for a single row. Keys are column names; values are sent as parameters.
 * Use the {@link t} builders to set an explicit type, otherwise mssql infers it from the value.
 */
export type SqlRow = Record<string, unknown>;

/**
 * Thin wrapper around an `mssql` connection pool that will host the helper methods.
 */
export class SqlClient {
  private readonly config: SqlClientConfig;
  private poolPromise: Promise<sql.ConnectionPool> | undefined;

  public constructor(config: SqlClientConfig) {
    this.config = config;
  }

  /**
   * Opens the connection pool. Safe to call multiple times; the pool is created once.
   */
  public async connect(): Promise<sql.ConnectionPool> {
    this.poolPromise ??= this.openPool();

    return this.poolPromise;
  }

  private async openPool(): Promise<sql.ConnectionPool> {
    try {
      return await new sql.ConnectionPool(this.config).connect();
    } catch (error) {
      this.poolPromise = undefined;

      throw new SqlClientError('Failed to connect to SQL Server', { cause: error });
    }
  }

  /**
   * Inserts a single row and returns the identity value generated for it.
   *
   * Values are sent as parameters (never interpolated) and table/column names are
   * bracket-quoted. The id is read with `SCOPE_IDENTITY()`, so it works on tables
   * with triggers.
   *
   * @param table - Table name, optionally schema-qualified (`dbo.Users`).
   * @param row - Column/value pairs to insert. An empty object inserts `DEFAULT VALUES`.
   * @returns The generated identity, or `null` when the table has no identity column.
   *
   * @example
   * const id = await client.insert('dbo.Users', {
   *   name: t.nvarchar('Ana', 100),
   *   email: 'ana@example.com',
   * });
   */
  public async insert(table: string, row: SqlRow): Promise<number | null> {
    const pool = await this.connect();
    const request = pool.request();
    const columns = Object.keys(row);
    const target = quoteIdentifier(table);

    columns.forEach((column, index) => {
      bindInput(request, `p${index}`, row[column]);
    });

    const insert =
      columns.length === 0
        ? `INSERT INTO ${target} DEFAULT VALUES;`
        : `INSERT INTO ${target} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map((_, index) => `@p${index}`).join(', ')});`;
    const result = await request.query<{ id: number | null }>(
      `${insert} SELECT SCOPE_IDENTITY() AS id;`,
    );

    return result.recordset[0]?.id ?? null;
  }

  /**
   * Closes the connection pool if it was opened.
   */
  public async close(): Promise<void> {
    if (!this.poolPromise) {
      return;
    }

    const pool = await this.poolPromise;

    this.poolPromise = undefined;
    await pool.close();
  }
}
