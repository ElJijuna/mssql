import type { QueryOptions } from '../debug/debug';
import { SqlClientError } from '../errors/SqlClientError';
import type { SqlOperation } from '../events/events';
import { analyzeSql, type SqlAnalysis } from '../sql/analyze';
import { assertParameters, bindNamedParameters, type SqlParams } from '../sql/bindNamed';
import { compileFragment, isTemplateStringsArray, SqlFragment } from '../sql/fragment';
import type { CommandContext } from './commands';
import type { SqlRow } from './types';

/**
 * Options for {@link SqlClient.query} and {@link SqlClient.queryFile}.
 */
export interface RawQueryOptions extends QueryOptions {
  /**
   * Fail before sending when the SQL references a `@parameter` that wasn't provided. Defaults to
   * `true`. Turn it off if the analysis gets a statement wrong (e.g. dynamic SQL).
   */
  validateParams?: boolean;
}

/**
 * Result of {@link SqlClient.query} and {@link SqlClient.queryFile}.
 */
export interface QueryResult<TRow extends object> {
  /** Rows of the first result set (empty when the SQL returns none). */
  rows: TRow[];
  /** Every result set, in order, for SQL that returns several. */
  recordsets: SqlRow[][];
  /** Rows affected by each statement. */
  rowsAffected: number[];
}

const run = async <TRow extends object>(
  ctx: CommandContext,
  operation: SqlOperation,
  source: string,
  text: string,
  analysis: SqlAnalysis,
  params: SqlParams,
  options: RawQueryOptions,
): Promise<QueryResult<TRow>> => {
  // Validate before connecting, so a missing parameter never costs a round trip.
  if (options.validateParams ?? true) {
    assertParameters(analysis, params, source);
  }

  const query = ctx.runner(operation, options);
  const request = await ctx.request();
  const statement = bindNamedParameters(request, text, analysis, params);
  const display = operation === 'queryFile' ? `-- ${source}\n${statement}` : statement;
  const result = await query(request, display, async (req) =>
    req.query<Record<string, unknown>>(statement),
  );
  const recordsets = (result.recordsets as unknown as SqlRow[][] | undefined) ?? [];

  return {
    rows: (recordsets[0] ?? []) as TRow[],
    recordsets,
    rowsAffected: result.rowsAffected,
  };
};

/**
 * @internal
 */
export const queryCommand = async <TRow extends object>(
  ctx: CommandContext,
  text: string,
  params: SqlParams,
  options: RawQueryOptions,
): Promise<QueryResult<TRow>> => {
  if (text.trim() === '') {
    throw new SqlClientError('query requires SQL text');
  }

  return run<TRow>(ctx, 'query', 'query', text, analyzeSql(text), params, options);
};

/**
 * @internal
 */
export const queryFileCommand = async <TRow extends object>(
  ctx: CommandContext,
  file: string,
  params: SqlParams,
  options: RawQueryOptions,
): Promise<QueryResult<TRow>> => {
  const { name, text, analysis } = await ctx.sqlFile(file);

  return run<TRow>(ctx, 'queryFile', name, text, analysis, params, options);
};

/**
 * The three ways to call `query`: SQL text with parameters, a tagged template, or a {@link tsql}
 * fragment with options.
 *
 * @internal
 */
export type QueryInput = string | TemplateStringsArray | SqlFragment;

/**
 * Normalizes the arguments of `query` into SQL text, parameters and options.
 *
 * @internal
 */
export const normalizeQuery = (
  input: QueryInput,
  rest: unknown[],
): { text: string; params: SqlParams; options: RawQueryOptions } => {
  if (isTemplateStringsArray(input)) {
    return { ...compileFragment(new SqlFragment([...input], rest)), options: {} };
  }

  if (input instanceof SqlFragment) {
    return { ...compileFragment(input), options: (rest[0] as RawQueryOptions | undefined) ?? {} };
  }

  return {
    text: input,
    params: (rest[0] as SqlParams | undefined) ?? {},
    options: (rest[1] as RawQueryOptions | undefined) ?? {},
  };
};
