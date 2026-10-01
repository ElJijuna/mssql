import type sql from 'mssql';
import type { QueryOptions } from '../debug/debug';
import { SqlClientError } from '../errors/SqlClientError';
import { bindInput } from '../types/SqlParam';
import { quoteIdentifier } from '../utils/quoteIdentifier';
import type { CommandContext } from './commands';
import { orderByClause, type SqlOrderBy, type SqlSortDirection } from './select';
import { bindWhere, type SqlWhere } from './statements';
import type { SqlRow } from './types';

/** In-memory continuation marker. Keep the same table, filters and ordering between pages. */
export interface SqlCursor {
  table: string;
  order: Array<[string, SqlSortDirection]>;
  values: unknown[];
}

export interface PageOptions extends QueryOptions {
  orderBy: SqlOrderBy;
  /** A unique, non-null column (or composite key). Missing terms are appended ascending. */
  key: string | string[];
  where?: SqlWhere;
  /** Projection must include every ordering column. */
  columns?: string[];
  after?: SqlCursor;
  /** Positive integer; defaults to 50. */
  limit?: number;
}

export interface SqlPage<TRow extends object = SqlRow> {
  rows: TRow[];
  hasMore: boolean;
  nextCursor: SqlCursor | null;
}

const pageOrder = (options: PageOptions): Array<[string, SqlSortDirection]> => {
  const input = options.orderBy;
  const terms: Array<[string, SqlSortDirection]> =
    typeof input === 'string'
      ? [[input, 'asc']]
      : Array.isArray(input)
        ? input.map((column) => [column, 'asc'])
        : Object.entries(input);
  const keys = typeof options.key === 'string' ? [options.key] : options.key;

  if (!keys || keys.length === 0 || keys.some((key) => !key)) {
    throw new SqlClientError('`page` requires a unique, non-null `key`.');
  }

  for (const key of keys) {
    if (!terms.some(([column]) => column === key)) {
      terms.push([key, 'asc']);
    }
  }

  if (
    terms.some(([column]) => !column || column.includes('.')) ||
    new Set(terms.map(([column]) => column)).size !== terms.length
  ) {
    throw new SqlClientError('Page ordering requires distinct, unqualified column names.');
  }

  orderByClause(Object.fromEntries(terms));

  if (options.columns?.length && terms.some(([column]) => !options.columns?.includes(column))) {
    throw new SqlClientError('Page projection must include every ordering column.');
  }

  return terms;
};

/** @internal */
export const buildPage = (
  table: string,
  options: PageOptions,
  request: sql.Request,
): { statement: string; order: Array<[string, SqlSortDirection]>; limit: number } => {
  const limit = options.limit ?? 50;
  const order = pageOrder(options);
  const cursor = options.after;

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2147483646) {
    throw new SqlClientError('Page limit must be a positive integer at most 2147483646.');
  }

  if (
    cursor &&
    (cursor.table !== table ||
      JSON.stringify(cursor.order) !== JSON.stringify(order) ||
      !Array.isArray(cursor.values) ||
      cursor.values.length !== order.length ||
      cursor.values.some((value) => value === undefined))
  ) {
    throw new SqlClientError('Cursor does not match the page table and ordering.');
  }

  const filter = bindWhere(options.where ?? {}, request, 0);
  const predicates = filter.predicate ? [filter.predicate] : [];

  if (cursor) {
    const equal: string[] = [];
    const alternatives: string[] = [];

    order.forEach(([column, direction], index) => {
      const target = quoteIdentifier(column);
      const value = cursor.values[index];
      const param = value === null ? null : bindInput(request, `p${filter.params + index}`, value);
      const comparison =
        value === null
          ? direction === 'asc'
            ? `${target} IS NOT NULL`
            : '1 = 0'
          : direction === 'asc'
            ? `${target} > ${param}`
            : `(${target} < ${param} OR ${target} IS NULL)`;

      alternatives.push(`(${[...equal, comparison].join(' AND ')})`);
      equal.push(value === null ? `${target} IS NULL` : `${target} = ${param}`);
    });
    predicates.push(`(${alternatives.join(' OR ')})`);
  }

  const columns = options.columns?.length ? options.columns.map(quoteIdentifier).join(', ') : '*';
  const where = predicates.length
    ? ` WHERE ${predicates.map((predicate) => `(${predicate})`).join(' AND ')}`
    : '';

  return {
    statement: `SELECT TOP (${limit + 1}) ${columns} FROM ${quoteIdentifier(table)}${where}${orderByClause(Object.fromEntries(order))};`,
    order,
    limit,
  };
};

/** @internal */
export const pageCommand = async <TRow extends object>(
  ctx: CommandContext,
  table: string,
  options: PageOptions,
): Promise<SqlPage<TRow>> => {
  const request = await ctx.request();
  const { statement, order, limit } = buildPage(table, options, request);
  const result = await ctx.runner('page', options)(request, statement);
  const rows = result.recordset.slice(0, limit) as unknown as TRow[];
  const hasMore = result.recordset.length > limit;
  const last = rows[rows.length - 1] as SqlRow | undefined;
  const values = last ? order.map(([column]) => last[column]) : [];

  if (hasMore && values.some((value) => value === undefined)) {
    throw new SqlClientError('Ordering columns are missing from the page result.');
  }

  return { rows, hasMore, nextCursor: hasMore ? { table, order, values } : null };
};
