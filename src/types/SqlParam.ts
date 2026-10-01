import sql from 'mssql';
import { SqlPrecisionError } from '../errors/SqlPrecisionError';

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

/** Decimal text sent as NVARCHAR and converted to DECIMAL/NUMERIC by SQL Server. */
export class SqlExactDecimal extends SqlParam<string> {
  public constructor(
    value: string | null,
    public readonly kind: 'decimal' | 'numeric',
    public readonly precision: number,
    public readonly scale: number,
  ) {
    if (kind !== 'decimal' && kind !== 'numeric') {
      throw new SqlPrecisionError('Exact decimal kind must be decimal or numeric');
    }

    if (
      !Number.isInteger(precision) ||
      precision < 1 ||
      precision > 38 ||
      !Number.isInteger(scale) ||
      scale < 0 ||
      scale > precision
    ) {
      throw new SqlPrecisionError('Decimal precision must be 1..38 and scale must be 0..precision');
    }

    if (value !== null) {
      if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) {
        throw new SqlPrecisionError(
          'Exact decimals require a base-10 string without exponent notation',
        );
      }

      const [whole = '', fraction = ''] = value.replace(/^[+-]/, '').split('.');
      const digits = whole.replace(/^0+/, '').length;

      if (digits > precision - scale || fraction.length > scale) {
        throw new SqlPrecisionError(
          `Value does not fit ${kind}(${precision}, ${scale}) without rounding`,
        );
      }
    }

    super(sql.NVarChar(sql.MAX), value);
  }
}

const bigintValue = (value: Nullable<number | string | bigint>): number | string | null => {
  if (value === null) {
    return null;
  }

  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new SqlPrecisionError(
      'BIGINT numbers must be safe integers; use a string or bigint instead',
    );
  }

  if (typeof value === 'string' && !/^[+-]?\d+$/.test(value)) {
    throw new SqlPrecisionError('BIGINT strings must contain a base-10 integer');
  }

  const integer = BigInt(value);

  if (integer < -9223372036854775808n || integer > 9223372036854775807n) {
    throw new SqlPrecisionError('BIGINT is outside the SQL Server signed 64-bit range');
  }

  return typeof value === 'number' ? value : integer.toString();
};

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
  bigint: (value: Nullable<number | string | bigint>) => param(sql.BigInt(), bigintValue(value)),
  decimal: (value: Nullable<number | string>, precision = 18, scale = 0) =>
    param(sql.Decimal(precision, scale), value),
  numeric: (value: Nullable<number | string>, precision = 18, scale = 0) =>
    param(sql.Numeric(precision, scale), value),
  /** Preserves decimal text; rejects values that require rounding to fit. */
  decimalExact: (value: Nullable<string>, precision = 18, scale = 0) =>
    new SqlExactDecimal(value, 'decimal', precision, scale),
  /** Preserves numeric text; rejects values that require rounding to fit. */
  numericExact: (value: Nullable<string>, precision = 18, scale = 0) =>
    new SqlExactDecimal(value, 'numeric', precision, scale),
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
export const bindInput = (request: sql.Request, name: string, value: unknown): string => {
  if (value instanceof SqlParam) {
    request.input(name, value.type, value.value);

    return value instanceof SqlExactDecimal
      ? `CONVERT(${value.kind}(${value.precision}, ${value.scale}), @${name})`
      : `@${name}`;
  }

  if (typeof value === 'bigint') {
    request.input(name, sql.BigInt(), bigintValue(value));
  } else {
    request.input(name, value);
  }

  return `@${name}`;
};
