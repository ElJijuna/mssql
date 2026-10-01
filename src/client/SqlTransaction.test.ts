import sql from 'mssql';
import { BatchRowError } from '../errors/BatchRowError';
import { SqlClientError } from '../errors/SqlClientError';
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
