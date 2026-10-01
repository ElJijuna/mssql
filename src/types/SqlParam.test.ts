import sql from 'mssql';
import { SqlPrecisionError } from '../errors/SqlPrecisionError';
import { bindInput, SqlParam, t } from './SqlParam';

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
