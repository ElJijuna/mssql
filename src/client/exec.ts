import type sql from 'mssql';
import type { QueryOptions } from '../debug/debug';
import { SqlClientError } from '../errors/SqlClientError';
import { bindInput, SqlExactDecimal, type SqlParam } from '../types/SqlParam';
import { quoteIdentifier } from '../utils/quoteIdentifier';
import type { CommandContext } from './commands';
import type { SqlRow } from './types';

/**
 * Output parameters of a stored procedure: name → typed parameter built with {@link t}. The value
 * is sent as the initial value (use `null` for pure OUTPUT parameters).
 *
 * @example
 * { total: t.int(null), message: t.nvarchar(null, 200) }
 */
export type ExecOutput = Record<string, SqlParam>;

/**
 * Values returned for {@link ExecOutput}, typed from the builders used.
 */
export type ExecOutputValues<TOutput extends ExecOutput> = {
  [TName in keyof TOutput]: TOutput[TName] extends SqlParam<infer TValue> ? TValue | null : unknown;
};

/**
 * Options for {@link SqlClient.exec}.
 */
export interface ExecOptions<TOutput extends ExecOutput = ExecOutput> extends QueryOptions {
  /** OUTPUT parameters. Their values come back in `result.output`. */
  output?: TOutput;
}

/**
 * Result of {@link SqlClient.exec}.
 */
export interface ExecResult<TRow extends object, TOutputValues> {
  /** Rows of the first result set (empty when the procedure returns none). */
  rows: TRow[];
  /** Every result set, in order, for procedures that return several. */
  recordsets: SqlRow[][];
  /** Values of the OUTPUT parameters. */
  output: TOutputValues;
  /** The procedure's `RETURN` value (`0` by default). */
  returnValue: number;
  /** Rows affected by each statement, as reported by mssql. */
  rowsAffected: number[];
}

const paramName = (name: string): string => {
  const bare = name.startsWith('@') ? name.slice(1) : name;

  if (bare === '') {
    throw new SqlClientError(`Invalid parameter name "${name}"`);
  }

  return bare;
};

/**
 * T-SQL equivalent of the RPC call, shown in debug output and events.
 *
 * @internal
 */
export const execScript = (procedure: string, inputs: string[], outputs: string[]): string => {
  const args = [
    ...inputs.map((name) => `@${name} = @${name}`),
    ...outputs.map((name) => `@${name} = @${name} OUTPUT`),
  ];
  const call = `EXEC ${quoteIdentifier(procedure)}${args.length === 0 ? '' : ` ${args.join(', ')}`};`;

  return outputs.length === 0
    ? call
    : `${call}\nSELECT ${outputs.map((name) => `@${name} AS ${quoteIdentifier(name)}`).join(', ')};`;
};

/**
 * @internal
 */
export const execCommand = async <TRow extends object, TOutput extends ExecOutput>(
  ctx: CommandContext,
  procedure: string,
  params: SqlRow,
  options: ExecOptions<TOutput>,
): Promise<ExecResult<TRow, ExecOutputValues<TOutput>>> => {
  if (procedure.trim() === '') {
    throw new SqlClientError('exec requires a procedure name');
  }

  if (
    [...Object.values(params), ...Object.values(options.output ?? {})].some(
      (value) => value instanceof SqlExactDecimal,
    )
  ) {
    throw new SqlClientError(
      'Exact decimal builders require SQL text; use query with EXEC and explicit conversion, or string procedure parameters',
    );
  }

  const query = ctx.runner('exec', options);
  const request = await ctx.request();
  const inputs = Object.entries(params).map(([name, value]) => {
    const bare = paramName(name);

    bindInput(request, bare, value);

    return bare;
  });
  const outputs = Object.entries(options.output ?? {}).map(([name, param]) => {
    const bare = paramName(name);

    request.output(bare, param.type, param.value);

    return bare;
  });
  const result = (await query(request, execScript(procedure, inputs, outputs), async (req) =>
    req.execute<Record<string, unknown>>(procedure),
  )) as sql.IProcedureResult<Record<string, unknown>>;
  const recordsets = (result.recordsets as unknown as SqlRow[][] | undefined) ?? [];

  return {
    rows: (recordsets[0] ?? []) as TRow[],
    recordsets,
    output: (result.output ?? {}) as ExecOutputValues<TOutput>,
    returnValue: typeof result.returnValue === 'number' ? result.returnValue : 0,
    rowsAffected: result.rowsAffected,
  };
};
