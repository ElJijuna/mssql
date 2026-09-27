import type sql from 'mssql';
import { BatchRowError } from '../errors/BatchRowError';
import { SqlClientError } from '../errors/SqlClientError';
import type { SqlRow } from './SqlClient';

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
export interface BatchOptions {
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
): string => {
  let offset = 0;

  const statements = indexes.map((index) => {
    const row = rows[index] ?? {};
    const statement = build(row, request, offset);

    offset += Object.keys(row).length;

    // Each row gets its own transaction in 'continue' mode so check-then-write statements keep
    // their locks until the row is done.
    return onError === 'continue'
      ? `SET @_i = ${index};\nBEGIN TRY BEGIN TRAN; ${statement} COMMIT TRAN; END TRY\nBEGIN CATCH IF @@TRANCOUNT > 0 ROLLBACK TRAN; INSERT INTO @_errors VALUES (@_i, ERROR_NUMBER(), ERROR_MESSAGE()); END CATCH;`
      : `SET @_i = ${index}; ${statement}`;
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

const describeError = (error: unknown): { number: number | null; message: string } => {
  const number = (error as { number?: unknown } | null)?.number;

  return {
    number: typeof number === 'number' ? number : null,
    message: error instanceof Error ? error.message : String(error),
  };
};
const runChunk = async (
  request: sql.Request,
  rows: SqlRow[],
  indexes: number[],
  onError: BatchOnError,
  build: RowStatementBuilder,
): Promise<BatchOutcome> => {
  const { recordsets } = await request.query(buildBatch(rows, indexes, request, onError, build));
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
  pool: sql.ConnectionPool,
  rows: SqlRow[],
  indexes: number[],
  build: RowStatementBuilder,
): Promise<BatchOutcome> => {
  try {
    return await runChunk(pool.request(), rows, indexes, 'continue', build);
  } catch {
    const outcome: BatchOutcome = { outcomes: [], failures: [] };

    for (const i of indexes) {
      try {
        const single = await runChunk(pool.request(), rows, [i], 'continue', build);

        outcome.outcomes.push(...single.outcomes);
        outcome.failures.push(...single.failures);
      } catch (error) {
        outcome.failures.push({ index: i, row: rows[i] ?? {}, ...describeError(error) });
      }
    }

    return outcome;
  }
};
const rollbackQuietly = async (transaction: sql.Transaction): Promise<void> => {
  try {
    await transaction.rollback();
  } catch {
    // Already rolled back by SQL Server (e.g. XACT_ABORT); the original error is what matters.
  }
};

/**
 * Runs `build` for every row in chunks, honoring {@link BatchOptions}.
 * `validate` returns an error message for rows that must not be sent.
 *
 * @internal
 */
export const executeBatch = async (
  pool: sql.ConnectionPool,
  rows: SqlRow[],
  options: BatchOptions,
  build: RowStatementBuilder,
  validate: (row: SqlRow) => string | null = () => null,
): Promise<BatchOutcome> => {
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
      const chunk = await runChunkOrRowByRow(pool, rows, indexes, build);

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

  const transaction = pool.transaction();

  await transaction.begin();

  try {
    for (const indexes of chunks) {
      const chunk = await runChunk(transaction.request(), rows, indexes, 'rollback', build);
      const [failure] = chunk.failures;

      if (failure) {
        throw new BatchRowError(failure.index, failure.row, failure.number, failure.message);
      }

      result.outcomes.push(...chunk.outcomes);
    }

    await transaction.commit();
  } catch (error) {
    await rollbackQuietly(transaction);

    throw error instanceof SqlClientError
      ? error
      : new SqlClientError('Batch failed', { cause: error });
  }

  return result;
};
