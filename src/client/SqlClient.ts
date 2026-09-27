import sql from 'mssql';
import { InsertManyError } from '../errors/InsertManyError';
import { SqlClientError } from '../errors/SqlClientError';
import { quoteIdentifier } from '../utils/quoteIdentifier';
import {
  buildInsertBatch,
  buildInsertStatement,
  chunkRows,
  type InsertManyOnError,
} from './insertSql';

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
 * Options for {@link SqlClient.insertMany}.
 */
export interface InsertManyOptions {
  /**
   * What to do when a row fails. Defaults to `'rollback'` (all or nothing).
   */
  onError?: InsertManyOnError;
  /**
   * Maximum rows sent per round trip. Defaults to `500`. Chunks are also split to stay under
   * SQL Server's 2100-parameter limit.
   */
  chunkSize?: number;
}

/**
 * A row that failed in {@link SqlClient.insertMany} with `onError: 'continue'`.
 */
export interface InsertManyFailure {
  /** Position of the row in the input array. */
  index: number;
  /** The row that failed. */
  row: SqlRow;
  /**
   * SQL Server error number (e.g. 2627 for a unique key violation), or `null` when the error did
   * not come from SQL Server (e.g. a value rejected by the driver before sending it).
   */
  number: number | null;
  /** Error message. */
  message: string;
}

/**
 * Result of {@link SqlClient.insertMany}.
 */
export interface InsertManyResult {
  /** Number of rows inserted. */
  inserted: number;
  /**
   * Generated identities aligned with the input rows. `null` for failed rows or tables without an
   * identity column.
   */
  ids: Array<number | null>;
  /** Rows that failed. Always empty in `'rollback'` mode (it throws instead). */
  failures: InsertManyFailure[];
}

interface BatchResult {
  failures: Array<{ i: number; number: number | null; message: string }>;
  ids: Array<{ i: number; id: number | null }>;
}

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

    return this.insertOne(pool.request(), table, row);
  }

  private async insertOne(
    request: sql.Request,
    table: string,
    row: SqlRow,
  ): Promise<number | null> {
    const insert = buildInsertStatement(quoteIdentifier(table), row, request);
    const result = await request.query<{ id: number | null }>(
      `${insert} SELECT SCOPE_IDENTITY() AS id;`,
    );

    return result.recordset[0]?.id ?? null;
  }

  /**
   * Inserts many rows in as few round trips as possible and tells you exactly which row failed.
   *
   * Rows are sent in chunks; each chunk is a single T-SQL batch. Rows may have different columns.
   *
   * - `onError: 'rollback'` (default): runs in a transaction. If any row fails, nothing is
   *   persisted and an {@link InsertManyError} is thrown with the failing row's `index`.
   * - `onError: 'continue'`: every row is attempted and this method never throws once connected;
   *   failures are returned in `result.failures`. If a whole chunk is rejected (e.g. an unknown
   *   column, or a value the driver refuses), its rows are retried one by one to find the culprits.
   *
   * @param table - Table name, optionally schema-qualified (`dbo.Users`).
   * @param rows - Rows to insert.
   * @param options - See {@link InsertManyOptions}.
   *
   * @example
   * try {
   *   const { ids } = await client.insertMany('dbo.Users', [{ name: 'Ana' }, { name: 'Luis' }]);
   * } catch (error) {
   *   if (error instanceof InsertManyError) {
   *     console.error(`Row ${error.index} failed`, error.row, error.sqlMessage);
   *   }
   * }
   */
  public async insertMany(
    table: string,
    rows: SqlRow[],
    options: InsertManyOptions = {},
  ): Promise<InsertManyResult> {
    const { onError = 'rollback', chunkSize = 500 } = options;
    const result: InsertManyResult = { inserted: 0, ids: rows.map(() => null), failures: [] };

    if (rows.length === 0) {
      return result;
    }

    const pool = await this.connect();
    const chunks = chunkRows(rows, chunkSize);

    if (onError === 'continue') {
      for (const indexes of chunks) {
        this.collect(result, rows, await this.runBatchOrRowByRow(pool, table, rows, indexes));
      }

      return result;
    }

    const transaction = pool.transaction();

    await transaction.begin();

    try {
      for (const indexes of chunks) {
        const batch = await this.runBatch(transaction.request(), table, rows, indexes, onError);
        const [failure] = batch.failures;

        if (failure) {
          throw new InsertManyError(
            failure.i,
            rows[failure.i] ?? {},
            failure.number,
            failure.message,
          );
        }

        this.collect(result, rows, batch);
      }

      await transaction.commit();
    } catch (error) {
      await this.rollbackQuietly(transaction);

      throw error instanceof SqlClientError
        ? error
        : new SqlClientError('insertMany failed', { cause: error });
    }

    return result;
  }

  private async runBatch(
    request: sql.Request,
    table: string,
    rows: SqlRow[],
    indexes: number[],
    onError: InsertManyOnError,
  ): Promise<BatchResult> {
    const batch = buildInsertBatch(table, rows, indexes, request, onError);
    const { recordsets } = await request.query(batch);
    const [failures = [], ids = []] = recordsets as unknown as [
      BatchResult['failures'],
      BatchResult['ids'],
    ];

    return { failures, ids };
  }

  /**
   * Runs a chunk in `'continue'` mode. When the whole batch is rejected (a compile error, or a
   * value the driver refuses before sending), retries its rows one by one so each failure is
   * attributed to its row and the remaining rows still get inserted.
   */
  private async runBatchOrRowByRow(
    pool: sql.ConnectionPool,
    table: string,
    rows: SqlRow[],
    indexes: number[],
  ): Promise<BatchResult> {
    try {
      return await this.runBatch(pool.request(), table, rows, indexes, 'continue');
    } catch {
      const batch: BatchResult = { failures: [], ids: [] };

      for (const i of indexes) {
        try {
          batch.ids.push({ i, id: await this.insertOne(pool.request(), table, rows[i] ?? {}) });
        } catch (error) {
          batch.failures.push({ i, ...describeError(error) });
        }
      }

      return batch;
    }
  }

  private async rollbackQuietly(transaction: sql.Transaction): Promise<void> {
    try {
      await transaction.rollback();
    } catch {
      // Already rolled back by SQL Server (e.g. XACT_ABORT); the original error is what matters.
    }
  }

  private collect(result: InsertManyResult, rows: SqlRow[], batch: BatchResult): void {
    for (const { i, id } of batch.ids) {
      result.ids[i] = id;
      result.inserted += 1;
    }

    for (const { i, number, message } of batch.failures) {
      result.failures.push({ index: i, row: rows[i] ?? {}, number, message });
    }
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

const describeError = (error: unknown): { number: number | null; message: string } => {
  const number = (error as { number?: unknown } | null)?.number;

  return {
    number: typeof number === 'number' ? number : null,
    message: error instanceof Error ? error.message : String(error),
  };
};
