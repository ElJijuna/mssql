import { SqlClientError } from '../errors/SqlClientError';

const quotePart = (part: string): string => `[${part.replaceAll(']', ']]')}]`;

/**
 * Quotes a SQL Server identifier so it can be safely interpolated into a statement.
 * Accepts multi-part names (`schema.table`); each part is bracket-quoted.
 *
 * @example
 * quoteIdentifier('dbo.Users'); // [dbo].[Users]
 */
export const quoteIdentifier = (name: string): string => {
  const parts = name.split('.');

  if (parts.some((part) => part.trim() === '')) {
    throw new SqlClientError(`Invalid identifier: "${name}"`);
  }

  return parts.map(quotePart).join('.');
};
