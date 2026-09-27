import sql from 'mssql';
import { SqlClientError } from '../errors/SqlClientError';
import { t } from '../types/SqlParam';
import { SqlClient } from './SqlClient';

jest.mock('mssql', () => {
  const ConnectionPool = jest.fn();

  return { __esModule: true, default: { ...jest.requireActual('mssql'), ConnectionPool } };
});

const ConnectionPoolMock = sql.ConnectionPool as unknown as jest.Mock;
const config: sql.config = {
  server: 'localhost',
  user: 'sa',
  password: 'secret',
  database: 'master',
};

describe('SqlClient', () => {
  let pool: { connect: jest.Mock; close: jest.Mock; request: jest.Mock };
  let request: { input: jest.Mock; query: jest.Mock };

  beforeEach(() => {
    request = { input: jest.fn(), query: jest.fn().mockResolvedValue({ recordset: [{ id: 42 }] }) };
    pool = {
      connect: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      request: jest.fn(() => request),
    };
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

  describe('insert', () => {
    it('inserts a parameterized row and returns the identity', async () => {
      const client = new SqlClient(config);

      await expect(
        client.insert('dbo.Users', { name: 'Ana', 'e-mail': 'ana@example.com' }),
      ).resolves.toBe(42);

      expect(request.input).toHaveBeenNthCalledWith(1, 'p0', 'Ana');
      expect(request.input).toHaveBeenNthCalledWith(2, 'p1', 'ana@example.com');
      expect(request.query).toHaveBeenCalledWith(
        'INSERT INTO [dbo].[Users] ([name], [e-mail]) VALUES (@p0, @p1); SELECT SCOPE_IDENTITY() AS id;',
      );
    });

    it('binds typed values with their explicit type', async () => {
      const name = t.nvarchar('Ana', 100);

      await new SqlClient(config).insert('Users', { name, age: 30 });

      expect(request.input).toHaveBeenNthCalledWith(1, 'p0', name.type, 'Ana');
      expect(request.input).toHaveBeenNthCalledWith(2, 'p1', 30);
    });

    it('inserts default values when the row is empty', async () => {
      await new SqlClient(config).insert('Logs', {});

      expect(request.input).not.toHaveBeenCalled();
      expect(request.query).toHaveBeenCalledWith(
        'INSERT INTO [Logs] DEFAULT VALUES; SELECT SCOPE_IDENTITY() AS id;',
      );
    });

    it('returns null when the table has no identity column', async () => {
      request.query.mockResolvedValue({ recordset: [{ id: null }] });

      await expect(new SqlClient(config).insert('Tags', { name: 'x' })).resolves.toBeNull();
    });
  });
});
