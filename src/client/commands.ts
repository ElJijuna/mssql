import type sql from 'mssql';
import type { QueryOptions, QueryRunner } from '../debug/debug';
import { BatchRowError } from '../errors/BatchRowError';
import { SqlClientError } from '../errors/SqlClientError';
import type { SqlOperation, SqlRowFailureEvent } from '../events/events';
import { quoteIdentifier } from '../utils/quoteIdentifier';
import {
  type BatchConnection,
  type BatchOptions,
  type BatchOutcome,
  type ExecuteBatchParams,
  executeBatch,
  track,
} from './batch';
import { buildMergeStatement, type MergeOptions, missingKey, normalizeKeys } from './merge';
import { bindRow, buildInsertStatement, keyPredicate } from './statements';
import type { InsertManyResult, MergeResult, SqlRow } from './types';

/**
 * Where a helper runs: the pool ({@link SqlClient}) or a transaction ({@link SqlTransaction}).
 *
 * @internal
 */
export interface CommandContext {
  /** Sends SQL through debug logging and events. */
  runner: (operation: SqlOperation, options: QueryOptions) => QueryRunner;
  /** Creates a request for a single-statement helper. */
  request: () => Promise<sql.Request>;
  /** Where batch helpers run. */
  connection: () => Promise<BatchConnection>;
  /** Reports a failed batch row. */
  rowFailure: (event: SqlRowFailureEvent) => void;
}

const requireWhere = (operation: string, where: SqlRow): string[] => {
  const keys = Object.keys(where);

  if (keys.length === 0) {
    throw new SqlClientError(`${operation} requires a non-empty \`where\``);
  }

  return keys;
};
/**
 * Runs a batch and reports every failed row, in both `onError` modes.
 */
const runBatch = async (
  ctx: CommandContext,
  operation: SqlOperation,
  params: Omit<ExecuteBatchParams, 'connection' | 'query'>,
): Promise<BatchOutcome> => {
  try {
    const outcome = await executeBatch({
      ...params,
      connection: await ctx.connection(),
      query: ctx.runner(operation, params.options),
    });

    for (const failure of outcome.failures) {
      ctx.rowFailure({ ...failure, operation });
    }

    return outcome;
  } catch (error) {
    if (error instanceof BatchRowError) {
      ctx.rowFailure({
        operation,
        index: error.index,
        row: error.row,
        number: error.number,
        message: error.sqlMessage,
      });
    }

    throw error;
  }
};

/**
 * @internal
 */
export const insertCommand = async (
  ctx: CommandContext,
  table: string,
  row: SqlRow,
  options: QueryOptions,
): Promise<number | null> => {
  const request = await ctx.request();
  const insert = buildInsertStatement(quoteIdentifier(table), row, request);
  const result = await ctx.runner('insert', options)(
    request,
    `${insert} SELECT SCOPE_IDENTITY() AS id;`,
  );
  const id = result.recordset[0]?.id;

  return typeof id === 'number' ? id : null;
};

/**
 * @internal
 */
export const insertManyCommand = async (
  ctx: CommandContext,
  table: string,
  rows: SqlRow[],
  options: BatchOptions,
): Promise<InsertManyResult> => {
  const result: InsertManyResult = { inserted: 0, ids: rows.map(() => null), failures: [] };

  if (rows.length === 0) {
    return result;
  }

  const target = quoteIdentifier(table);
  const { outcomes, failures } = await runBatch(ctx, 'insertMany', {
    rows,
    options,
    build: (row, request, offset) =>
      `${buildInsertStatement(target, row, request, offset)} ${track('inserted', 'SCOPE_IDENTITY()')}`,
  });

  for (const { i, id } of outcomes) {
    result.ids[i] = id;
    result.inserted += 1;
  }

  result.failures = failures;

  return result;
};

/**
 * @internal
 */
export const mergeCommand = async (
  ctx: CommandContext,
  table: string,
  rows: SqlRow[],
  options: MergeOptions,
): Promise<MergeResult> => {
  const keys = normalizeKeys(options.on);

  if (keys.length === 0) {
    throw new SqlClientError('merge requires at least one key column in `on`');
  }

  keys.forEach(quoteIdentifier);

  const result: MergeResult = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    actions: rows.map(() => null),
    ids: rows.map(() => null),
    failures: [],
  };

  if (rows.length === 0) {
    return result;
  }

  const { outcomes, failures } = await runBatch(ctx, 'merge', {
    rows,
    options,
    build: buildMergeStatement(table, keys, options.update),
    validate: missingKey(keys),
  });

  for (const { i, action, id } of outcomes) {
    result.actions[i] = action;
    result.ids[i] = id;
    result[action] += 1;
  }

  result.failures = failures;

  return result;
};

/**
 * @internal
 */
export const updateCommand = async (
  ctx: CommandContext,
  table: string,
  values: SqlRow,
  where: SqlRow,
  options: QueryOptions,
): Promise<number> => {
  const whereKeys = requireWhere('update', where);

  if (Object.keys(values).length === 0) {
    throw new SqlClientError('update requires at least one column to set');
  }

  const request = await ctx.request();
  const set = bindRow(values, request, 0);
  const match = bindRow(where, request, set.size);
  const assignments = [...set].map(([column, param]) => `${quoteIdentifier(column)} = ${param}`);
  const result = await ctx.runner('update', options)(
    request,
    `UPDATE ${quoteIdentifier(table)} SET ${assignments.join(', ')} WHERE ${keyPredicate(whereKeys, where, match)};`,
  );

  return result.rowsAffected[0] ?? 0;
};

/**
 * @internal
 */
export const deleteCommand = async (
  ctx: CommandContext,
  table: string,
  where: SqlRow,
  options: QueryOptions,
): Promise<number> => {
  const whereKeys = requireWhere('delete', where);
  const request = await ctx.request();
  const match = bindRow(where, request, 0);
  const result = await ctx.runner('delete', options)(
    request,
    `DELETE FROM ${quoteIdentifier(table)} WHERE ${keyPredicate(whereKeys, where, match)};`,
  );

  return result.rowsAffected[0] ?? 0;
};
