import sql from 'mssql';
import { bindInput, t } from '../types/SqlParam';
import { consoleLogger, createDebugEntry, resolveLogger, toLiteral } from './debug';

const requestWith = (values: Record<string, unknown>): sql.Request => {
  const request = new sql.Request();

  for (const [name, value] of Object.entries(values)) {
    bindInput(request, name, value);
  }

  return request;
};

describe('createDebugEntry', () => {
  it('builds a runnable script with typed declarations', () => {
    const request = requestWith({
      p0: t.nvarchar("O'Brien", 100),
      p1: t.decimal(49.99, 10, 2),
      p2: t.datetime2(new Date('2026-09-27T10:30:00.123Z'), 3),
      p3: t.varchar('long', 'max'),
      p4: t.int(null),
    });
    const text = 'INSERT INTO [T] ([a], [b], [c], [d], [e]) VALUES (@p0, @p1, @p2, @p3, @p4);';
    const entry = createDebugEntry('insert', request, text);

    expect(entry.operation).toBe('insert');
    expect(entry.sql).toBe(text);
    expect(entry.params.map(({ name, type }) => `${name} ${type}`)).toEqual([
      'p0 nvarchar(100)',
      'p1 decimal(10, 2)',
      'p2 datetime2(3)',
      'p3 varchar(max)',
      'p4 int',
    ]);
    expect(entry.script).toBe(
      [
        "DECLARE @p0 nvarchar(100) = N'O''Brien';",
        'DECLARE @p1 decimal(10, 2) = 49.99;',
        "DECLARE @p2 datetime2(3) = N'2026-09-27 10:30:00.123';",
        "DECLARE @p3 varchar(max) = N'long';",
        'DECLARE @p4 int = NULL;',
        text,
      ].join('\n'),
    );
  });

  it('declares the type mssql infers for plain values', () => {
    const entry = createDebugEntry(
      'insert',
      requestWith({ p0: 'Ana', p1: 30, p2: true }),
      'SELECT 1;',
    );

    expect(entry.params.map(({ type }) => type)).toEqual(['nvarchar(max)', 'int', 'bit']);
  });

  it('has only the SQL when there are no parameters', () => {
    expect(createDebugEntry('delete', new sql.Request(), 'SELECT 1;').script).toBe('SELECT 1;');
  });
});

describe('toLiteral', () => {
  it.each([
    [null, 'NULL'],
    [undefined, 'NULL'],
    [5, '5'],
    [10n, '10'],
    [true, '1'],
    [false, '0'],
    [Buffer.from('hi'), '0x6869'],
    ["it's", "N'it''s'"],
  ])('formats %p as %s', (value, expected) => {
    expect(toLiteral(value)).toBe(expected);
  });
});

describe('resolveLogger', () => {
  const custom = jest.fn();

  it('is off by default', () => {
    expect(resolveLogger(undefined, undefined)).toBeNull();
  });

  it('uses the console logger for true', () => {
    expect(resolveLogger(true, undefined)).toBe(consoleLogger);
  });

  it('lets the call option override the client option', () => {
    expect(resolveLogger(true, false)).toBeNull();
    expect(resolveLogger(false, true)).toBe(consoleLogger);
    expect(resolveLogger(true, custom)).toBe(custom);
  });
});

describe('consoleLogger', () => {
  it('prints the operation and script', () => {
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined);

    consoleLogger({ operation: 'insert', sql: 'SELECT 1;', params: [], script: 'SELECT 1;' });

    expect(debug).toHaveBeenCalledWith('-- [@pilmee/mssql] insert\nSELECT 1;\n');
    debug.mockRestore();
  });
});
