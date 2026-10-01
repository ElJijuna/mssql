import sql from 'mssql';
import { SqlPrecisionError } from '../errors/SqlPrecisionError';
import { bindInput, SqlExactDecimal, SqlParam, t } from './SqlParam';

describe('complete parameter contract', () => {
  const date = new Date('2026-01-02T03:04:05.000Z');
  const bytes = Buffer.from([0, 255]);

  it.each([
    ['bit', () => t.bit(true), sql.Bit(), true],
    ['tinyint', () => t.tinyint(255), sql.TinyInt(), 255],
    ['smallint', () => t.smallint(-32768), sql.SmallInt(), -32768],
    ['int', () => t.int(42), sql.Int(), 42],
    ['bigint', () => t.bigint(42), sql.BigInt(), 42],
    ['decimal', () => t.decimal('123.45', 12, 2), sql.Decimal(12, 2), '123.45'],
    ['numeric', () => t.numeric('123.45', 12, 2), sql.Numeric(12, 2), '123.45'],
    ['money', () => t.money(19.99), sql.Money(), 19.99],
    ['smallmoney', () => t.smallmoney(-19.99), sql.SmallMoney(), -19.99],
    ['float', () => t.float(1.25), sql.Float(), 1.25],
    ['real', () => t.real(1.25), sql.Real(), 1.25],
    ['char', () => t.char('A', 8), sql.Char(8), 'A'],
    ['nchar', () => t.nchar('ñ', 8), sql.NChar(8), 'ñ'],
    ['varchar', () => t.varchar('hello', 100), sql.VarChar(100), 'hello'],
    ['nvarchar', () => t.nvarchar('你好', 100), sql.NVarChar(100), '你好'],
    ['binary', () => t.binary(bytes, 2), { type: sql.Binary, length: 2 }, bytes],
    ['varbinary', () => t.varbinary(bytes, 2), sql.VarBinary(2), bytes],
    ['date', () => t.date(date), sql.Date(), date],
    ['time', () => t.time('03:04:05', 3), sql.Time(3), '03:04:05'],
    ['datetime', () => t.datetime(date), sql.DateTime(), date],
    ['datetime2', () => t.datetime2(date, 3), sql.DateTime2(3), date],
    [
      'datetimeoffset',
      () => t.datetimeoffset('2026-01-02T03:04:05+02:00', 3),
      sql.DateTimeOffset(3),
      '2026-01-02T03:04:05+02:00',
    ],
    ['smalldatetime', () => t.smalldatetime(date), sql.SmallDateTime(), date],
    [
      'uniqueidentifier',
      () => t.uniqueidentifier('8bd29468-3a54-48a4-906d-921b8f5c8b85'),
      sql.UniqueIdentifier(),
      '8bd29468-3a54-48a4-906d-921b8f5c8b85',
    ],
    ['xml', () => t.xml('<root/>'), sql.Xml(), '<root/>'],
  ] satisfies Array<[string, () => SqlParam, sql.ISqlType & { length?: number }, unknown]>)(
    'preserves %s values and SQL dimensions',
    (_name, build, type, value) => {
      const parameter = build();

      expect(parameter).toBeInstanceOf(SqlParam);
      expect(parameter.type).toEqual(type);
      expect(parameter.value).toBe(value);
    },
  );

  it('keeps NULL across every builder family', () => {
    const parameters = [
      t.bit(null),
      t.tinyint(null),
      t.smallint(null),
      t.int(null),
      t.bigint(null),
      t.decimal(null),
      t.numeric(null),
      t.money(null),
      t.smallmoney(null),
      t.float(null),
      t.real(null),
      t.char(null, 1),
      t.nchar(null, 1),
      t.varchar(null, 'max'),
      t.nvarchar(null, 'max'),
      t.binary(null, 1),
      t.varbinary(null, 'max'),
      t.date(null),
      t.time(null),
      t.datetime(null),
      t.datetime2(null),
      t.datetimeoffset(null),
      t.smalldatetime(null),
      t.uniqueidentifier(null),
      t.xml(null),
      t.decimalExact(null),
      t.numericExact(null),
    ];

    expect(parameters.every((parameter) => parameter.value === null)).toBe(true);
  });

  it('uses the documented default dimensions', () => {
    expect(t.decimal(1).type).toEqual(sql.Decimal(18, 0));
    expect(t.numeric(1).type).toEqual(sql.Numeric(18, 0));
    expect(t.decimalExact('1')).toMatchObject({ precision: 18, scale: 0, kind: 'decimal' });
    expect(t.numericExact('1')).toMatchObject({ precision: 18, scale: 0, kind: 'numeric' });
    expect(t.time(date).type).toEqual(sql.Time(7));
    expect(t.datetime2(date).type).toEqual(sql.DateTime2(7));
    expect(t.datetimeoffset(date).type).toEqual(sql.DateTimeOffset(7));
    expect(t.varchar('text', 'max').type).toEqual(sql.VarChar(sql.MAX));
  });

  it.each([
    [0, 0],
    [1.5, 0],
    [38, -1],
    [38, 1.5],
    [NaN, 0],
    [38, Infinity],
  ])('rejects invalid precision %s / scale %s', (precision, scale) => {
    expect(() => t.decimalExact('0', precision, scale)).toThrow(SqlPrecisionError);
  });

  it.each(['', ' 1', '1 ', '.1', '1.', 'NaN', 'Infinity', '--1', '1; DROP TABLE Users'])(
    'rejects invalid exact decimal text %p',
    (value) => {
      expect(() => t.numericExact(value, 38, 18)).toThrow(SqlPrecisionError);
    },
  );

  it('rejects invalid runtime decimal types and kinds', () => {
    expect(() => t.decimalExact(1 as unknown as string)).toThrow(SqlPrecisionError);
    expect(() => new SqlExactDecimal('1', 'float' as 'decimal', 10, 0)).toThrow(SqlPrecisionError);
  });

  it('accepts signs, leading zeroes, and exact boundaries', () => {
    expect(t.decimalExact('-000.12', 2, 2).value).toBe('-000.12');
    expect(t.numericExact('+999', 3, 0).value).toBe('+999');
    expect(t.decimalExact('0', 1, 1).value).toBe('0');
    expect(t.decimalExact('9'.repeat(38), 38, 0).value).toBe('9'.repeat(38));
    expect(t.bigint('+00042').value).toBe('42');
    expect(t.bigint(Number.MIN_SAFE_INTEGER).value).toBe(Number.MIN_SAFE_INTEGER);
    expect(t.bigint(Number.MAX_SAFE_INTEGER).value).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('preserves ordinary references and NULL bindings', () => {
    const request = new sql.Request();

    expect(bindInput(request, 'value', t.bigint(null))).toBe('@value');
    expect(request.parameters.value?.value).toBeNull();
    expect(bindInput(request, 'plain', null)).toBe('@plain');
    expect(request.parameters.plain?.value).toBeNull();
    expect(bindInput(request, 'amount', t.numericExact(null, 12, 2))).toBe(
      'CONVERT(numeric(12, 2), @amount)',
    );
    expect(request.parameters.amount?.value).toBeNull();
  });

  it('rejects an out-of-range native bigint before binding', () => {
    const request = new sql.Request();

    expect(() => bindInput(request, 'id', 9223372036854775808n)).toThrow(SqlPrecisionError);
    expect(request.parameters).toEqual({});
  });

  it('preserves driver errors when binding fails', () => {
    const request = new sql.Request();

    bindInput(request, 'id', t.int(1));

    expect(() => bindInput(request, 'id', t.int(2))).toThrow('already been declared');
  });
});

describe('t builders', () => {
  it('builds a type without dimensions', () => {
    const param = t.int(5);

    expect(param).toBeInstanceOf(SqlParam);
    expect(param.type.type).toBe(sql.Int);
    expect(param.value).toBe(5);
  });

  it('sets the length of string types', () => {
    expect(t.nvarchar('Ana', 100).type).toEqual({ type: sql.NVarChar, length: 100 });
    expect(t.char('A', 1).type).toEqual({ type: sql.Char, length: 1 });
  });

  it("maps 'max' to sql.MAX", () => {
    expect(t.nvarchar('long', 'max').type).toEqual({ type: sql.NVarChar, length: sql.MAX });
    expect(t.varbinary(Buffer.from('x'), 'max').type).toEqual({
      type: sql.VarBinary,
      length: sql.MAX,
    });
  });

  it('sets the length of binary', () => {
    expect(t.binary(Buffer.from('x'), 16).type).toEqual({ type: sql.Binary, length: 16 });
  });

  it('sets precision and scale', () => {
    expect(t.decimal(1.5, 10, 2).type).toEqual({ type: sql.Decimal, precision: 10, scale: 2 });
    expect(t.numeric(1).type).toEqual({ type: sql.Numeric, precision: 18, scale: 0 });
  });

  it('sets the scale of time types', () => {
    expect(t.datetime2(new Date(), 3).type).toEqual({ type: sql.DateTime2, scale: 3 });
    expect(t.time('10:00').type).toEqual({ type: sql.Time, scale: 7 });
  });

  it('converts native bigint to string', () => {
    expect(t.bigint(9007199254740993n).value).toBe('9007199254740993');
  });

  it.each([
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    Infinity,
    NaN,
    '9223372036854775808',
    '-9223372036854775809',
    '1.5',
  ])('rejects unsafe or invalid BIGINT %s', (value) => {
    expect(() => t.bigint(value)).toThrow(SqlPrecisionError);
  });

  it('accepts exact BIGINT boundaries', () => {
    expect(t.bigint(9223372036854775807n).value).toBe('9223372036854775807');
    expect(t.bigint('-9223372036854775808').value).toBe('-9223372036854775808');
  });

  it('validates exact decimal dimensions and rejects implicit rounding', () => {
    expect(t.decimalExact('12345678901234567890.123456789012345678', 38, 18).value).toBe(
      '12345678901234567890.123456789012345678',
    );
    expect(t.decimalExact('0.12', 2, 2).value).toBe('0.12');
    expect(t.numericExact(null, 38, 18).value).toBeNull();
    expect(() => t.decimalExact('1.234', 5, 2)).toThrow(SqlPrecisionError);
    expect(() => t.decimalExact('1000', 3, 0)).toThrow(SqlPrecisionError);
    expect(() => t.decimalExact('1e3', 5, 0)).toThrow(SqlPrecisionError);
    expect(() => t.decimalExact('1', 39, 0)).toThrow(SqlPrecisionError);
    expect(() => t.decimalExact('1', 5, 6)).toThrow(SqlPrecisionError);
  });

  it('keeps null values', () => {
    expect(t.nvarchar(null, 50).value).toBeNull();
  });
});

describe('bindInput', () => {
  const request = { input: jest.fn() };

  beforeEach(() => request.input.mockReset());

  it('passes the explicit type of a SqlParam', () => {
    const param = t.decimal(9.99, 10, 2);

    bindInput(request as unknown as sql.Request, 'p0', param);

    expect(request.input).toHaveBeenCalledWith('p0', param.type, 9.99);
  });

  it('lets mssql infer the type of plain values', () => {
    bindInput(request as unknown as sql.Request, 'p0', 'Ana');

    expect(request.input).toHaveBeenCalledWith('p0', 'Ana');
  });

  it('binds native bigint with an explicit BIGINT type', () => {
    bindInput(request as unknown as sql.Request, 'p0', 9007199254740993n);

    expect(request.input).toHaveBeenCalledWith('p0', sql.BigInt(), '9007199254740993');
  });

  it('binds exact decimal text and converts it on the server', () => {
    const expression = bindInput(
      request as unknown as sql.Request,
      'p0',
      t.decimalExact('9007199254740993.01', 20, 2),
    );

    expect(request.input).toHaveBeenCalledWith('p0', sql.NVarChar(sql.MAX), '9007199254740993.01');
    expect(expression).toBe('CONVERT(decimal(20, 2), @p0)');
  });
});
