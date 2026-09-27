import sql from 'mssql';
import { SqlClientError } from '../errors/SqlClientError';
import { SqlClient } from './SqlClient';

jest.mock('mssql', () => {
  const ConnectionPool = jest.fn();

  return { __esModule: true, default: { ConnectionPool } };
});

const ConnectionPoolMock = sql.ConnectionPool as unknown as jest.Mock;
const config: sql.config = {
  server: 'localhost',
  user: 'sa',
  password: 'secret',
  database: 'master',
};

describe('SqlClient', () => {
  let pool: { connect: jest.Mock; close: jest.Mock };

  beforeEach(() => {
    pool = { connect: jest.fn(), close: jest.fn().mockResolvedValue(undefined) };
    pool.connect.mockResolvedValue(pool);
    ConnectionPoolMock.mockReset().mockImplementation(() => pool);
  });

  it('creates the pool only once', async () => {
    const client = new SqlClient(config);

    await Promise.all([client.connect(), client.connect()]);

    expect(ConnectionPoolMock).toHaveBeenCalledTimes(1);
    expect(ConnectionPoolMock).toHaveBeenCalledWith(config);
  });

  it('wraps connection errors and allows retrying', async () => {
    pool.connect.mockRejectedValueOnce(new Error('boom'));
    const client = new SqlClient(config);

    await expect(client.connect()).rejects.toBeInstanceOf(SqlClientError);
    await expect(client.connect()).resolves.toBe(pool);
    expect(ConnectionPoolMock).toHaveBeenCalledTimes(2);
  });

  it('closes the pool', async () => {
    const client = new SqlClient(config);

    await client.connect();
    await client.close();

    expect(pool.close).toHaveBeenCalledTimes(1);
  });

  it('does nothing on close when not connected', async () => {
    await expect(new SqlClient(config).close()).resolves.toBeUndefined();
  });
});
