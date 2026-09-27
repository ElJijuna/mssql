import sql from 'mssql';
import { InsertManyError } from '../errors/InsertManyError';
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
  let pool: { connect: jest.Mock; close: jest.Mock; request: jest.Mock; transaction: jest.Mock };
  let request: { input: jest.Mock; query: jest.Mock };
  let transaction: { begin: jest.Mock; commit: jest.Mock; rollback: jest.Mock; request: jest.Mock };

  beforeEach(() => {
    request = { input: jest.fn(), query: jest.fn().mockResolvedValue({ recordset: [{ id: 42 }] }) };
    pool = {
      connect: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      request: jest.fn(() => request),
      transaction: jest.fn(() => transaction),
    };
    transaction = {
      begin: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
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

  describe('insertMany', () => {
    const rows = [{ name: 'Ana' }, { name: 'Luis' }, { name: 'Eva' }];
    const captureError = async (promise: Promise<unknown>): Promise<unknown> => {
      try {
        await promise;
      } catch (error) {
        return error;
      }

      throw new Error('Expected promise to reject');
    };
    const batchResult = (failures: unknown[], ids: unknown[]) => ({ recordsets: [failures, ids] });

    it('returns without connecting when there are no rows', async () => {
      await expect(new SqlClient(config).insertMany('Users', [])).resolves.toEqual({
        inserted: 0,
        ids: [],
        failures: [],
      });
      expect(ConnectionPoolMock).not.toHaveBeenCalled();
    });

    it('inserts every row in a transaction and returns the ids', async () => {
      request.query.mockResolvedValue(
        batchResult(
          [],
          [
            { i: 0, id: 1 },
            { i: 1, id: 2 },
            { i: 2, id: 3 },
          ],
        ),
      );

      await expect(new SqlClient(config).insertMany('Users', rows)).resolves.toEqual({
        inserted: 3,
        ids: [1, 2, 3],
        failures: [],
      });
      expect(transaction.begin).toHaveBeenCalled();
      expect(transaction.commit).toHaveBeenCalled();
      expect(transaction.rollback).not.toHaveBeenCalled();
    });

    it('sends one batch per chunk', async () => {
      request.query
        .mockResolvedValueOnce(
          batchResult(
            [],
            [
              { i: 0, id: 1 },
              { i: 1, id: 2 },
            ],
          ),
        )
        .mockResolvedValueOnce(batchResult([], [{ i: 2, id: 3 }]));

      const result = await new SqlClient(config).insertMany('Users', rows, { chunkSize: 2 });

      expect(request.query).toHaveBeenCalledTimes(2);
      expect(result.ids).toEqual([1, 2, 3]);
    });

    it('rolls back and reports the failing row', async () => {
      request.query.mockResolvedValue(
        batchResult(
          [{ i: 1, number: 2627, message: 'Violation of UNIQUE KEY' }],
          [{ i: 0, id: 1 }],
        ),
      );

      const error = await captureError(new SqlClient(config).insertMany('Users', rows));

      expect(error).toBeInstanceOf(InsertManyError);
      expect(error).toMatchObject({
        index: 1,
        row: { name: 'Luis' },
        number: 2627,
        sqlMessage: 'Violation of UNIQUE KEY',
      });
      expect(transaction.rollback).toHaveBeenCalled();
      expect(transaction.commit).not.toHaveBeenCalled();
    });

    it('rolls back and wraps unexpected errors', async () => {
      const cause = new Error('Invalid column name');

      request.query.mockRejectedValue(cause);
      transaction.rollback.mockRejectedValue(new Error('already aborted'));

      const error = await captureError(new SqlClient(config).insertMany('Users', rows));

      expect(error).toBeInstanceOf(SqlClientError);
      expect(error).not.toBeInstanceOf(InsertManyError);
      expect((error as SqlClientError).cause).toBe(cause);
    });

    it('keeps going and returns failures in continue mode', async () => {
      request.query.mockResolvedValue(
        batchResult(
          [{ i: 1, number: 547, message: 'FOREIGN KEY constraint' }],
          [
            { i: 0, id: 1 },
            { i: 2, id: 3 },
          ],
        ),
      );

      await expect(
        new SqlClient(config).insertMany('Users', rows, { onError: 'continue' }),
      ).resolves.toEqual({
        inserted: 2,
        ids: [1, null, 3],
        failures: [
          { index: 1, row: { name: 'Luis' }, number: 547, message: 'FOREIGN KEY constraint' },
        ],
      });
      expect(pool.transaction).not.toHaveBeenCalled();
    });
  });
});
