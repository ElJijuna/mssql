import { SqlClientError } from './SqlClientError';

/** A value cannot be represented safely using the requested numeric representation. */
export class SqlPrecisionError extends SqlClientError {
  public constructor(message: string) {
    super(message, { code: 'SQL_PRECISION_ERROR' });
    this.name = 'SqlPrecisionError';
  }
}
