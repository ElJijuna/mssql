import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sql from 'mssql';
import { BatchRowError } from '../errors/BatchRowError';
import { SqlClientError } from '../errors/SqlClientError';
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
const config: sql.config = { server: 'localhost', user: 'sa', password: 'x', database: 'master' };
const batchResult = (failures: unknown[], outcomes: unknown[]) => ({
  recordsets: [failures, outcomes],
});
const captureError = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error('Expected promise to reject');
};

describe('SqlClient.transaction', () => {
  let request: {
    input: jest.Mock;
    query: jest.Mock;
    batch: jest.Mock;
    execute: jest.Mock;
    output: jest.Mock;
    parameters: Record<string, unknown>;
  };
  let transaction: { begin: jest.Mock; commit: jest.Mock; rollback: jest.Mock; request: jest.Mock };
  let pool: { connect: jest.Mock; request: jest.Mock; transaction: jest.Mock };
  let client: SqlClient;

  beforeEach(() => {
    request = {
      input: jest.fn(),
      query: jest.fn().mockResolvedValue({ recordset: [{ id: 1 }], rowsAffected: [1] }),
      batch: jest.fn().mockResolvedValue({}),
      execute: jest
        .fn()
        .mockResolvedValue({ recordsets: [], rowsAffected: [], output: {}, returnValue: 0 }),
      output: jest.fn(),
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
      request: jest.fn(() => request),
      transaction: jest.fn(() => transaction),
    };
    pool.connect.mockResolvedValue(pool);
    ConnectionPoolMock.mockReset().mockImplementation(() => pool);
    client = new SqlClient(config);
  });

  it('commits and returns the result of the work', async () => {
    const result = await client.transaction(async (tx) => {
      const id = await tx.insert('Orders', { total: 10 });

      await tx.update('Customers', { lastOrderId: id }, { id: 7 });

      return id;
    });

    expect(result).toBe(1);
    expect(transaction.begin).toHaveBeenCalledWith(undefined);
    expect(transaction.commit).toHaveBeenCalledTimes(1);
    expect(transaction.rollback).not.toHaveBeenCalled();
    expect(pool.request).not.toHaveBeenCalled();
    expect(request.query).toHaveBeenCalledTimes(2);
  });

  it('reads inside the transaction', async () => {
    request.query.mockResolvedValue({ recordset: [{ id: 1, stock: 3 }], rowsAffected: [1] });

    const product = await client.transaction(async (tx) => tx.findOne('Products', { id: 1 }));

    expect(product).toEqual({ id: 1, stock: 3 });
    expect(transaction.request).toHaveBeenCalled();
  });

  it('returns a transaction-bound raw request while active', async () => {
    await client.transaction((tx) => {
      expect(tx.request()).toBe(request);

      return Promise.resolve();
    });

    expect(transaction.request).toHaveBeenCalledTimes(1);
    expect(pool.request).not.toHaveBeenCalled();
  });

  it('finds one row without filters and returns null when no row matches', async () => {
    request.query
      .mockResolvedValueOnce({ recordset: [{ id: 7 }], rowsAffected: [] })
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [] });

    await client.transaction(async (tx) => {
      await expect(tx.findOne('Orders')).resolves.toEqual({ id: 7 });
      await expect(tx.findOne('Orders', { id: 99 })).resolves.toBeNull();
    });

    expect(request.query).toHaveBeenNthCalledWith(1, 'SELECT TOP (1) * FROM [Orders];');
    expect(pool.request).not.toHaveBeenCalled();
  });

  it('executes procedures with default inputs/options and typed outputs on the transaction', async () => {
    request.execute
      .mockResolvedValueOnce({ recordsets: [[{ id: 1 }]], rowsAffected: [1], returnValue: 0 })
      .mockResolvedValueOnce({
        recordsets: [[{ id: 2 }]],
        rowsAffected: [1],
        output: { total: 7 },
        returnValue: 5,
      });

    await client.transaction(async (tx) => {
      await expect(tx.exec('dbo.ListOrders')).resolves.toMatchObject({
        rows: [{ id: 1 }],
        output: {},
        returnValue: 0,
      });
      await expect(
        tx.exec('dbo.Total', { id: t.int(2) }, { output: { total: t.int(null) } }),
      ).resolves.toMatchObject({ rows: [{ id: 2 }], output: { total: 7 }, returnValue: 5 });
    });

    expect(request.execute).toHaveBeenNthCalledWith(1, 'dbo.ListOrders');
    expect(request.execute).toHaveBeenNthCalledWith(2, 'dbo.Total');
    expect(request.output).toHaveBeenCalledWith('total', sql.Int(), null);
    expect(pool.request).not.toHaveBeenCalled();
  });

  it('loads SQL files and binds their parameters inside the transaction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mssql-tx-files-'));
    const file = join(dir, 'query.sql');

    try {
      await writeFile(file, 'SELECT 1 AS n;');
      request.query.mockResolvedValue({ recordsets: [[{ n: 1 }]], rowsAffected: [] });
      await expect(client.transaction(async (tx) => tx.queryFile(file))).resolves.toMatchObject({
        rows: [{ n: 1 }],
      });

      await writeFile(join(dir, 'named.sql'), 'SELECT @id AS n;');
      await client.transaction(async (tx) =>
        tx.queryFile(join(dir, 'named.sql'), { id: t.int(7) }, { debug: false }),
      );
      expect(request.input).toHaveBeenCalledWith('id', sql.Int(), 7);
      expect(pool.request).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs set operations with transaction-bound metadata queries', async () => {
    request.query
      .mockResolvedValueOnce({
        recordset: [{ name: 'id', type: 'int', precision: 10, scale: 0, collation: null }],
        rowsAffected: [],
      })
      .mockResolvedValueOnce({ recordsets: [[{ id: 1 }]], rowsAffected: [] });

    await expect(
      client.transaction(async (tx) => tx.set('Orders', { key: 'id' }).difference([2])),
    ).resolves.toEqual([{ id: 1 }]);
    expect(pool.request).not.toHaveBeenCalled();
    expect(transaction.request).toHaveBeenCalledTimes(2);
  });

  it('normalizes a failed operation and allows later queued work after the caller handles it', async () => {
    const cause = Object.assign(new Error('duplicate'), { code: 'EREQUEST', number: 2627 });

    request.query
      .mockRejectedValueOnce(cause)
      .mockResolvedValueOnce({ recordset: [], rowsAffected: [1] });

    await client.transaction(async (tx) => {
      await expect(tx.insert('Orders', { total: 10 })).rejects.toMatchObject({
        code: 'SQL_QUERY_ERROR',
        driverCode: 'EREQUEST',
        number: 2627,
        operation: 'insert',
        cause,
      });
      await expect(tx.delete('Orders', { id: 2 })).resolves.toBe(1);
    });

    expect(transaction.commit).toHaveBeenCalledTimes(1);
    expect(request.query).toHaveBeenCalledTimes(2);
  });

  it('reports query compilation/validation failures without issuing a request', async () => {
    await client.transaction(async (tx) => {
      await expect(tx.query`SELECT '${7}'`).rejects.toMatchObject({
        code: 'SQL_CLIENT_ERROR',
        operation: 'query',
      });
      await expect(tx.exec('')).rejects.toMatchObject({
        code: 'SQL_CLIENT_ERROR',
        operation: 'exec',
      });
    });

    expect(transaction.request).not.toHaveBeenCalled();
    expect(transaction.commit).toHaveBeenCalledTimes(1);
  });

  it('rejects queued operations and lazily created sets after transaction completion', async () => {
    const tx = await client.transaction((active) => Promise.resolve(active));

    await expect(tx.select('Orders')).rejects.toMatchObject({
      operation: 'select',
      code: 'SQL_CLIENT_ERROR',
    });
    await expect(tx.queryFile('missing.sql')).rejects.toMatchObject({
      operation: 'queryFile',
      code: 'SQL_CLIENT_ERROR',
    });
    await expect(tx.set('Orders', { key: 'id' }).difference([])).rejects.toMatchObject({
      operation: 'set',
      code: 'SQL_CLIENT_ERROR',
    });
    expect(transaction.request).not.toHaveBeenCalled();
  });

  it('rolls back and rethrows when the work throws', async () => {
    const failure = new Error('business rule');

    await expect(
      client.transaction(async (tx) => {
        await tx.delete('Orders', { id: 1 });

        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(transaction.rollback).toHaveBeenCalledTimes(1);
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it('rolls back when the commit fails', async () => {
    const failure = new Error('commit failed');

    transaction.commit.mockRejectedValue(failure);

    await expect(client.transaction(async () => Promise.resolve('ok'))).rejects.toMatchObject({
      code: 'SQL_QUERY_ERROR',
      operation: 'transaction',
      cause: failure,
    });
    expect(transaction.rollback).toHaveBeenCalled();
  });

  it('passes the isolation level', async () => {
    await client.transaction(async () => Promise.resolve(), { isolationLevel: 'serializable' });

    expect(transaction.begin).toHaveBeenCalledWith(sql.ISOLATION_LEVEL.SERIALIZABLE);
  });

  it('runs operations one after another even with Promise.all', async () => {
    const order: string[] = [];

    request.query.mockImplementation(async (text: string) => {
      order.push(`start ${text.slice(0, 6)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`end ${text.slice(0, 6)}`);

      return { recordset: [], rowsAffected: [1] };
    });

    await client.transaction(async (tx) => {
      await Promise.all([tx.update('A', { x: 1 }, { id: 1 }), tx.delete('B', { id: 1 })]);
    });

    expect(order).toEqual(['start UPDATE', 'end UPDATE', 'start DELETE', 'end DELETE']);
  });

  it('waits for operations that were not awaited before committing', async () => {
    let finished = false;

    request.query.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;

      return { recordset: [], rowsAffected: [1] };
    });

    await client.transaction(async (tx) => {
      void tx.delete('Sessions', { userId: 1 });

      return Promise.resolve();
    });

    expect(finished).toBe(true);
    expect(transaction.commit).toHaveBeenCalled();
  });

  it('refuses to be used after it finished', async () => {
    let leaked: Parameters<Parameters<SqlClient['transaction']>[0]>[0] | undefined;

    await client.transaction(async (tx) => {
      leaked = tx;

      return Promise.resolve();
    });

    await expect(leaked?.delete('Users', { id: 1 })).rejects.toThrow(SqlClientError);
    expect(() => leaked?.request()).toThrow(SqlClientError);
  });

  describe('batches', () => {
    const rows = [{ name: 'Ana' }, { name: 'Luis' }];

    it('uses a savepoint instead of a new transaction in rollback mode', async () => {
      request.query.mockResolvedValue(
        batchResult(
          [],
          [
            { i: 0, action: 'inserted', id: 1 },
            { i: 1, action: 'inserted', id: 2 },
          ],
        ),
      );

      const result = await client.transaction(async (tx) => tx.insertMany('Users', rows));

      expect(result.ids).toEqual([1, 2]);
      expect(pool.transaction).toHaveBeenCalledTimes(1);
      expect(request.batch).toHaveBeenCalledWith('SAVE TRAN _batch1;');
    });

    it('rolls back only the batch savepoint when a row fails and the caller catches it', async () => {
      request.query
        .mockResolvedValueOnce({ recordset: [{ id: 9 }], rowsAffected: [1] })
        .mockResolvedValueOnce(batchResult([{ i: 1, number: 2627, message: 'duplicate' }], []));

      await client.transaction(async (tx) => {
        await tx.insert('Orders', { total: 1 });

        const error = await captureError(tx.insertMany('Users', rows));

        expect(error).toBeInstanceOf(BatchRowError);
      });

      expect(request.batch).toHaveBeenLastCalledWith('IF XACT_STATE() = 1 ROLLBACK TRAN _batch1;');
      expect(transaction.commit).toHaveBeenCalled();
    });

    it('isolates rows with savepoints in continue mode', async () => {
      request.query.mockResolvedValue(batchResult([], []));

      await client.transaction(async (tx) =>
        tx.merge('Users', [{ email: 'a' }], { on: 'email', onError: 'continue' }),
      );

      const [[batch]] = request.query.mock.calls as [[string]];

      expect(batch).toContain('SAVE TRAN _row;');
      expect(batch).toContain('IF XACT_STATE() = 1 ROLLBACK TRAN _row;');
      expect(batch).not.toContain('BEGIN TRAN');
    });

    it('uses increasing savepoints and forwards row failures while keeping the transaction usable', async () => {
      const failures = jest.fn();

      client.on('rowFailure', failures);
      request.query
        .mockResolvedValueOnce(batchResult([{ i: 0, number: 2627, message: 'duplicate' }], []))
        .mockResolvedValueOnce(
          batchResult([], [{ i: 0, action: 'inserted', id: '9007199254740993' }]),
        );

      await client.transaction(async (tx) => {
        await expect(tx.insertMany('Users', [{ name: 'Ana' }])).rejects.toBeInstanceOf(
          BatchRowError,
        );
        await expect(tx.insertMany('Users', [{ name: 'Luis' }])).resolves.toMatchObject({
          ids: ['9007199254740993'],
        });
      });

      expect(request.batch).toHaveBeenNthCalledWith(1, 'SAVE TRAN _batch1;');
      expect(request.batch).toHaveBeenNthCalledWith(
        2,
        'IF XACT_STATE() = 1 ROLLBACK TRAN _batch1;',
      );
      expect(request.batch).toHaveBeenNthCalledWith(3, 'SAVE TRAN _batch2;');
      expect(failures).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'insertMany', index: 0, number: 2627 }),
      );
      expect(transaction.commit).toHaveBeenCalledTimes(1);
    });
  });

  describe('events', () => {
    it('emits begin and commit, and tags queries with the transaction id', async () => {
      const events: string[] = [];

      client
        .on('transactionBegin', ({ transactionId }) => events.push(`begin ${transactionId}`))
        .on('query', ({ transactionId }) => events.push(`query ${String(transactionId)}`))
        .on('transactionCommit', ({ transactionId }) => events.push(`commit ${transactionId}`));

      await client.transaction(async (tx) => tx.delete('Users', { id: 1 }));
      await client.delete('Users', { id: 2 });

      expect(events).toEqual(['begin 1', 'query 1', 'commit 1', 'query null']);
    });

    it('emits rollback with the error', async () => {
      const failure = new Error('boom');
      const rollback = jest.fn();

      client.on('transactionRollback', rollback);

      await expect(client.transaction(async () => Promise.reject(failure))).rejects.toBe(failure);
      expect(rollback).toHaveBeenCalledWith({
        transactionId: 1,
        durationMs: expect.any(Number) as number,
        error: failure,
      });
    });
  });
});
