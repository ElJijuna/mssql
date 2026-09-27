import { SqlClient, type SqlClientOptions } from '../../src';
import { connectionConfig } from './env';

/**
 * A client on the integration database.
 */
export const createClient = (options?: SqlClientOptions): SqlClient =>
  new SqlClient(connectionConfig(), options);

/**
 * Runs DDL statements one by one (each may need its own batch, e.g. CREATE PROCEDURE).
 */
export const ddl = async (client: SqlClient, ...statements: string[]): Promise<void> => {
  for (const statement of statements) {
    await client.query(statement, {}, { validateParams: false });
  }
};

/**
 * Counts the rows of a table.
 */
export const count = async (client: SqlClient, table: string): Promise<number> => {
  const { rows } = await client.query<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table};`);

  return rows[0]?.total ?? 0;
};
