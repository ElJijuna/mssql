import { SqlPrecisionError } from '../errors/SqlPrecisionError';

/** Safe integers are numbers; larger SQL identities are exact base-10 strings. */
export type SqlIdentity = number | string;

/** Decodes identities received as SQL text without rounding. @internal */
export const parseIdentity = (value: unknown): SqlIdentity | null => {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new SqlPrecisionError('An identity was returned as an unsafe number');
    }

    return value;
  }

  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new SqlPrecisionError('An identity must be an integer string or a safe integer');
  }

  const integer = BigInt(value);

  return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(integer)
    : integer.toString();
};
