import sql from 'mssql';
import { BatchRowError } from '../errors/BatchRowError';
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
const captureError = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('Expected promise to reject');
};
/** Shape returned by a batch: [failures, outcomes]. */
const batchResult = (failures: unknown[], outcomes: unknown[]) => ({
  recordsets: [failures, outcomes],
});

describe('SqlClient', () => {
  let pool: { connect: jest.Mock; close: jest.Mock; request: jest.Mock; transaction: jest.Mock };
  let request: { input: jest.Mock; query: jest.Mock };
  let transaction: { begin: jest.Mock; commit: jest.Mock; rollback: jest.Mock; request: jest.Mock };

  beforeEach(() => {
    request = { input: jest.fn(), query: jest.fn().mockResolvedValue({ recordset: [{ id: 42 }] }) };
    transaction = {
      begin: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      request: jest.fn(() => request),
    };
    pool = {
      connect: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
      request: jest.fn(() => request),
      transaction: jest.fn(() => transaction),
    };
    pool.connect.mockResolvedValue(pool);
    ConnectionPoolMock.mockReset().mockImplementation(() => pool);
  });

  describe('connection', () => {
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

  describe('insert', () => {
    it('inserts a parameterized row and returns the identity', async () => {
      await expect(
        new SqlClient(config).insert('dbo.Users', { name: 'Ana', 'e-mail': 'ana@example.com' }),
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
    const inserted = (i: number, id: number) => ({ i, action: 'inserted', id });

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
        batchResult([], [inserted(0, 1), inserted(1, 2), inserted(2, 3)]),
      );

      await expect(new SqlClient(config).insertMany('Users', rows)).resolves.toEqual({
        inserted: 3,
        ids: [1, 2, 3],
        failures: [],
      });
      expect(transaction.commit).toHaveBeenCalled();
      expect(transaction.rollback).not.toHaveBeenCalled();
    });

    it('sends one batch per chunk', async () => {
      request.query
        .mockResolvedValueOnce(batchResult([], [inserted(0, 1), inserted(1, 2)]))
        .mockResolvedValueOnce(batchResult([], [inserted(2, 3)]));

      const result = await new SqlClient(config).insertMany('Users', rows, { chunkSize: 2 });

      expect(request.query).toHaveBeenCalledTimes(2);
      expect(result.ids).toEqual([1, 2, 3]);
    });

    it('rolls back and reports the failing row', async () => {
      request.query.mockResolvedValue(
        batchResult([{ i: 1, number: 2627, message: 'Violation of UNIQUE KEY' }], [inserted(0, 1)]),
      );

      const error = await captureError(new SqlClient(config).insertMany('Users', rows));

      expect(error).toBeInstanceOf(BatchRowError);
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
      expect(error).not.toBeInstanceOf(BatchRowError);
      expect((error as SqlClientError).cause).toBe(cause);
    });

    it('keeps going and returns failures in continue mode', async () => {
      request.query.mockResolvedValue(
        batchResult(
          [{ i: 1, number: 547, message: 'FOREIGN KEY constraint' }],
          [inserted(0, 1), inserted(2, 3)],
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

    it('retries row by row when a whole chunk is rejected in continue mode', async () => {
      const driverError = new Error('Validation failed for parameter p0. Invalid number.');
      const sqlError = Object.assign(new Error('Violation of UNIQUE KEY'), { number: 2627 });

      request.query
        .mockRejectedValueOnce(driverError) // chunk [0, 1]
        .mockResolvedValueOnce(batchResult([], [inserted(0, 1)])) // row 0 alone
        .mockRejectedValueOnce(driverError) // row 1 alone
        .mockRejectedValueOnce(sqlError) // chunk [2]
        .mockRejectedValueOnce(sqlError); // row 2 alone

      await expect(
        new SqlClient(config).insertMany('Users', rows, { onError: 'continue', chunkSize: 2 }),
      ).resolves.toEqual({
        inserted: 1,
        ids: [1, null, null],
        failures: [
          { index: 1, row: { name: 'Luis' }, number: null, message: driverError.message },
          { index: 2, row: { name: 'Eva' }, number: 2627, message: 'Violation of UNIQUE KEY' },
        ],
      });
    });
  });

  describe('merge', () => {
    const rows = [
      { email: 'ana@example.com', name: 'Ana' },
      { email: 'luis@example.com', name: 'Luis' },
      { email: 'eva@example.com', name: 'Eva' },
    ];

    it('counts inserted, updated and skipped rows', async () => {
      request.query.mockResolvedValue(
        batchResult(
          [],
          [
            { i: 0, action: 'updated', id: null },
            { i: 1, action: 'inserted', id: 7 },
            { i: 2, action: 'skipped', id: null },
          ],
        ),
      );

      await expect(
        new SqlClient(config).merge('dbo.Users', rows, { on: 'email' }),
      ).resolves.toEqual({
        inserted: 1,
        updated: 1,
        skipped: 1,
        actions: ['updated', 'inserted', 'skipped'],
        ids: [null, 7, null],
        failures: [],
      });
      expect(transaction.commit).toHaveBeenCalled();
    });

    it('sends an upsert per row keyed on `on`', async () => {
      request.query.mockResolvedValue(batchResult([], []));

      await new SqlClient(config).merge('Users', [rows[0] ?? {}], { on: 'email' });

      const [[batch]] = request.query.mock.calls as [[string]];

      expect(batch).toContain(
        'IF EXISTS (SELECT 1 FROM [Users] WITH (UPDLOCK, SERIALIZABLE) WHERE [email] = @p0)',
      );
      expect(batch).toContain('UPDATE [Users] SET [name] = @p1 WHERE [email] = @p0;');
      expect(batch).toContain('INSERT INTO [Users] ([email], [name]) VALUES (@p0, @p1);');
    });

    it('rejects rows missing a key column before sending anything', async () => {
      const error = await captureError(
        new SqlClient(config).merge('Users', [{ name: 'NoEmail' }], { on: 'email' }),
      );

      expect(error).toBeInstanceOf(BatchRowError);
      expect(error).toMatchObject({
        index: 0,
        number: null,
        sqlMessage: 'Missing key column(s): email',
      });
      expect(request.query).not.toHaveBeenCalled();
    });

    it('reports rows missing a key column as failures in continue mode', async () => {
      request.query.mockResolvedValue(batchResult([], [{ i: 1, action: 'inserted', id: 1 }]));

      const result = await new SqlClient(config).merge(
        'Users',
        [{ name: 'NoEmail' }, rows[0] ?? {}],
        {
          on: 'email',
          onError: 'continue',
        },
      );

      expect(result.actions).toEqual([null, 'inserted']);
      expect(result.failures).toEqual([
        {
          index: 0,
          row: { name: 'NoEmail' },
          number: null,
          message: 'Missing key column(s): email',
        },
      ]);
    });

    it('requires at least one key', async () => {
      await expect(new SqlClient(config).merge('Users', rows, { on: [] })).rejects.toThrow(
        SqlClientError,
      );
    });
  });

  describe('update', () => {
    it('updates the matching rows and returns the affected count', async () => {
      request.query.mockResolvedValue({ rowsAffected: [1] });

      await expect(
        new SqlClient(config).update('dbo.Users', { name: 'Ana María' }, { id: 42 }),
      ).resolves.toBe(1);

      expect(request.query).toHaveBeenCalledWith(
        'UPDATE [dbo].[Users] SET [name] = @p0 WHERE [id] = @p1;',
      );
      expect(request.input).toHaveBeenNthCalledWith(1, 'p0', 'Ana María');
      expect(request.input).toHaveBeenNthCalledWith(2, 'p1', 42);
    });

    it('matches null with IS NULL', async () => {
      request.query.mockResolvedValue({ rowsAffected: [3] });

      await new SqlClient(config).update(
        'Users',
        { active: false },
        { deletedAt: null, tenant: 1 },
      );

      expect(request.query).toHaveBeenCalledWith(
        'UPDATE [Users] SET [active] = @p0 WHERE [deletedAt] IS NULL AND [tenant] = @p2;',
      );
    });

    it('refuses an empty where or empty values', async () => {
      const client = new SqlClient(config);

      await expect(client.update('Users', { name: 'x' }, {})).rejects.toThrow(SqlClientError);
      await expect(client.update('Users', {}, { id: 1 })).rejects.toThrow(SqlClientError);
      expect(request.query).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes the matching rows and returns the affected count', async () => {
      request.query.mockResolvedValue({ rowsAffected: [3] });

      await expect(new SqlClient(config).delete('dbo.Sessions', { userId: 42 })).resolves.toBe(3);

      expect(request.query).toHaveBeenCalledWith(
        'DELETE FROM [dbo].[Sessions] WHERE [userId] = @p0;',
      );
    });

    it('refuses an empty where', async () => {
      await expect(new SqlClient(config).delete('Users', {})).rejects.toThrow(SqlClientError);
      expect(request.query).not.toHaveBeenCalled();
    });
  });
});
