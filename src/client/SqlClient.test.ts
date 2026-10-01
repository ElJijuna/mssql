import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sql from 'mssql';
import { BatchRowError } from '../errors/BatchRowError';
import { SqlAbortError } from '../errors/SqlAbortError';
import { SqlClientError } from '../errors/SqlClientError';
import { tsql } from '../sql/fragment';
import { t } from '../types/SqlParam';
import { SqlClient } from './SqlClient';

jest.mock('mssql', () => {
  const ConnectionPool = jest.fn();

  return {
    __esModule: true,
    default: { ...jest.requireActual<Record<string, unknown>>('mssql'), ConnectionPool },
  };
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
  let request: {
    input: jest.Mock;
    query: jest.Mock;
    cancel: jest.Mock;
    parameters: Record<string, unknown>;
  };
  let transaction: { begin: jest.Mock; commit: jest.Mock; rollback: jest.Mock; request: jest.Mock };

  beforeEach(() => {
    request = {
      input: jest.fn(),
      query: jest.fn().mockResolvedValue({ recordset: [{ id: 42 }] }),
      cancel: jest.fn(),
      parameters: {},
    };
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
    const externalPool = (): sql.ConnectionPool => pool as unknown as sql.ConnectionPool;

    it('uses an already connected external pool without opening another connection', async () => {
      Object.assign(pool, { connected: true });
      const connect = jest.fn();
      const client = new SqlClient(externalPool()).on('connect', connect);

      await expect(client.connect()).resolves.toBe(pool);
      await expect(client.select('Users')).resolves.toEqual([{ id: 42 }]);

      expect(ConnectionPoolMock).not.toHaveBeenCalled();
      expect(pool.connect).not.toHaveBeenCalled();
      expect(pool.request).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it('connects an unopened external pool once for concurrent calls', async () => {
      const client = new SqlClient(externalPool());

      await expect(Promise.all([client.connect(), client.connect()])).resolves.toEqual([
        pool,
        pool,
      ]);

      expect(pool.connect).toHaveBeenCalledTimes(1);
      expect(ConnectionPoolMock).not.toHaveBeenCalled();
    });

    it('retries the same external pool after connection failure', async () => {
      const cause = new Error('Login failed');
      const failure = jest.fn();
      const client = new SqlClient(externalPool()).on('connectFailure', failure);

      pool.connect.mockRejectedValueOnce(cause);
      await expect(client.connect()).rejects.toMatchObject({ name: 'SqlConnectionError', cause });
      await expect(client.connect()).resolves.toBe(pool);

      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(ConnectionPoolMock).not.toHaveBeenCalled();
      expect(failure).toHaveBeenCalledWith(expect.objectContaining({ error: cause }));
    });

    it('leaves a shared pool usable when either borrowing client closes', async () => {
      Object.assign(pool, { connected: true });
      const close = jest.fn();
      const first = new SqlClient(externalPool()).on('close', close);
      const second = new SqlClient(externalPool());

      await Promise.all([first.connect(), second.connect()]);
      await first.close();
      await first.close();
      await expect(second.select('Users')).resolves.toEqual([{ id: 42 }]);
      await expect(first.connect()).resolves.toBe(pool);
      await second.close();

      expect(pool.close).not.toHaveBeenCalled();
      expect(pool.connect).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('closes an external pool when ownership is explicitly transferred', async () => {
      const client = new SqlClient(externalPool(), { ownsPool: true });

      await client.connect();
      await client.close();

      expect(pool.close).toHaveBeenCalledTimes(1);
      expect(ConnectionPoolMock).not.toHaveBeenCalled();
    });

    it('runs transactions on the external pool', async () => {
      request.query.mockResolvedValue({ recordsets: [[{ n: 1 }]], rowsAffected: [1] });
      const client = new SqlClient(externalPool());

      await expect(
        client.transaction(async (tx) => tx.query('SELECT 1 AS n')),
      ).resolves.toMatchObject({
        rows: [{ n: 1 }],
      });

      expect(pool.transaction).toHaveBeenCalledTimes(1);
      expect(transaction.request).toHaveBeenCalledTimes(1);
      expect(transaction.commit).toHaveBeenCalledTimes(1);
      expect(ConnectionPoolMock).not.toHaveBeenCalled();
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

  describe('insert', () => {
    it('returns large identities as exact strings and safe identities as numbers', async () => {
      request.query
        .mockResolvedValueOnce({ recordset: [{ id: '9007199254740993' }] })
        .mockResolvedValueOnce({ recordset: [{ id: '42' }] });
      const client = new SqlClient(config);

      await expect(client.insert('Users', { name: 'Ana' })).resolves.toBe('9007199254740993');
      await expect(client.insert('Users', { name: 'Luis' })).resolves.toBe(42);
    });

    it('preserves exact decimals in CRUD SQL and parameter values', async () => {
      await new SqlClient(config).insert('Prices', {
        price: t.decimalExact('9007199254740993.01', 20, 2),
      });

      expect(request.input).toHaveBeenCalledWith(
        'p0',
        sql.NVarChar(sql.MAX),
        '9007199254740993.01',
      );
      expect(request.query).toHaveBeenCalledWith(
        expect.stringContaining('VALUES (CONVERT(decimal(20, 2), @p0))'),
      );
    });

    it('inserts a parameterized row and returns the identity', async () => {
      await expect(
        new SqlClient(config).insert('dbo.Users', { name: 'Ana', 'e-mail': 'ana@example.com' }),
      ).resolves.toBe(42);

      expect(request.input).toHaveBeenNthCalledWith(1, 'p0', 'Ana');
      expect(request.input).toHaveBeenNthCalledWith(2, 'p1', 'ana@example.com');
      expect(request.query).toHaveBeenCalledWith(
        'INSERT INTO [dbo].[Users] ([name], [e-mail]) VALUES (@p0, @p1); SELECT CONVERT(varchar(40), SCOPE_IDENTITY()) AS id;',
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
        'INSERT INTO [Logs] DEFAULT VALUES; SELECT CONVERT(varchar(40), SCOPE_IDENTITY()) AS id;',
      );
    });

    it('returns null when the table has no identity column', async () => {
      request.query.mockResolvedValue({ recordset: [{ id: null }] });

      await expect(new SqlClient(config).insert('Tags', { name: 'x' })).resolves.toBeNull();
    });
  });

  describe('insertMany', () => {
    it('preserves large identities from batch results', async () => {
      request.query.mockResolvedValue(
        batchResult([], [{ i: 0, action: 'inserted', id: '9007199254740993' }]),
      );

      await expect(
        new SqlClient(config).insertMany('Users', [{ name: 'Ana' }]),
      ).resolves.toMatchObject({
        ids: ['9007199254740993'],
      });
      expect(request.query).toHaveBeenCalledWith(
        expect.stringContaining('CONVERT(varchar(40), id) AS id'),
      );
    });

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
        'UPDATE [Users] SET [active] = @p0 WHERE [deletedAt] IS NULL AND [tenant] = @p1;',
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

  describe('debug', () => {
    it('logs every call when enabled on the client', async () => {
      const logger = jest.fn();
      const client = new SqlClient(config, { debug: logger });

      request.query.mockResolvedValue({ recordset: [{ id: 1 }], rowsAffected: [1] });
      await client.insert('Users', { name: 'Ana' });
      await client.delete('Users', { id: 1 });

      expect(logger).toHaveBeenCalledTimes(2);
      expect(logger).toHaveBeenNthCalledWith(1, expect.objectContaining({ operation: 'insert' }));
      expect(logger).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          operation: 'delete',
          sql: 'DELETE FROM [Users] WHERE [id] = @p0;',
        }),
      );
    });

    it('logs a single call when enabled on that call', async () => {
      const logger = jest.fn();
      const client = new SqlClient(config);

      request.query.mockResolvedValue({ rowsAffected: [1] });
      await client.update('Users', { name: 'x' }, { id: 1 });
      await client.update('Users', { name: 'y' }, { id: 1 }, { debug: logger });

      expect(logger).toHaveBeenCalledTimes(1);
    });

    it('lets a call opt out when enabled on the client', async () => {
      const logger = jest.fn();

      request.query.mockResolvedValue({ rowsAffected: [1] });
      await new SqlClient(config, { debug: logger }).delete('Users', { id: 1 }, { debug: false });

      expect(logger).not.toHaveBeenCalled();
    });

    it('logs each batch sent by insertMany and merge', async () => {
      const logger = jest.fn();
      const client = new SqlClient(config, { debug: logger });
      const rows = [{ email: 'a' }, { email: 'b' }, { email: 'c' }];

      request.query.mockResolvedValue(batchResult([], []));
      await client.insertMany('Users', rows, { chunkSize: 2 });
      await client.merge('Users', rows, { on: 'email' });

      expect(logger.mock.calls.map(([entry]: [{ operation: string }]) => entry.operation)).toEqual([
        'insertMany',
        'insertMany',
        'merge',
      ]);
    });
  });

  describe('events', () => {
    const anyDuration = expect.any(Number) as number;

    it('emits connect and close', async () => {
      const client = new SqlClient(config);
      const connect = jest.fn();
      const close = jest.fn();

      client.on('connect', connect).on('close', close);
      await client.connect();
      await client.close();

      expect(connect).toHaveBeenCalledWith({ durationMs: anyDuration });
      expect(close).toHaveBeenCalledWith({});
    });

    it('emits connectFailure', async () => {
      const cause = new Error('Login failed');
      const listener = jest.fn();

      pool.connect.mockRejectedValueOnce(cause);
      const client = new SqlClient(config).on('connectFailure', listener);

      await expect(client.connect()).rejects.toThrow(SqlClientError);
      expect(listener).toHaveBeenCalledWith({ durationMs: anyDuration, error: cause });
    });

    it('emits query then success with a shared id', async () => {
      const client = new SqlClient(config);
      const query = jest.fn();
      const success = jest.fn();

      request.query.mockResolvedValue({ rowsAffected: [2] });
      client.on('query', query).on('success', success);
      await client.delete('Users', { active: false });

      const sent = {
        id: 1,
        operation: 'delete',
        transactionId: null,
        sql: 'DELETE FROM [Users] WHERE [active] = @p0;',
        params: [],
      };

      expect(query).toHaveBeenCalledWith(sent);
      expect(success).toHaveBeenCalledWith({
        ...sent,
        durationMs: anyDuration,
        rowsAffected: [2],
      });
    });

    it('emits failure with the SQL Server error number and rethrows', async () => {
      const client = new SqlClient(config);
      const failure = jest.fn();
      const error = Object.assign(
        new Error('The DELETE statement conflicted with the REFERENCE constraint'),
        {
          number: 547,
        },
      );

      request.query.mockRejectedValue(error);
      client.on('failure', failure);

      await expect(client.delete('Users', { id: 1 })).rejects.toMatchObject({
        code: 'SQL_QUERY_ERROR',
        operation: 'delete',
        number: 547,
        cause: error,
      });
      expect(failure).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'delete',
          error: expect.objectContaining({ cause: error }) as SqlClientError,
          number: 547,
        }),
      );
    });

    it('emits rowFailure for each failed row in continue mode', async () => {
      const client = new SqlClient(config);
      const rowFailure = jest.fn();

      request.query.mockResolvedValue(
        batchResult(
          [{ i: 1, number: 2627, message: 'Violation of UNIQUE KEY' }],
          [{ i: 0, action: 'inserted', id: 1 }],
        ),
      );
      client.on('rowFailure', rowFailure);
      await client.insertMany('Users', [{ name: 'Ana' }, { name: 'Ana' }], { onError: 'continue' });

      expect(rowFailure).toHaveBeenCalledWith({
        operation: 'insertMany',
        index: 1,
        row: { name: 'Ana' },
        number: 2627,
        message: 'Violation of UNIQUE KEY',
      });
    });

    it('emits rowFailure before throwing in rollback mode', async () => {
      const client = new SqlClient(config);
      const rowFailure = jest.fn();

      client.on('rowFailure', rowFailure);

      await expect(client.merge('Users', [{ name: 'x' }], { on: 'email' })).rejects.toThrow(
        BatchRowError,
      );
      expect(rowFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'merge',
          index: 0,
          message: 'Missing key column(s): email',
        }),
      );
    });

    it('does not build debug entries when nobody is listening', async () => {
      request.query.mockResolvedValue({ rowsAffected: [1] });
      delete (request as Partial<typeof request>).parameters;

      await expect(new SqlClient(config).delete('Users', { id: 1 })).resolves.toBe(1);
    });
  });

  describe('select', () => {
    it('returns the rows of the recordset', async () => {
      const rows = [{ id: 1, name: 'Ana' }];

      request.query.mockResolvedValue({ recordset: rows, rowsAffected: [1] });

      await expect(
        new SqlClient(config).select<{ id: number; name: string }>(
          'dbo.Users',
          { role: ['admin', 'editor'] },
          { columns: ['id', 'name'], orderBy: 'name', limit: 5 },
        ),
      ).resolves.toBe(rows);
      expect(request.query).toHaveBeenCalledWith(
        'SELECT TOP (5) [id], [name] FROM [dbo].[Users] WHERE [role] IN (@p0, @p1) ORDER BY [name] ASC;',
      );
    });

    it('selects every row without a where', async () => {
      request.query.mockResolvedValue({ recordset: [], rowsAffected: [0] });

      await expect(new SqlClient(config).select('Users')).resolves.toEqual([]);
      expect(request.query).toHaveBeenCalledWith('SELECT * FROM [Users];');
    });
  });

  describe('findOne', () => {
    it('returns the first row with TOP (1)', async () => {
      request.query.mockResolvedValue({ recordset: [{ id: 1 }], rowsAffected: [1] });

      await expect(
        new SqlClient(config).findOne('Users', { email: 'ana@example.com' }),
      ).resolves.toEqual({ id: 1 });
      expect(request.query).toHaveBeenCalledWith(
        'SELECT TOP (1) * FROM [Users] WHERE [email] = @p0;',
      );
    });

    it('returns null when nothing matches', async () => {
      request.query.mockResolvedValue({ recordset: [], rowsAffected: [0] });

      await expect(new SqlClient(config).findOne('Users', { id: 404 })).resolves.toBeNull();
    });

    it('reports its own operation name', async () => {
      const logger = jest.fn();

      request.query.mockResolvedValue({ recordset: [], rowsAffected: [0] });
      await new SqlClient(config, { debug: logger }).findOne('Users', { id: 1 });

      expect(logger).toHaveBeenCalledWith(expect.objectContaining({ operation: 'findOne' }));
    });
  });

  describe('where with arrays', () => {
    it('supports IN in update and delete', async () => {
      request.query.mockResolvedValue({ rowsAffected: [2] });
      const client = new SqlClient(config);

      await client.update('Users', { active: false }, { id: [1, 2] });
      await client.delete('Sessions', { userId: [1, 2] });

      expect(request.query).toHaveBeenNthCalledWith(
        1,
        'UPDATE [Users] SET [active] = @p0 WHERE [id] IN (@p1, @p2);',
      );
      expect(request.query).toHaveBeenNthCalledWith(
        2,
        'DELETE FROM [Sessions] WHERE [userId] IN (@p0, @p1);',
      );
    });
  });

  describe('exec', () => {
    const procedureResult = {
      recordsets: [[{ id: 1 }, { id: 2 }], [{ count: 2 }]],
      recordset: [{ id: 1 }, { id: 2 }],
      output: { total: 2 },
      returnValue: 0,
      rowsAffected: [2, 1],
    };
    const realRequest = (): { execRequest: sql.Request; execute: jest.Mock } => {
      const execRequest = new sql.Request();
      const execute = jest.fn().mockResolvedValue(procedureResult);

      Object.assign(execRequest, { execute });
      pool.request.mockReturnValue(execRequest);

      return { execRequest, execute };
    };

    it('binds inputs and outputs and maps the procedure result', async () => {
      const { execRequest, execute } = realRequest();
      const status = t.nvarchar('open', 20);
      const result = await new SqlClient(config).exec<
        { id: number },
        { total: ReturnType<typeof t.int> }
      >('dbo.GetOrders', { customerId: 7, '@status': status }, { output: { total: t.int(null) } });

      expect(execute).toHaveBeenCalledWith('dbo.GetOrders');
      expect(execRequest.parameters.customerId).toMatchObject({ io: 1, value: 7 });
      expect(execRequest.parameters.status).toMatchObject({ io: 1, value: 'open', length: 20 });
      expect(execRequest.parameters.total).toMatchObject({ io: 2, value: null, type: sql.Int });
      expect(result).toEqual({
        rows: [{ id: 1 }, { id: 2 }],
        recordsets: procedureResult.recordsets,
        output: { total: 2 },
        returnValue: 0,
        rowsAffected: [2, 1],
      });
    });

    it('types output values from the builders', async () => {
      realRequest();

      const { output } = await new SqlClient(config).exec(
        'dbo.Stats',
        {},
        {
          output: { total: t.int(null), label: t.nvarchar(null, 50) },
        },
      );
      const { total } = output;
      const { label } = output;

      // @ts-expect-error unknown output parameter
      expect(output.missing).toBeUndefined();
      expect([total, label]).toEqual([2, undefined]);
    });

    it('returns empty rows when the procedure returns no result set', async () => {
      const { execute } = realRequest();

      execute.mockResolvedValue({
        recordsets: [],
        output: {},
        returnValue: 5,
        rowsAffected: [],
      });

      await expect(new SqlClient(config).exec('dbo.Cleanup')).resolves.toEqual({
        rows: [],
        recordsets: [],
        output: {},
        returnValue: 5,
        rowsAffected: [],
      });
    });

    it('prints a runnable EXEC script in debug mode', async () => {
      realRequest();
      const logger = jest.fn();

      await new SqlClient(config, { debug: logger }).exec(
        'dbo.GetOrders',
        { customerId: 7 },
        { output: { total: t.int(null) } },
      );

      expect(logger).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'exec',
          script: [
            'DECLARE @customerId int = 7;',
            'DECLARE @total int = NULL;',
            'EXEC [dbo].[GetOrders] @customerId = @customerId, @total = @total OUTPUT;',
            'SELECT @total AS [total];',
          ].join('\n'),
        }),
      );
    });

    it('emits failure when the procedure fails', async () => {
      const { execute } = realRequest();
      const error = Object.assign(new Error("Could not find stored procedure 'dbo.Nope'."), {
        number: 2812,
      });
      const failure = jest.fn();

      execute.mockRejectedValue(error);

      const client = new SqlClient(config).on('failure', failure);

      await expect(client.exec('dbo.Nope')).rejects.toMatchObject({
        code: 'SQL_QUERY_ERROR',
        operation: 'exec',
        number: 2812,
        cause: error,
      });
      expect(failure).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'exec', number: 2812 }),
      );
    });

    it('rejects an empty procedure name', async () => {
      await expect(new SqlClient(config).exec(' ')).rejects.toThrow(SqlClientError);
    });
  });

  describe('query', () => {
    const useRealRequest = (): { realRequest: sql.Request; query: jest.SpyInstance } => {
      const realRequest = new sql.Request();
      const query = jest.spyOn(realRequest, 'query').mockResolvedValue({
        recordsets: [[{ id: 1 }], [{ total: 1 }]],
        recordset: [{ id: 1 }],
        rowsAffected: [1, 1],
        output: {},
      } as never);

      pool.request.mockReturnValue(realRequest);

      return { realRequest, query };
    };

    it('binds named parameters, expands arrays and maps the result', async () => {
      const { realRequest, query } = useRealRequest();
      const result = await new SqlClient(config).query<{ id: number }>(
        'SELECT id FROM dbo.Users WHERE tenantId = @tenantId AND id IN (@ids); SELECT COUNT(*) AS total FROM dbo.Users;',
        { tenantId: 7, ids: [1, 2] },
      );

      expect(query).toHaveBeenCalledWith(
        'SELECT id FROM dbo.Users WHERE tenantId = @tenantId AND id IN (@ids__0, @ids__1); SELECT COUNT(*) AS total FROM dbo.Users;',
      );
      expect(Object.keys(realRequest.parameters)).toEqual(['tenantId', 'ids__0', 'ids__1']);
      expect(result).toEqual({
        rows: [{ id: 1 }],
        recordsets: [[{ id: 1 }], [{ total: 1 }]],
        rowsAffected: [1, 1],
      });
    });

    it('fails before sending when a parameter is missing', async () => {
      const { query } = useRealRequest();

      await expect(new SqlClient(config).query('SELECT * FROM T WHERE a = @a', {})).rejects.toThrow(
        'query is missing parameter(s): @a',
      );
      expect(query).not.toHaveBeenCalled();
      expect(ConnectionPoolMock).not.toHaveBeenCalled();
    });

    it('can skip parameter validation', async () => {
      useRealRequest();

      await expect(
        new SqlClient(config).query(
          'EXEC sp_executesql @stmt',
          { stmt: 'SELECT 1' },
          { validateParams: false },
        ),
      ).resolves.toMatchObject({ rows: [{ id: 1 }] });
    });

    it('rejects empty SQL', async () => {
      await expect(new SqlClient(config).query('  ')).rejects.toThrow(SqlClientError);
    });
  });

  describe('queryFile', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'pilmee-mssql-client-'));
      await writeFile(
        join(dir, 'get-users.sql'),
        'SELECT id FROM dbo.Users WHERE status IN (@statuses);',
      );
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('runs the file relative to sqlDir', async () => {
      const realRequest = new sql.Request();
      const query = jest
        .spyOn(realRequest, 'query')
        .mockResolvedValue({ recordsets: [[{ id: 3 }]], rowsAffected: [1] } as never);

      pool.request.mockReturnValue(realRequest);

      const { rows } = await new SqlClient(config, { sqlDir: dir }).queryFile('get-users', {
        statuses: ['active', 'pending'],
      });

      expect(rows).toEqual([{ id: 3 }]);
      expect(query).toHaveBeenCalledWith(
        'SELECT id FROM dbo.Users WHERE status IN (@statuses__0, @statuses__1);',
      );
    });

    it('names the file in debug output and errors', async () => {
      const realRequest = new sql.Request();
      const logger = jest.fn();

      jest
        .spyOn(realRequest, 'query')
        .mockResolvedValue({ recordsets: [[]], rowsAffected: [0] } as never);

      pool.request.mockReturnValue(realRequest);
      const client = new SqlClient(config, { sqlDir: dir, debug: logger });

      await client.queryFile('get-users', { statuses: ['active'] });
      await expect(client.queryFile('get-users')).rejects.toThrow(
        'get-users.sql is missing parameter(s): @statuses',
      );

      expect(logger).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'queryFile',
          sql: '-- get-users.sql\nSELECT id FROM dbo.Users WHERE status IN (@statuses__0);',
        }),
      );
    });

    it('runs inside a transaction', async () => {
      const realRequest = new sql.Request();

      jest
        .spyOn(realRequest, 'query')
        .mockResolvedValue({ recordsets: [[{ id: 1 }]], rowsAffected: [1] } as never);

      transaction.request.mockReturnValue(realRequest);

      const rows = await new SqlClient(config, { sqlDir: dir }).transaction(async (tx) => {
        const result = await tx.queryFile('get-users', { statuses: ['active'] });

        return result.rows;
      });

      expect(rows).toEqual([{ id: 1 }]);
      expect(transaction.commit).toHaveBeenCalled();
    });
  });

  describe('signal and timeout', () => {
    /** A query that, like mssql, only settles (rejecting) once the request is cancelled. */
    const pending = async () =>
      new Promise<never>((_resolve, reject) => {
        request.cancel.mockImplementation(() => {
          reject(new Error('Canceled.'));
        });
      });

    it('cancels the query and rejects with SqlAbortError when the signal aborts', async () => {
      const controller = new AbortController();
      const failure = jest.fn();

      request.query.mockImplementation(pending);
      const client = new SqlClient(config).on('failure', failure);
      const running = client.select('Users', {}, { signal: controller.signal });

      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();

      await expect(running).rejects.toBeInstanceOf(SqlAbortError);
      expect(request.cancel).toHaveBeenCalled();
      expect(failure).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'select', error: expect.any(SqlAbortError) as Error }),
      );
    });

    it('does not connect when the signal is already aborted', async () => {
      await expect(
        new SqlClient(config).delete('Users', { id: 1 }, { signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({
        reason: 'abort',
      });
      expect(ConnectionPoolMock).not.toHaveBeenCalled();
    });

    it('times out a slow query', async () => {
      request.query.mockImplementation(pending);

      await expect(
        new SqlClient(config).query('WAITFOR DELAY @d', { d: '00:01' }, { timeout: 20 }),
      ).rejects.toMatchObject({
        reason: 'timeout',
        message: 'query timed out after 20 ms',
      });
      expect(request.cancel).toHaveBeenCalled();
    });

    it('stops a continue-mode batch instead of reporting row failures', async () => {
      request.query.mockImplementation(pending);

      await expect(
        new SqlClient(config).insertMany('Users', [{ name: 'Ana' }, { name: 'Luis' }], {
          onError: 'continue',
          timeout: 20,
        }),
      ).rejects.toBeInstanceOf(SqlAbortError);
      expect(request.query).toHaveBeenCalledTimes(1);
    });

    it('rolls back a transaction that runs out of time before committing', async () => {
      const rollback = jest.fn();
      const client = new SqlClient(config).on('transactionRollback', rollback);

      request.query.mockResolvedValue({ recordset: [], rowsAffected: [1] });

      await expect(
        client.transaction(
          async (tx) => {
            await tx.update('Users', { active: false }, { id: 1 });
            await new Promise((resolve) => setTimeout(resolve, 30));
          },
          { timeout: 10 },
        ),
      ).rejects.toMatchObject({ operation: 'transaction', reason: 'timeout' });
      expect(transaction.commit).not.toHaveBeenCalled();
      expect(transaction.rollback).toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(SqlAbortError) as Error }),
      );
    });

    it('cancels the running query when the transaction signal aborts', async () => {
      const controller = new AbortController();

      request.query.mockImplementation(pending);
      const running = new SqlClient(config).transaction(async (tx) => tx.select('Users'), {
        signal: controller.signal,
      });

      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();

      await expect(running).rejects.toMatchObject({ operation: 'transaction', reason: 'abort' });
      expect(request.cancel).toHaveBeenCalled();
      expect(transaction.rollback).toHaveBeenCalled();
    });
  });

  describe('retry', () => {
    const deadlock = () => Object.assign(new Error('Transaction was deadlocked'), { number: 1205 });
    const fast = { retry: { delay: 1 } };

    it('retries a transient error and emits retry events', async () => {
      const retries = jest.fn();

      request.query
        .mockRejectedValueOnce(deadlock())
        .mockRejectedValueOnce(deadlock())
        .mockResolvedValue({ recordset: [{ id: 1 }], rowsAffected: [1] });

      const client = new SqlClient(config, fast).on('retry', retries);

      await expect(client.select('Users')).resolves.toEqual([{ id: 1 }]);
      expect(request.query).toHaveBeenCalledTimes(3);
      expect(retries).toHaveBeenCalledTimes(2);
      expect(retries).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ operation: 'select', attempt: 1, number: 1205 }),
      );
    });

    it('gives up after the configured attempts with the last error', async () => {
      request.query.mockRejectedValue(deadlock());

      await expect(
        new SqlClient(config, { retry: { attempts: 2, delay: 1 } }).delete('Users', { id: 1 }),
      ).rejects.toMatchObject({
        number: 1205,
      });
      expect(request.query).toHaveBeenCalledTimes(3);
    });

    it('does not retry other errors', async () => {
      request.query.mockRejectedValue(Object.assign(new Error('duplicate'), { number: 2627 }));

      await expect(new SqlClient(config, fast).insert('Users', { id: 1 })).rejects.toMatchObject({
        number: 2627,
      });
      expect(request.query).toHaveBeenCalledTimes(1);
    });

    it('can be turned off for the client or a call', async () => {
      request.query.mockRejectedValue(deadlock());

      await expect(new SqlClient(config, { retry: false }).select('Users')).rejects.toMatchObject({
        number: 1205,
      });
      await expect(
        new SqlClient(config, fast).select('Users', {}, { retry: false }),
      ).rejects.toMatchObject({ number: 1205 });
      expect(request.query).toHaveBeenCalledTimes(2);
    });

    it('only retries raw SQL when the call opts in', async () => {
      request.query
        .mockRejectedValueOnce(deadlock())
        .mockResolvedValue({ recordsets: [[]], rowsAffected: [0] });
      const client = new SqlClient(config, fast);

      await expect(client.query('UPDATE T SET a = 1')).rejects.toMatchObject({ number: 1205 });

      request.query.mockRejectedValueOnce(deadlock());
      await expect(client.query('UPDATE T SET a = 1', {}, { retry: true })).resolves.toMatchObject({
        rows: [],
      });
    });

    it('retries a whole rollback-mode batch when a row was a deadlock victim', async () => {
      request.query
        .mockResolvedValueOnce(batchResult([{ i: 0, number: 1205, message: 'deadlocked' }], []))
        .mockResolvedValue(batchResult([], [{ i: 0, action: 'inserted', id: 7 }]));

      await expect(
        new SqlClient(config, fast).insertMany('Users', [{ name: 'Ana' }]),
      ).resolves.toMatchObject({ ids: [7] });
      expect(transaction.rollback).toHaveBeenCalledTimes(1);
      expect(transaction.commit).toHaveBeenCalledTimes(1);
    });

    it('retries only the transient rows of a continue-mode batch', async () => {
      const retries = jest.fn();

      request.query
        .mockResolvedValueOnce(
          batchResult(
            [
              { i: 1, number: 1205, message: 'deadlocked' },
              { i: 2, number: 2627, message: 'duplicate' },
            ],
            [{ i: 0, action: 'inserted', id: 1 }],
          ),
        )
        .mockResolvedValueOnce(batchResult([], [{ i: 1, action: 'inserted', id: 2 }]));

      const client = new SqlClient(config, fast).on('retry', retries);
      const result = await client.insertMany('Users', [{ n: 'a' }, { n: 'b' }, { n: 'c' }], {
        onError: 'continue',
      });

      expect(result).toMatchObject({
        inserted: 2,
        ids: [1, 2, null],
        failures: [expect.objectContaining({ index: 2, number: 2627 })],
      });
      expect(request.query).toHaveBeenCalledTimes(2);
      expect(retries).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'insertMany', rows: [1], number: 1205 }),
      );
    });

    it('retries a failed connection', async () => {
      pool.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      request.query.mockResolvedValue({ recordset: [], rowsAffected: [0] });

      await expect(new SqlClient(config, fast).select('Users')).resolves.toEqual([]);
      expect(ConnectionPoolMock).toHaveBeenCalledTimes(2);
    });

    it('stops retrying when the timeout passes during the wait', async () => {
      request.query.mockRejectedValue(deadlock());

      await expect(
        new SqlClient(config, { retry: { delay: 1_000 } }).select('Users', {}, { timeout: 50 }),
      ).rejects.toMatchObject({ name: 'SqlAbortError', reason: 'timeout', operation: 'select' });
      expect(request.query).toHaveBeenCalledTimes(1);
    });

    it('retries a whole transaction only when asked', async () => {
      const failOnce = () =>
        jest
          .fn<Promise<string>, [unknown]>()
          .mockRejectedValueOnce(deadlock())
          .mockResolvedValue('done');
      const retries = jest.fn();
      const client = new SqlClient(config, fast).on('retry', retries);
      const withoutRetry = failOnce();
      const withRetry = failOnce();

      await expect(client.transaction(withoutRetry)).rejects.toMatchObject({ number: 1205 });
      await expect(client.transaction(withRetry, { retry: true })).resolves.toBe('done');

      expect(withoutRetry).toHaveBeenCalledTimes(1);
      expect(withRetry).toHaveBeenCalledTimes(2);
      expect(transaction.rollback).toHaveBeenCalledTimes(2);
      expect(transaction.commit).toHaveBeenCalledTimes(1);
      expect(retries).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'transaction', number: 1205 }),
      );
    });
  });

  describe('query with tagged templates', () => {
    it('normalizes failures without event listeners and preserves the driver code', async () => {
      const cause = Object.assign(new Error('duplicate'), {
        code: 'EREQUEST',
        originalError: { info: { number: 2627 } },
      });

      request.query.mockRejectedValue(cause);

      await expect(new SqlClient(config).query('SELECT 1')).rejects.toMatchObject({
        code: 'SQL_QUERY_ERROR',
        driverCode: 'EREQUEST',
        number: 2627,
        operation: 'query',
        cause,
      });
    });

    it('attaches an operation to preflight validation errors', async () => {
      await expect(new SqlClient(config).query('SELECT @missing')).rejects.toMatchObject({
        code: 'SQL_CLIENT_ERROR',
        operation: 'query',
        number: null,
      });
      expect(ConnectionPoolMock).not.toHaveBeenCalled();
    });

    it('uses exact decimal conversion in named scalars, arrays, and tagged queries', async () => {
      request.query.mockResolvedValue({ recordsets: [[]], rowsAffected: [] });
      const client = new SqlClient(config);
      const value = t.decimalExact('9007199254740993.01', 20, 2);

      await client.query('SELECT @amount WHERE @amount IN (@amounts)', {
        amount: value,
        amounts: [value],
      });
      expect(request.query).toHaveBeenLastCalledWith(
        'SELECT CONVERT(decimal(20, 2), @amount) WHERE CONVERT(decimal(20, 2), @amount) IN (CONVERT(decimal(20, 2), @amounts__0))',
      );

      await client.query`SELECT ${value}`;
      expect(request.query).toHaveBeenLastCalledWith('SELECT CONVERT(decimal(20, 2), @p0)');
    });

    it('rejects exact decimal RPC parameters before connecting', async () => {
      await expect(
        new SqlClient(config).exec('dbo.Price', { price: t.decimalExact('1.00', 5, 2) }),
      ).rejects.toMatchObject({
        code: 'SQL_CLIENT_ERROR',
        operation: 'exec',
      });
      expect(ConnectionPoolMock).not.toHaveBeenCalled();
    });

    const useRealRequest = (): { realRequest: sql.Request; query: jest.SpyInstance } => {
      const realRequest = new sql.Request();
      const query = jest
        .spyOn(realRequest, 'query')
        .mockResolvedValue({ recordsets: [[{ id: 1 }]], rowsAffected: [1] } as never);

      pool.request.mockReturnValue(realRequest);

      return { realRequest, query };
    };

    it('parameterizes every value, expands arrays and types the rows', async () => {
      const { realRequest, query } = useRealRequest();
      const tenantId = 7;
      const roles = ['admin', 'editor'];
      const { rows } = await new SqlClient(config).query<{ id: number }>`
        SELECT id FROM dbo.Users WHERE tenantId = ${tenantId} AND role IN (${roles})`;
      const id: number | undefined = rows[0]?.id;

      expect(id).toBe(1);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('WHERE tenantId = @p0 AND role IN (@p1__0, @p1__1)'),
      );
      expect(Object.keys(realRequest.parameters)).toEqual(['p0', 'p1__0', 'p1__1']);
    });

    it('accepts a fragment with options', async () => {
      useRealRequest();
      const logger = jest.fn();

      await new SqlClient(config).query(tsql`SELECT * FROM T WHERE id = ${t.int(5)}`, {
        debug: logger,
        timeout: 1_000,
      });

      expect(logger).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'query',
          script: 'DECLARE @p0 int = 5;\nSELECT * FROM T WHERE id = @p0',
        }),
      );
    });

    it('emits events for tagged queries', async () => {
      useRealRequest();
      const success = jest.fn();

      await new SqlClient(config).on('success', success).query`SELECT ${1} AS one`;

      expect(success).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'query', sql: 'SELECT @p0 AS one' }),
      );
    });

    it('still accepts text with named parameters', async () => {
      const { query } = useRealRequest();

      await new SqlClient(config).query('SELECT * FROM T WHERE id = @id', { id: 1 });

      expect(query).toHaveBeenCalledWith('SELECT * FROM T WHERE id = @id');
    });

    it('rejects a quoted value before connecting', async () => {
      const name = 'Ana';

      await expect(
        new SqlClient(config).query`SELECT * FROM T WHERE name = '${name}'`,
      ).rejects.toThrow('ended up inside a string literal');
      expect(ConnectionPoolMock).not.toHaveBeenCalled();
    });

    it('works inside transactions', async () => {
      const realRequest = new sql.Request();

      jest
        .spyOn(realRequest, 'query')
        .mockResolvedValue({ recordsets: [[{ n: 1 }]], rowsAffected: [1] } as never);
      transaction.request.mockReturnValue(realRequest);

      const rows = await new SqlClient(config).transaction(async (tx) => {
        const result = await tx.query<{ n: number }>`SELECT ${1} AS n`;

        return result.rows;
      });

      expect(rows).toEqual([{ n: 1 }]);
    });
  });

  describe('set', () => {
    it('loads key metadata once, sends the list as one JSON parameter and reports operation set', async () => {
      const realRequest = (): sql.Request => new sql.Request();
      const requests: sql.Request[] = [];
      const logger = jest.fn();

      pool.request.mockImplementation(() => {
        const next = realRequest();
        const catalog = requests.length === 0;

        jest.spyOn(next, 'query').mockResolvedValue(
          (catalog
            ? {
                recordset: [
                  {
                    name: 'email',
                    type: 'nvarchar',
                    precision: 0,
                    scale: 0,
                    collation: 'Latin1_General_CI_AS',
                  },
                ],
              }
            : { recordsets: [[{ i: 1 }]], rowsAffected: [1] }) as never,
        );
        requests.push(next);

        return next;
      });

      const users = new SqlClient(config, { debug: logger }).set('dbo.Users', { key: 'email' });
      const incoming = [{ email: 'a@x.com' }, { email: 'b@x.com' }];

      await expect(users.missing(incoming)).resolves.toEqual([{ email: 'b@x.com' }]);
      await users.missing(incoming);

      expect(requests).toHaveLength(3);
      expect(requests[1]?.parameters.__list?.value).toBe(
        JSON.stringify([
          { i: 0, k0: 'a@x.com' },
          { i: 1, k0: 'b@x.com' },
        ]),
      );
      expect(logger).toHaveBeenCalledWith(expect.objectContaining({ operation: 'set' }));
    });
  });
});
