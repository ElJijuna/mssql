import type sql from 'mssql';
import { bindInput } from '../types/SqlParam';
import { quoteIdentifier } from '../utils/quoteIdentifier';
import type { SqlRow } from './SqlClient';

/**
 * SQL Server accepts at most 2100 parameters per request; keep some headroom.
 *
 * @internal
 */
export const MAX_PARAMS_PER_REQUEST = 2000;

/**
 * What to do when a row of {@link SqlClient.insertMany} fails.
 * - `'rollback'`: undo every inserted row and throw an {@link InsertManyError}.
 * - `'continue'`: keep the rows that succeeded and report the failures in the result.
 */
export type InsertManyOnError = 'rollback' | 'continue';

/**
 * Binds the row values to `request` as `@p{offset}`, `@p{offset + 1}`… and returns the INSERT statement.
 *
 * @internal
 */
export const buildInsertStatement = (
  target: string,
  row: SqlRow,
  request: sql.Request,
  offset = 0,
): string => {
  const columns = Object.keys(row);

  if (columns.length === 0) {
    return `INSERT INTO ${target} DEFAULT VALUES;`;
  }

  const params = columns.map((column, index) => {
    const name = `p${offset + index}`;

    bindInput(request, name, row[column]);

    return `@${name}`;
  });

  return `INSERT INTO ${target} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${params.join(', ')});`;
};

/**
 * Splits row indexes into chunks that fit in a single request.
 *
 * @internal
 */
export const chunkRows = (
  rows: SqlRow[],
  maxRows: number,
  maxParams = MAX_PARAMS_PER_REQUEST,
): number[][] => {
  const chunks: number[][] = [];

  let current: number[] = [];
  let params = 0;

  rows.forEach((row, index) => {
    const rowParams = Object.keys(row).length;

    if (current.length > 0 && (current.length >= maxRows || params + rowParams > maxParams)) {
      chunks.push(current);
      current = [];
      params = 0;
    }

    current.push(index);
    params += rowParams;
  });

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
};

/**
 * Builds one T-SQL batch that inserts the given rows and tags each statement with the row index,
 * so a failure can be traced back to its row.
 *
 * The batch always returns two recordsets: failures (`i`, `number`, `message`) and ids (`i`, `id`).
 *
 * @internal
 */
export const buildInsertBatch = (
  table: string,
  rows: SqlRow[],
  indexes: number[],
  request: sql.Request,
  onError: InsertManyOnError,
): string => {
  const target = quoteIdentifier(table);

  let offset = 0;

  const statements = indexes.map((index) => {
    const row = rows[index] ?? {};
    const insert = buildInsertStatement(target, row, request, offset);
    const track = `INSERT INTO @_ids VALUES (@_i, SCOPE_IDENTITY());`;

    offset += Object.keys(row).length;

    return onError === 'continue'
      ? `SET @_i = ${index};\nBEGIN TRY ${insert} ${track} END TRY\nBEGIN CATCH INSERT INTO @_errors VALUES (@_i, ERROR_NUMBER(), ERROR_MESSAGE()); END CATCH;`
      : `SET @_i = ${index}; ${insert} ${track}`;
  });
  const header = [
    'DECLARE @_i int;',
    'DECLARE @_ids TABLE (i int NOT NULL, id numeric(38, 0) NULL);',
  ];

  if (onError === 'continue') {
    return [
      ...header,
      'DECLARE @_errors TABLE (i int NOT NULL, number int NOT NULL, message nvarchar(4000) NOT NULL);',
      ...statements,
      'SELECT i, number, message FROM @_errors ORDER BY i;',
      'SELECT i, id FROM @_ids ORDER BY i;',
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
    'SELECT i, id FROM @_ids ORDER BY i;',
  ].join('\n');
};
