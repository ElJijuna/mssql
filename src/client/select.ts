import type sql from 'mssql';
import type { QueryOptions } from '../debug/debug';
import { SqlClientError } from '../errors/SqlClientError';
import { quoteIdentifier } from '../utils/quoteIdentifier';
import { bindWhere, type SqlWhere } from './statements';

/**
 * Sort direction.
 */
export type SqlSortDirection = 'asc' | 'desc';

/**
 * Sort order: a column (ascending), a list of columns (ascending), or `{ column: direction }`
 * in priority order.
 *
 * @example
 * 'name'
 * ['lastName', 'firstName']
 * { createdAt: 'desc', id: 'asc' }
 */
export type SqlOrderBy = string | string[] | Record<string, SqlSortDirection>;

/**
 * Options for {@link SqlClient.findOne}.
 */
export interface FindOneOptions extends QueryOptions {
  /** Columns to return. Defaults to every column (`*`). */
  columns?: string[];
  /** Which row wins when several match. */
  orderBy?: SqlOrderBy;
}

/**
 * Options for {@link SqlClient.select}.
 */
export interface SelectOptions extends FindOneOptions {
  /** Maximum rows to return. */
  limit?: number;
  /** Rows to skip before returning results. Requires `orderBy` so pages are stable. */
  offset?: number;
}

const assertCount = (name: string, value: number | undefined): void => {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new SqlClientError(`\`${name}\` must be a non-negative integer, got ${String(value)}`);
  }
};

/**
 * @internal
 */
export const orderByClause = (orderBy: SqlOrderBy | undefined): string => {
  if (orderBy === undefined) {
    return '';
  }

  const entries: Array<[string, string]> =
    typeof orderBy === 'string'
      ? [[orderBy, 'asc']]
      : Array.isArray(orderBy)
        ? orderBy.map((column) => [column, 'asc'])
        : Object.entries(orderBy);

  if (entries.length === 0) {
    return '';
  }

  const terms = entries.map(([column, direction]) => {
    const normalized = direction.toLowerCase();

    if (normalized !== 'asc' && normalized !== 'desc') {
      throw new SqlClientError(`Invalid sort direction "${direction}" for "${column}"`);
    }

    return `${quoteIdentifier(column)} ${normalized.toUpperCase()}`;
  });

  return ` ORDER BY ${terms.join(', ')}`;
};

/**
 * Binds `where` and builds the SELECT statement.
 *
 * - `limit` alone → `SELECT TOP (n)`.
 * - `offset` → `ORDER BY … OFFSET n ROWS [FETCH NEXT m ROWS ONLY]`.
 *
 * @internal
 */
export const buildSelect = (
  table: string,
  where: SqlWhere,
  options: SelectOptions,
  request: sql.Request,
): string => {
  const { columns = [], orderBy, limit, offset } = options;

  assertCount('limit', limit);
  assertCount('offset', offset);

  const order = orderByClause(orderBy);

  if (offset !== undefined && order === '') {
    throw new SqlClientError('`offset` requires `orderBy` so pages are stable');
  }

  const list = columns.length === 0 ? '*' : columns.map(quoteIdentifier).join(', ');
  const top = limit !== undefined && offset === undefined ? `TOP (${limit}) ` : '';
  const { predicate } = bindWhere(where, request, 0);
  const filter = predicate === '' ? '' : ` WHERE ${predicate}`;
  const page =
    offset === undefined
      ? ''
      : ` OFFSET ${offset} ROWS${limit === undefined ? '' : ` FETCH NEXT ${limit} ROWS ONLY`}`;

  return `SELECT ${top}${list} FROM ${quoteIdentifier(table)}${filter}${order}${page};`;
};
