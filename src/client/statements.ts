import type sql from 'mssql';
import { bindInput, SqlParam } from '../types/SqlParam';
import { quoteIdentifier } from '../utils/quoteIdentifier';
import type { SqlRow } from './types';

/**
 * Binds every value of `row` to `request` as `@p{offset}`, `@p{offset + 1}`… and returns the
 * parameter reference for each column.
 *
 * @internal
 */
export const bindRow = (row: SqlRow, request: sql.Request, offset: number): Map<string, string> => {
  const params = new Map<string, string>();

  Object.keys(row).forEach((column, index) => {
    const name = `p${offset + index}`;

    params.set(column, bindInput(request, name, row[column]));
  });

  return params;
};

/**
 * Builds an INSERT for already-bound parameters.
 *
 * @internal
 */
export const insertSql = (target: string, params: Map<string, string>, output = ''): string => {
  if (params.size === 0) {
    return `INSERT INTO ${target}${output} DEFAULT VALUES;`;
  }

  const columns = [...params.keys()].map(quoteIdentifier).join(', ');

  return `INSERT INTO ${target} (${columns})${output} VALUES (${[...params.values()].join(', ')});`;
};

/**
 * Binds the row and returns its INSERT statement.
 *
 * @internal
 */
export const buildInsertStatement = (
  target: string,
  row: SqlRow,
  request: sql.Request,
  offset = 0,
  output = '',
): string => insertSql(target, bindRow(row, request, offset), output);

const isNullValue = (value: unknown): boolean =>
  value === null || value === undefined || (value instanceof SqlParam && value.value === null);

/**
 * Builds a WHERE predicate matching `keys`. `NULL` key values are compared with `IS NULL`.
 *
 * @internal
 */
export const keyPredicate = (keys: string[], row: SqlRow, params: Map<string, string>): string =>
  keys
    .map((key) =>
      isNullValue(row[key])
        ? `${quoteIdentifier(key)} IS NULL`
        : `${quoteIdentifier(key)} = ${params.get(key) ?? 'NULL'}`,
    )
    .join(' AND ');

/**
 * Filter for `select`, `findOne`, `update` and `delete`: column/value equalities joined with `AND`.
 *
 * - A value matches with `=`.
 * - `null` / `undefined` matches with `IS NULL`.
 * - An array matches any of its values with `IN (…)` (a `null` in it adds `OR … IS NULL`;
 *   an empty array matches nothing).
 *
 * @example
 * ```ts
 * { tenantId: 7, status: ['active', 'pending'], deletedAt: null }
 * // [tenantId] = @p0 AND [status] IN (@p1, @p2) AND [deletedAt] IS NULL
 * ```
 */
export type SqlWhere = Record<string, unknown>;

/**
 * Binds the values of `where` starting at `@p{offset}` and returns the predicate and how many
 * parameters it used. An empty `where` returns an empty predicate.
 *
 * @internal
 */
export const bindWhere = (
  where: SqlWhere,
  request: sql.Request,
  offset: number,
): { predicate: string; params: number } => {
  let next = offset;

  const bind = (value: unknown): string => {
    const name = `p${next++}`;

    return bindInput(request, name, value);
  };
  const parts = Object.entries(where).map(([column, value]) => {
    const target = quoteIdentifier(column);

    if (isNullValue(value)) {
      return `${target} IS NULL`;
    }

    if (!Array.isArray(value)) {
      return `${target} = ${bind(value)}`;
    }

    const values = value.filter((item) => !isNullValue(item));
    const includesNull = values.length < value.length;

    if (values.length === 0) {
      return includesNull ? `${target} IS NULL` : '1 = 0';
    }

    const list = `${target} IN (${values.map(bind).join(', ')})`;

    return includesNull ? `(${list} OR ${target} IS NULL)` : list;
  });

  return { predicate: parts.join(' AND '), params: next - offset };
};
