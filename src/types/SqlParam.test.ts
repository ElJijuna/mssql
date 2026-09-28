import sql from 'mssql';
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
});
