import sql from 'mssql';

/**
 * Length for variable-size types: a number of characters/bytes, or `'max'`.
 */
export type SqlLength = number | 'max';

/**
 * A value paired with an explicit SQL Server type. Create it with the {@link t} builders.
 */
export class SqlParam<TValue = unknown> {
  public constructor(
    public readonly type: sql.ISqlType,
    public readonly value: TValue | null,
  ) {}
}

/**
 * A value that may be `null` (sent as SQL `NULL`).
 */
export type Nullable<TValue> = TValue | null;

const toLength = (length: SqlLength): number => (length === 'max' ? sql.MAX : length);
const param = <TValue>(type: sql.ISqlType, value: Nullable<TValue>): SqlParam<TValue> =>
  new SqlParam(type, value);

/**
 * Builders for typed parameters, named after their T-SQL types.
 * Values are passed first, then the type dimensions (length, precision, scale).
 *
 * @example
 * await client.insert('dbo.Products', {
 *   name: t.nvarchar('Keyboard', 100),
 *   description: t.nvarchar(text, 'max'),
 *   price: t.decimal(49.99, 10, 2),
 *   createdAt: t.datetime2(new Date(), 3),
 *   stock: 10, // untyped values are still inferred by mssql
 * });
 */
export const t = {
  // Exact numerics
  bit: (value: Nullable<boolean>) => param(sql.Bit(), value),
  tinyint: (value: Nullable<number>) => param(sql.TinyInt(), value),
  smallint: (value: Nullable<number>) => param(sql.SmallInt(), value),
  int: (value: Nullable<number>) => param(sql.Int(), value),
  bigint: (value: Nullable<number | string | bigint>) =>
    param(sql.BigInt(), typeof value === 'bigint' ? value.toString() : value),
  decimal: (value: Nullable<number | string>, precision = 18, scale = 0) =>
    param(sql.Decimal(precision, scale), value),
  numeric: (value: Nullable<number | string>, precision = 18, scale = 0) =>
    param(sql.Numeric(precision, scale), value),
  money: (value: Nullable<number>) => param(sql.Money(), value),
  smallmoney: (value: Nullable<number>) => param(sql.SmallMoney(), value),

  // Approximate numerics
  float: (value: Nullable<number>) => param(sql.Float(), value),
  real: (value: Nullable<number>) => param(sql.Real(), value),

  // Strings
  char: (value: Nullable<string>, length: number) => param(sql.Char(length), value),
  nchar: (value: Nullable<string>, length: number) => param(sql.NChar(length), value),
  varchar: (value: Nullable<string>, length: SqlLength) =>
    param(sql.VarChar(toLength(length)), value),
  nvarchar: (value: Nullable<string>, length: SqlLength) =>
    param(sql.NVarChar(toLength(length)), value),

  // Binary
  binary: (value: Nullable<Buffer>, length: number) =>
    // @types/mssql omits the length argument, but the runtime factory accepts it.
    param((sql.Binary as unknown as (length: number) => sql.ISqlType)(length), value),
  varbinary: (value: Nullable<Buffer>, length: SqlLength) =>
    param(sql.VarBinary(toLength(length)), value),

  // Date and time
  date: (value: Nullable<Date | string>) => param(sql.Date(), value),
  time: (value: Nullable<Date | string>, scale = 7) => param(sql.Time(scale), value),
  datetime: (value: Nullable<Date | string>) => param(sql.DateTime(), value),
  datetime2: (value: Nullable<Date | string>, scale = 7) => param(sql.DateTime2(scale), value),
  datetimeoffset: (value: Nullable<Date | string>, scale = 7) =>
    param(sql.DateTimeOffset(scale), value),
  smalldatetime: (value: Nullable<Date | string>) => param(sql.SmallDateTime(), value),

  // Other
  uniqueidentifier: (value: Nullable<string>) => param(sql.UniqueIdentifier(), value),
  xml: (value: Nullable<string>) => param(sql.Xml(), value),
} as const;

/**
 * Binds a value to a request, using its explicit type when it is a {@link SqlParam}.
 *
 * @internal
 */
export const bindInput = (request: sql.Request, name: string, value: unknown): void => {
  if (value instanceof SqlParam) {
    request.input(name, value.type, value.value);

    return;
  }

  request.input(name, value);
};
