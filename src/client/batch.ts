import type sql from 'mssql';
import type { QueryOptions, QueryRunner } from '../debug/debug';
import { BatchRowError } from '../errors/BatchRowError';
import { SqlAbortError } from '../errors/SqlAbortError';
import { SqlClientError } from '../errors/SqlClientError';
import type { SqlRow } from './types';

/**
 * SQL Server accepts at most 2100 parameters per request; keep some headroom.
 *
 * @internal
 */
export const MAX_PARAMS_PER_REQUEST = 2000;

/**
 * What to do when a row of a batch operation fails.
 * - `'rollback'`: undo every row and throw a {@link BatchRowError}.
 * - `'continue'`: keep the rows that succeeded and report the failures in the result.
 */
export type BatchOnError = 'rollback' | 'continue';

/**
 * Options shared by batch operations ({@link SqlClient.insertMany}, {@link SqlClient.merge}).
 */
export interface BatchOptions extends QueryOptions {
  /**
   * What to do when a row fails. Defaults to `'rollback'` (all or nothing).
   */
  onError?: BatchOnError;
  /**
   * Maximum rows sent per round trip. Defaults to `500`. Chunks are also split to stay under
   * SQL Server's 2100-parameter limit.
   */
  chunkSize?: number;
}

/**
 * A row that failed in a batch operation with `onError: 'continue'`.
 */
export interface RowFailure {
  /** Position of the row in the input array. */
  index: number;
  /** The row that failed. */
  row: SqlRow;
  /**
   * SQL Server error number (e.g. 2627 for a unique key violation), or `null` when the error did
   * not come from SQL Server (e.g. a value rejected by the driver, or a validation error).
   */
  number: number | null;
  /** Error message. */
  message: string;
}

/**
 * What happened to a row.
 */
export type RowAction = 'inserted' | 'updated' | 'skipped';

/**
 * @internal
 */
export interface RowOutcome {
  i: number;
  action: RowAction;
  id: number | null;
}

/**
 * @internal
 */
export interface BatchOutcome {
  outcomes: RowOutcome[];
  failures: RowFailure[];
}

/**
 * Builds the statement for one row: binds its values starting at `@p{offset}` and records the
 * outcome with {@link track}.
 *
 * @internal
 */
export type RowStatementBuilder = (row: SqlRow, request: sql.Request, offset: number) => string;

/**
 * Records the outcome of the current row (`@_i`).
 *
 * @internal
 */
export const track = (action: RowAction, id = 'NULL'): string =>
  `INSERT INTO @_out VALUES (@_i, '${action}', ${id});`;

/**
 * Splits row indexes into chunks that fit in a single request.
 *
 * @internal
 */
export const chunkRows = (
  rows: SqlRow[],
  indexes: number[],
  maxRows: number,
  maxParams = MAX_PARAMS_PER_REQUEST,
): number[][] => {
  const chunks: number[][] = [];

  let current: number[] = [];
  let params = 0;

  for (const index of indexes) {
    const rowParams = Object.keys(rows[index] ?? {}).length;

    if (current.length > 0 && (current.length >= maxRows || params + rowParams > maxParams)) {
      chunks.push(current);
      current = [];
      params = 0;
    }

    current.push(index);
    params += rowParams;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
};

/**
 * Builds one T-SQL batch for the given rows, tagging each statement with its row index so a
 * failure can be traced back to its row.
 *
 * The batch always returns two recordsets: failures (`i`, `number`, `message`) and outcomes
 * (`i`, `action`, `id`).
 *
 * @internal
 */
export const buildBatch = (
  rows: SqlRow[],
  indexes: number[],
  request: sql.Request,
  onError: BatchOnError,
  build: RowStatementBuilder,
  nested = false,
): string => {
  let offset = 0;

  const statements = indexes.map((index) => {
    const row = rows[index] ?? {};
    const statement = build(row, request, offset);

    offset += Object.keys(row).length;

    if (onError === 'rollback') {
      return `SET @_i = ${index}; ${statement}`;
    }

    // Inside a caller's transaction each row gets a savepoint, so a failed row is undone without
    // rolling back the caller's work.
    if (nested) {
      return `SET @_i = ${index}; SAVE TRAN _row;\nBEGIN TRY ${statement} END TRY\nBEGIN CATCH IF XACT_STATE() = 1 ROLLBACK TRAN _row; INSERT INTO @_errors VALUES (@_i, ERROR_NUMBER(), ERROR_MESSAGE()); END CATCH;`;
    }

    // Otherwise each row gets its own transaction so check-then-write statements keep their locks
    // until the row is done.
    return `SET @_i = ${index};\nBEGIN TRY BEGIN TRAN; ${statement} COMMIT TRAN; END TRY\nBEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK TRAN; INSERT INTO @_errors VALUES (@_i, ERROR_NUMBER(), ERROR_MESSAGE()); END CATCH;`;
  });
  const header = [
    'DECLARE @_i int;',
    'DECLARE @_out TABLE (i int NOT NULL, action varchar(10) NOT NULL, id numeric(38, 0) NULL);',
  ];
  const footer = 'SELECT i, action, id FROM @_out ORDER BY i;';

  if (onError === 'continue') {
    return [
      ...header,
      'DECLARE @_errors TABLE (i int NOT NULL, number int NOT NULL, message nvarchar(4000) NOT NULL);',
      ...statements,
      'SELECT i, number, message FROM @_errors ORDER BY i;',
      footer,
    ].join('\n');
  }

  // Variables (not a table) hold the error: a doomed transaction only allows reads until rollback.
  return [
    ...header,
    'DECLARE @_errNumber int, @_errMessage nvarchar(4000);',
    'BEGIN TRY',
    ...statements,
    'END TRY',
    'BEGIN CATCH SELECT @_errNumber = ERROR_NUMBER(), @_errMessage = ERROR_MESSAGE(); END CATCH;',
    'SELECT @_i AS i, @_errNumber AS number, @_errMessage AS message WHERE @_errNumber IS NOT NULL;',
    footer,
  ].join('\n');
};

/**
 * Extracts the SQL Server error number (if any) and message from an error.
 *
 * @internal
 */
export const describeError = (error: unknown): { number: number | null; message: string } => {
  const number = (error as { number?: unknown } | null)?.number;

  return {
    number: typeof number === 'number' ? number : null,
    message: error instanceof Error ? error.message : String(error),
  };
};

const runChunk = async (
  query: QueryRunner,
  request: sql.Request,
  rows: SqlRow[],
  indexes: number[],
  onError: BatchOnError,
  build: RowStatementBuilder,
  nested: boolean,
): Promise<BatchOutcome> => {
  const { recordsets } = await query(
    request,
    buildBatch(rows, indexes, request, onError, build, nested),
  );
  const [failures = [], outcomes = []] = recordsets as unknown as [
    Array<{ i: number; number: number | null; message: string }>,
    RowOutcome[],
  ];

  return {
    outcomes,
    failures: failures.map(({ i, number, message }) => ({
      index: i,
      row: rows[i] ?? {},
      number,
      message,
    })),
  };
};
/**
 * In `'continue'` mode, when the whole chunk is rejected (a compile error, or a value the driver
 * refuses before sending), retries its rows one by one so each failure is attributed to its row.
 */
const runChunkOrRowByRow = async (
  query: QueryRunner,
  connection: BatchConnection,
  rows: SqlRow[],
  indexes: number[],
  build: RowStatementBuilder,
): Promise<BatchOutcome> => {
  const { request, nested } = connection;

  try {
    return await runChunk(query, request(), rows, indexes, 'continue', build, nested);
  } catch (chunkError) {
    // A cancelled call stops the whole batch; it is not a row failure to retry.
    if (chunkError instanceof SqlAbortError) {
      throw chunkError;
    }

    const outcome: BatchOutcome = { outcomes: [], failures: [] };

    for (const i of indexes) {
      try {
        const single = await runChunk(query, request(), rows, [i], 'continue', build, nested);

        outcome.outcomes.push(...single.outcomes);
        outcome.failures.push(...single.failures);
      } catch (error) {
        if (error instanceof SqlAbortError) {
          throw error;
        }

        outcome.failures.push({ index: i, row: rows[i] ?? {}, ...describeError(error) });
      }
    }

    return outcome;
  }
};

/**
 * Runs `rollback`, ignoring its errors: the transaction may already be rolled back by SQL Server
 * (e.g. XACT_ABORT), and the original error is what matters.
 *
 * @internal
 */
export const rollbackQuietly = async (rollback: () => Promise<unknown>): Promise<void> => {
  try {
    await rollback();
  } catch {
    // Ignored on purpose.
  }
};

/**
 * An all-or-nothing scope for `'rollback'` mode: a transaction, or a savepoint when already inside
 * one.
 *
 * @internal
 */
export interface BatchScope {
  request: () => sql.Request;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

/**
 * Where a batch runs: directly on the pool, or inside a caller's transaction (`nested`).
 *
 * @internal
 */
export interface BatchConnection {
  /** Creates a request for `'continue'` mode. */
  request: () => sql.Request;
  /** Opens the scope used by `'rollback'` mode. */
  begin: () => Promise<BatchScope>;
  /** Running inside a caller's transaction: per-row isolation uses savepoints. */
  nested: boolean;
}

/**
 * A {@link BatchConnection} on the pool: `'rollback'` mode opens its own transaction.
 *
 * @internal
 */
export const poolConnection = (pool: sql.ConnectionPool): BatchConnection => ({
  request: () => pool.request(),
  nested: false,
  begin: async () => {
    const transaction = pool.transaction();

    await transaction.begin();

    return {
      request: () => transaction.request(),
      commit: async () => {
        await transaction.commit();
      },
      rollback: async () => {
        await transaction.rollback();
      },
    };
  },
});

/**
 * @internal
 */
export interface ExecuteBatchParams {
  connection: BatchConnection;
  rows: SqlRow[];
  options: BatchOptions;
  build: RowStatementBuilder;
  query: QueryRunner;
  /** Returns an error message for rows that must not be sent. */
  validate?: (row: SqlRow) => string | null;
}

/**
 * Runs `build` for every row in chunks, honoring {@link BatchOptions}.
 *
 * @internal
 */
export const executeBatch = async ({
  connection,
  rows,
  options,
  build,
  query,
  validate = () => null,
}: ExecuteBatchParams): Promise<BatchOutcome> => {
  const { onError = 'rollback', chunkSize = 500 } = options;
  const result: BatchOutcome = { outcomes: [], failures: [] };
  const valid: number[] = [];

  rows.forEach((row, index) => {
    const problem = validate(row);

    if (problem === null) {
      valid.push(index);
    } else {
      result.failures.push({ index, row, number: null, message: problem });
    }
  });

  const chunks = chunkRows(rows, valid, chunkSize);

  if (onError === 'continue') {
    for (const indexes of chunks) {
      const chunk = await runChunkOrRowByRow(query, connection, rows, indexes, build);

      result.outcomes.push(...chunk.outcomes);
      result.failures.push(...chunk.failures);
    }

    result.failures.sort((a, b) => a.index - b.index);

    return result;
  }

  const [invalid] = result.failures;

  if (invalid) {
    throw new BatchRowError(invalid.index, invalid.row, invalid.number, invalid.message);
  }

  const scope = await connection.begin();

  try {
    for (const indexes of chunks) {
      const chunk = await runChunk(
        query,
        scope.request(),
        rows,
        indexes,
        'rollback',
        build,
        connection.nested,
      );
      const [failure] = chunk.failures;

      if (failure) {
        throw new BatchRowError(failure.index, failure.row, failure.number, failure.message);
      }

      result.outcomes.push(...chunk.outcomes);
    }

    await scope.commit();
  } catch (error) {
    await rollbackQuietly(scope.rollback);

    throw error instanceof SqlClientError
      ? error
      : new SqlClientError('Batch failed', { cause: error });
  }

  return result;
};
