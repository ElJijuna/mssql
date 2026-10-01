import type { QueryOptions } from '../debug/debug';
import { SqlClientError } from '../errors/SqlClientError';
import { quoteIdentifier } from '../utils/quoteIdentifier';

/** Return all written columns, or an explicit projection. */
export interface ReturningOptions extends QueryOptions {
  returning: true | string[];
}

/** @internal */
export const outputClause = (
  source: 'INSERTED' | 'DELETED',
  returning: true | string[],
): string => {
  if (returning === true) {
    return ` OUTPUT ${source}.*`;
  }

  if (
    !Array.isArray(returning) ||
    returning.length === 0 ||
    returning.some((column) => typeof column !== 'string' || !column || column.includes('.')) ||
    new Set(returning).size !== returning.length
  ) {
    throw new SqlClientError('`returning` requires true or distinct, unqualified column names.');
  }

  return ` OUTPUT ${returning.map((column) => `${source}.${quoteIdentifier(column)}`).join(', ')}`;
};
