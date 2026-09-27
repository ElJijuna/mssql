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

    bindInput(request, name, row[column]);
    params.set(column, `@${name}`);
  });

  return params;
};

/**
 * Builds an INSERT for already-bound parameters.
 *
 * @internal
 */
export const insertSql = (target: string, params: Map<string, string>): string => {
  if (params.size === 0) {
    return `INSERT INTO ${target} DEFAULT VALUES;`;
  }

  const columns = [...params.keys()].map(quoteIdentifier).join(', ');

  return `INSERT INTO ${target} (${columns}) VALUES (${[...params.values()].join(', ')});`;
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
): string => insertSql(target, bindRow(row, request, offset));

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
