import type sql from 'mssql';

/**
 * A bound parameter as shown in a debug entry.
 */
export interface SqlDebugParam {
  /** Parameter name without `@` (e.g. `p0`). */
  name: string;
  /** T-SQL declaration (e.g. `nvarchar(100)`, `decimal(10, 2)`). */
  type: string;
  /** Value sent to SQL Server. */
  value: unknown;
}

/**
 * What is about to be sent to SQL Server.
 */
export interface SqlDebugEntry {
  /** Helper that produced the query (e.g. `insert`, `merge`). */
  operation: string;
  /** SQL text exactly as sent, with `@p0`, `@p1`… placeholders. */
  sql: string;
  /** Bound parameters. */
  params: SqlDebugParam[];
  /**
   * Ready-to-run script: a `DECLARE` per parameter with its value, followed by the SQL.
   * Paste it into SSMS / Azure Data Studio to reproduce the query.
   */
  script: string;
}

/**
 * Receives every query before it is sent.
 */
export type SqlDebugLogger = (entry: SqlDebugEntry) => void;

/**
 * `true` prints to the console, a function receives the entries, `false` disables debug.
 */
export type SqlDebugOption = boolean | SqlDebugLogger;

/**
 * Options accepted by every helper.
 */
export interface QueryOptions {
  /**
   * Print the SQL of this call. Overrides the client-level `debug` option, so `false` silences a
   * single call when debug is on globally.
   */
  debug?: SqlDebugOption;
}

type RequestParameter = sql.IRequestParameters[string];

const MAX_LENGTH: Record<string, number> = { varchar: 8000, varbinary: 8000, nvarchar: 4000 };

/**
 * T-SQL declaration of a bound parameter, e.g. `nvarchar(100)`.
 *
 * @internal
 */
export const declareParam = (param: RequestParameter): string => {
  const { declaration = 'sql_variant' } = param.type as { declaration?: string };
  const { length, precision, scale } = param;

  switch (declaration) {
    case 'varchar':
    case 'nvarchar':
    case 'varbinary':
      return `${declaration}(${length === null || length === undefined || length > (MAX_LENGTH[declaration] ?? 0) ? 'max' : length})`;
    case 'char':
    case 'nchar':
    case 'binary':
      return `${declaration}(${length ?? 1})`;
    case 'decimal':
    case 'numeric':
      return `${declaration}(${precision ?? 18}, ${scale ?? 0})`;
    case 'time':
    case 'datetime2':
    case 'datetimeoffset':
      return `${declaration}(${scale ?? 7})`;
    default:
      return declaration;
  }
};

/**
 * T-SQL literal for a parameter value.
 *
 * @internal
 */
export const toLiteral = (value: unknown): string => {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }

  if (value instanceof Date) {
    return `N'${value.toISOString().replace('T', ' ').replace('Z', '')}'`;
  }

  if (Buffer.isBuffer(value)) {
    return `0x${value.toString('hex')}`;
  }

  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');

  return `N'${text.replaceAll("'", "''")}'`;
};

/**
 * Builds the debug entry for a request about to run `text`.
 *
 * @internal
 */
export const createDebugEntry = (
  operation: string,
  request: sql.Request,
  text: string,
): SqlDebugEntry => {
  const params = Object.values(request.parameters).map((param) => ({
    name: param.name,
    type: declareParam(param),
    value: param.value as unknown,
  }));
  const declarations = params.map(
    ({ name, type, value }) => `DECLARE @${name} ${type} = ${toLiteral(value)};`,
  );

  return { operation, sql: text, params, script: [...declarations, text].join('\n') };
};

/**
 * Default logger: prints the runnable script with `console.debug`.
 *
 * @internal
 */
export const consoleLogger: SqlDebugLogger = (entry) => {
  console.debug(`-- [@pilmee/mssql] ${entry.operation}\n${entry.script}\n`);
};

/**
 * Picks the call-level option over the client-level one.
 *
 * @internal
 */
export const resolveLogger = (
  clientOption: SqlDebugOption | undefined,
  callOption: SqlDebugOption | undefined,
): SqlDebugLogger | null => {
  const option = callOption ?? clientOption ?? false;

  if (option === false) {
    return null;
  }

  return option === true ? consoleLogger : option;
};

/**
 * Runs `text` on `request`. Every helper query goes through one, so it can be logged and observed.
 * `run` replaces the default `request.query(text)`, e.g. to execute a stored procedure; `text` is
 * then only what debug output and events show.
 *
 * @internal
 */
export type QueryRunner = (
  request: sql.Request,
  text: string,
  run?: (request: sql.Request) => Promise<sql.IResult<Record<string, unknown>>>,
) => Promise<sql.IResult<Record<string, unknown>>>;
