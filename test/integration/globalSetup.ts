import sql from 'mssql';
import { connectionConfig, env } from './env';

const wait = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for SQL Server to accept connections and creates the test database.
 */
export default async function globalSetup(): Promise<void> {
  const deadline = Date.now() + 120_000;

  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const pool = await new sql.ConnectionPool(connectionConfig('master')).connect();

      try {
        await pool
          .request()
          .query(`IF DB_ID(N'${env.database}') IS NULL CREATE DATABASE [${env.database}];`);
      } finally {
        await pool.close();
      }

      return;
    } catch (error) {
      lastError = error;
      await wait(2_000);
    }
  }

  throw new Error(
    `SQL Server not reachable at ${env.host}:${String(env.port)}. Start it with \`npm run db:up\`.`,
    { cause: lastError },
  );
}
