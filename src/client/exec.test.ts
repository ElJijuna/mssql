import { execScript } from './exec';

describe('execScript', () => {
  it('shows a call without parameters', () => {
    expect(execScript('dbo.Cleanup', [], [])).toBe('EXEC [dbo].[Cleanup];');
  });

  it('passes inputs by name and reads outputs back', () => {
    expect(execScript('dbo.GetOrders', ['customerId', 'status'], ['total'])).toBe(
      'EXEC [dbo].[GetOrders] @customerId = @customerId, @status = @status, @total = @total OUTPUT;\nSELECT @total AS [total];',
    );
  });
});
