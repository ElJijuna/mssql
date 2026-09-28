import { SqlClientError } from '../errors/SqlClientError';
import { quoteIdentifier } from './quoteIdentifier';

describe('quoteIdentifier', () => {
  it('quotes a single name', () => {
    expect(quoteIdentifier('Users')).toBe('[Users]');
  });

  it('quotes each part of a multi-part name', () => {
    expect(quoteIdentifier('dbo.Users')).toBe('[dbo].[Users]');
  });

  it('escapes closing brackets', () => {
    expect(quoteIdentifier('we]ird')).toBe('[we]]ird]');
  });

  it.each(['', 'dbo.', '.Users', 'dbo. .Users'])('rejects invalid identifier "%s"', (name) => {
    expect(() => quoteIdentifier(name)).toThrow(SqlClientError);
  });
});
