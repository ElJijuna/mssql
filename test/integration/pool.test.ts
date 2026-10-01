import sql from 'mssql';
import { SqlClient } from '../../src';
import { connectionConfig } from './env';

describe('external pool ownership', () => {
  it('shares a real pool across helpers, transactions and raw requests after a borrower closes', async () => {
    const pool = new sql.ConnectionPool(connectionConfig());
    const first = new SqlClient(pool);
    const second = new SqlClient(pool);

    try {
      await expect(first.connect()).resolves.toBe(pool);
      await expect(second.connect()).resolves.toBe(pool);
      await expect(first.query('SELECT 1 AS n')).resolves.toMatchObject({ rows: [{ n: 1 }] });
      await expect(
        second.transaction(async (tx) => tx.query('SELECT 2 AS n')),
      ).resolves.toMatchObject({ rows: [{ n: 2 }] });

      await first.close();

      expect(pool.connected).toBe(true);
      await expect(pool.request().query('SELECT 3 AS n')).resolves.toMatchObject({
        recordset: [{ n: 3 }],
      });
      await expect(second.query('SELECT 4 AS n')).resolves.toMatchObject({ rows: [{ n: 4 }] });
      await expect(first.connect()).resolves.toBe(pool);
    } finally {
      await first.close();
      await second.close();
      await pool.close();
    }
  });

  it('closes a real pool when ownership is transferred', async () => {
    const pool = new sql.ConnectionPool(connectionConfig());
    const client = new SqlClient(pool, { ownsPool: true });

    try {
      await client.connect();
      expect(pool.connected).toBe(true);

      await client.close();

      expect(pool.connected).toBe(false);
    } finally {
      await pool.close();
    }
  });
});
