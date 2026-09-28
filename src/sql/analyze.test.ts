import { analyzeSql, maskSql } from './analyze';

const required = (text: string) => analyzeSql(text).required;

describe('maskSql', () => {
  it('blanks comments, strings and quoted identifiers but keeps positions and newlines', () => {
    const text = 'SELECT \'@a\' AS [@b], "@c" -- @d\n/* @e /* nested @f */ */ @g';
    const masked = maskSql(text);

    expect(masked).toHaveLength(text.length);
    expect(masked).not.toMatch(/@[a-f]/u);
    expect(masked).toContain('@g');
    expect(masked.split('\n')).toHaveLength(2);
  });

  it('handles escaped quotes and brackets', () => {
    expect(maskSql("'it''s @x' @y")).toMatch(/^\s+@y$/u);
    expect(maskSql('[a]]@x] @y')).toMatch(/^\s+@y$/u);
  });
});

describe('analyzeSql', () => {
  it('finds parameters in order, once each', () => {
    expect(required('SELECT * FROM T WHERE a = @a AND b = @b OR a = @A')).toEqual(['a', 'b']);
  });

  it('records every reference with its position', () => {
    const text = 'SELECT @x, @x';

    expect(analyzeSql(text).references).toEqual([
      { name: 'x', start: 7, end: 9 },
      { name: 'x', start: 11, end: 13 },
    ]);
  });

  it('ignores system functions, comments and strings', () => {
    expect(required("SELECT @@ROWCOUNT, '@notParam' -- @nope\nWHERE id = @id")).toEqual(['id']);
  });

  it('ignores declared variables, including multi-variable declares and table variables', () => {
    const text = `
      DECLARE @total int = 0, @label nvarchar(50) = @prefix;
      DECLARE @rows TABLE (id int, amount decimal(10, 2));
      INSERT INTO @rows SELECT id, amount FROM dbo.Orders WHERE customerId = @customerId;
      SELECT @total = COUNT(*) FROM @rows;
      SELECT @total AS total, @label AS label;`;

    expect(required(text)).toEqual(['prefix', 'customerId']);
  });

  it('ends a DECLARE without semicolon at the next statement', () => {
    expect(required('DECLARE @x int SELECT @x = 1, @y')).toEqual(['y']);
  });

  it('ignores EXEC argument names but not their values', () => {
    expect(required('EXEC dbo.Proc @userId = @id, @flag = 1; SELECT @other')).toEqual([
      'id',
      'other',
    ]);
  });

  it('keeps comparisons with = outside EXEC', () => {
    expect(required('SELECT * FROM T WHERE @tenantId = tenantId')).toEqual(['tenantId']);
  });

  it('detects GO batch separators outside comments and strings', () => {
    expect(analyzeSql('SELECT 1\nGO\nSELECT 2').hasBatchSeparator).toBe(true);
    expect(analyzeSql('SELECT 1\n  go 2  \n').hasBatchSeparator).toBe(true);
    expect(analyzeSql("SELECT 'GO'\n-- GO\nSELECT 1 AS go_live").hasBatchSeparator).toBe(false);
  });
});
