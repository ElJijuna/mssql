import sql from 'mssql';
import { SqlClientError } from '../errors/SqlClientError';

/**
 * Configuration accepted by {@link SqlClient}. Same shape as `mssql`'s `config`.
 */
export type SqlClientConfig = sql.config;

/**
 * Thin wrapper around an `mssql` connection pool that will host the helper methods.
 */
export class SqlClient {
  private readonly config: SqlClientConfig;
  private poolPromise: Promise<sql.ConnectionPool> | undefined;

  public constructor(config: SqlClientConfig) {
    this.config = config;
  }

  /**
   * Opens the connection pool. Safe to call multiple times; the pool is created once.
   */
  public async connect(): Promise<sql.ConnectionPool> {
    this.poolPromise ??= this.openPool();

    return this.poolPromise;
  }

  private async openPool(): Promise<sql.ConnectionPool> {
    try {
      return await new sql.ConnectionPool(this.config).connect();
    } catch (error) {
      this.poolPromise = undefined;

      throw new SqlClientError('Failed to connect to SQL Server', { cause: error });
    }
  }

  /**
   * Closes the connection pool if it was opened.
   */
  public async close(): Promise<void> {
    if (!this.poolPromise) {
      return;
    }

    const pool = await this.poolPromise;

    this.poolPromise = undefined;
    await pool.close();
  }
}
