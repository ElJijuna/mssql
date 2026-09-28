import sql from 'mssql';
import type { QueryOptions } from '../debug/debug';
import { SqlClientError } from '../errors/SqlClientError';
import { SqlParam } from '../types/SqlParam';
import { quoteIdentifier } from '../utils/quoteIdentifier';
import type { CommandContext } from './commands';
import { orderByClause, type SqlOrderBy } from './select';
import { bindWhere, type SqlWhere } from './statements';
import type { SqlRow } from './types';

/**
 * Options for {@link SqlClient.set}.
 */
export interface SqlSetOptions {
  /**
   * Column(s) that identify an element, e.g. `'email'` or `['tenantId', 'code']`. With a composite
   * key the list must contain objects.
   */
  key: string | string[];
  /** Filter for the database side (same rules as `select`). */
  where?: SqlWhere;
  /** Columns returned for database rows. Defaults to every column (`*`). */
  columns?: string[];
  /** Order of returned database rows. */
  orderBy?: SqlOrderBy;
  /**
   * Compare text keys exactly, like JavaScript (`'Ana' !== 'ana'`). By default they follow the
   * column's collation, which is usually case-insensitive. Exact comparison can't use indexes.
   */
  caseSensitive?: boolean;
}

/**
 * Result of {@link SqlSet.symmetricDifference}.
 */
export interface SqlSymmetricDifference<TRow, TItem> {
  /** Database rows whose key is not in the list. */
  onlyInDb: TRow[];
  /** List items whose key is not in the database. */
  onlyInList: TItem[];
}

/**
 * Result of {@link SqlSet.union}.
 */
export interface SqlUnion<TRow, TItem> {
  /** Every database row of the set. */
  inDb: TRow[];
  /** List items whose key is not in the database. */
  onlyInList: TItem[];
}

/**
 * A key column as described by the catalog.
 *
 * @internal
 */
export interface KeyColumn {
  name: string;
  /** Type used to read it from JSON (`OPENJSON … WITH`). */
  declaration: string;
  /** Collation for text columns, `null` otherwise. */
  collation: string | null;
}

interface CatalogColumn {
  name: string;
  type: string;
  precision: number;
  scale: number;
  collation: string | null;
}

const TEXT_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'text', 'ntext']);
const SCALED_TYPES = new Set(['datetime2', 'time', 'datetimeoffset']);
const EXACT_COLLATION = 'Latin1_General_100_BIN2';

/**
 * Maps a catalog column to the type used to read list values from JSON.
 *
 * @internal
 */
export const toKeyColumn = (column: CatalogColumn): KeyColumn => {
  const { name, type, precision, scale, collation } = column;

  if (collation !== null && !/^[A-Za-z0-9_]+$/u.test(collation)) {
    throw new SqlClientError(`Unexpected collation "${collation}" for column "${name}"`);
  }

  if (TEXT_TYPES.has(type)) {
    return { name, declaration: 'nvarchar(max)', collation };
  }

  if (type === 'decimal' || type === 'numeric') {
    return {
      name,
      declaration: `decimal(${String(precision)}, ${String(scale)})`,
      collation: null,
    };
  }

  if (SCALED_TYPES.has(type)) {
    return { name, declaration: `${type}(${String(scale)})`, collation: null };
  }

  if (type.includes('binary') || type === 'image' || type === 'xml' || type === 'sql_variant') {
    throw new SqlClientError(`Column "${name}" (${type}) can't be used as a set key`);
  }

  return { name, declaration: type, collation: null };
};

/**
 * Converts list items to the JSON sent as the single `@__list` parameter: `[{ i, k0, k1… }]`.
 * Items whose key has a `null`/`undefined` part are left out (NULL never matches in SQL).
 *
 * @internal
 */
export const listToJson = (list: readonly unknown[], keys: string[]): string => {
  const entries = list.flatMap((item, index) => {
    const parts = keys.map((key) => {
      if (
        typeof item === 'object' &&
        item !== null &&
        !(item instanceof Date) &&
        !(item instanceof SqlParam)
      ) {
        if (!(key in item)) {
          throw new SqlClientError(`List item ${String(index)} has no "${key}" property`);
        }

        return (item as Record<string, unknown>)[key];
      }

      if (keys.length > 1) {
        throw new SqlClientError(
          `List item ${String(index)} must be an object with ${keys.join(', ')} (composite key)`,
        );
      }

      return item;
    });
    const values = parts.map((part): unknown =>
      part instanceof SqlParam ? (part.value as unknown) : part,
    );

    if (values.some((value) => value === null || value === undefined)) {
      return [];
    }

    const entry: Array<[string, unknown]> = [
      ['i', index],
      ...values.map((value, n): [string, unknown] => [
        `k${String(n)}`,
        typeof value === 'bigint' ? value.toString() : value,
      ]),
    ];

    return [Object.fromEntries(entry)];
  });

  return JSON.stringify(entries);
};

type SetOperation =
  | 'difference'
  | 'intersection'
  | 'missing'
  | 'symmetricDifference'
  | 'union'
  | 'isSubsetOf'
  | 'isSupersetOf'
  | 'isDisjointFrom';

/**
 * Builds the SQL of a set operation. `@__list` holds the list; the `where` parameters are already
 * bound as `@p0…`.
 *
 * @internal
 */
export const buildSetStatement = (
  operation: SetOperation,
  table: string,
  keys: KeyColumn[],
  where: string,
  options: Pick<SqlSetOptions, 'columns' | 'orderBy' | 'caseSensitive'>,
): string => {
  const target = quoteIdentifier(table);
  const text = (key: KeyColumn) => key.collation !== null;
  const collate = (key: KeyColumn) => (options.caseSensitive ? EXACT_COLLATION : key.collation);
  const listColumns = keys.map((key, n) => `[k${String(n)}] ${key.declaration} '$.k${String(n)}'`);
  const cte = `WITH [__list] AS (SELECT * FROM OPENJSON(@__list) WITH ([i] int '$.i', ${listColumns.join(', ')}))`;
  const match = keys
    .map((key, n) => {
      const column = `[__a].${quoteIdentifier(key.name)}`;
      const value = `[__l].[k${String(n)}]`;

      if (!text(key)) {
        return `${column} = ${value}`;
      }

      return options.caseSensitive
        ? `${column} COLLATE ${EXACT_COLLATION} = ${value} COLLATE ${EXACT_COLLATION}`
        : `${column} = ${value} COLLATE ${String(collate(key))}`;
    })
    .join(' AND ');
  const filters = [where, ...keys.map((key) => `[__a].${quoteIdentifier(key.name)} IS NOT NULL`)]
    .filter((part) => part !== '')
    .join(' AND ');
  const source = `FROM ${target} AS [__a] WHERE ${filters}`;
  const inList = `EXISTS (SELECT 1 FROM [__list] AS [__l] WHERE ${match})`;
  const inDb = `EXISTS (SELECT 1 ${source} AND ${match})`;
  const columns =
    options.columns === undefined || options.columns.length === 0
      ? '[__a].*'
      : options.columns.map((column) => `[__a].${quoteIdentifier(column)}`).join(', ');
  const order = orderByClause(options.orderBy);
  const rows = (condition: string) => `SELECT ${columns} ${source}${condition}${order};`;
  const groupKeys = keys
    .map((key, n) => `[__l].[k${String(n)}]${text(key) ? ` COLLATE ${String(collate(key))}` : ''}`)
    .join(', ');
  const missing = `SELECT MIN([__l].[i]) AS [i] FROM [__list] AS [__l] WHERE NOT ${inDb} GROUP BY ${groupKeys} ORDER BY MIN([__l].[i]);`;
  const check = (condition: string) =>
    `SELECT CASE WHEN ${condition} THEN 0 ELSE 1 END AS [result];`;
  // A CTE only covers the statement right after it, so each statement gets its own.
  const statements: Record<SetOperation, string[]> = {
    difference: [rows(` AND NOT ${inList}`)],
    intersection: [rows(` AND ${inList}`)],
    missing: [missing],
    symmetricDifference: [rows(` AND NOT ${inList}`), missing],
    union: [rows(''), missing],
    isSubsetOf: [check(`EXISTS (SELECT 1 ${source} AND NOT ${inList})`)],
    isSupersetOf: [check(`EXISTS (SELECT 1 FROM [__list] AS [__l] WHERE NOT ${inDb})`)],
    isDisjointFrom: [check(`EXISTS (SELECT 1 ${source} AND ${inList})`)],
  };

  return statements[operation].map((statement) => `${cte}\n${statement}`).join('\n');
};

/**
 * Runs `work` with a command context, applying the caller's retries/queueing.
 *
 * @internal
 */
export type SetRunner = <TResult>(
  work: (ctx: CommandContext, options: QueryOptions) => Promise<TResult>,
  options: QueryOptions,
) => Promise<TResult>;

/**
 * A set of database rows identified by a key, compared with JavaScript lists using the same
 * operations as `Set`. Everything runs in SQL Server: rows are never all downloaded to compare.
 * Create it with {@link SqlClient.set}.
 */
export class SqlSet<TRow extends object = SqlRow> {
  private readonly keys: string[];
  private keyColumns: KeyColumn[] | undefined;

  /**
   * @internal
   */
  public constructor(
    private readonly table: string,
    private readonly options: SqlSetOptions,
    private readonly run: SetRunner,
  ) {
    this.keys = Array.isArray(options.key) ? options.key : [options.key];

    if (this.keys.length === 0) {
      throw new SqlClientError('set requires at least one key column');
    }
  }

  /** Database rows whose key is **not** in `list` (e.g. records to remove). */
  public async difference(list: readonly unknown[], options: QueryOptions = {}): Promise<TRow[]> {
    const [rows = []] = await this.execute('difference', list, options);

    return rows as TRow[];
  }

  /** Database rows whose key **is** in `list`. */
  public async intersection(list: readonly unknown[], options: QueryOptions = {}): Promise<TRow[]> {
    const [rows = []] = await this.execute('intersection', list, options);

    return rows as TRow[];
  }

  /**
   * Items of `list` whose key is **not** in the database (e.g. records to add). Returns your own
   * items (first occurrence per key), in list order.
   */
  public async missing<TItem>(
    list: readonly TItem[],
    options: QueryOptions = {},
  ): Promise<TItem[]> {
    const [indexes = []] = await this.execute('missing', list, options);

    return this.pick(list, indexes);
  }

  /** Both sides of the difference: rows only in the database and items only in `list`. */
  public async symmetricDifference<TItem>(
    list: readonly TItem[],
    options: QueryOptions = {},
  ): Promise<SqlSymmetricDifference<TRow, TItem>> {
    const [rows = [], indexes = []] = await this.execute('symmetricDifference', list, options);

    return { onlyInDb: rows as TRow[], onlyInList: this.pick(list, indexes) };
  }

  /** Every database row of the set, plus the items of `list` that aren't in the database. */
  public async union<TItem>(
    list: readonly TItem[],
    options: QueryOptions = {},
  ): Promise<SqlUnion<TRow, TItem>> {
    const [rows = [], indexes = []] = await this.execute('union', list, options);

    return { inDb: rows as TRow[], onlyInList: this.pick(list, indexes) };
  }

  /** Whether every database key is in `list`. */
  public async isSubsetOf(list: readonly unknown[], options: QueryOptions = {}): Promise<boolean> {
    return this.check('isSubsetOf', list, options);
  }

  /** Whether every key of `list` is in the database. */
  public async isSupersetOf(
    list: readonly unknown[],
    options: QueryOptions = {},
  ): Promise<boolean> {
    return this.check('isSupersetOf', list, options);
  }

  /** Whether no key of `list` is in the database. */
  public async isDisjointFrom(
    list: readonly unknown[],
    options: QueryOptions = {},
  ): Promise<boolean> {
    return this.check('isDisjointFrom', list, options);
  }

  private async check(
    operation: SetOperation,
    list: readonly unknown[],
    options: QueryOptions,
  ): Promise<boolean> {
    const [[row] = []] = await this.execute(operation, list, options);

    return row?.result === 1 || row?.result === true;
  }

  private pick<TItem>(list: readonly TItem[], indexes: SqlRow[]): TItem[] {
    return indexes.map(({ i }) => list[i as number] as TItem);
  }

  private async execute(
    operation: SetOperation,
    list: readonly unknown[],
    options: QueryOptions,
  ): Promise<SqlRow[][]> {
    const json = listToJson(list, this.keys);

    return this.run(async (ctx, queryOptions) => {
      const keys = await this.loadKeyColumns(ctx, queryOptions);
      const query = ctx.runner('set', queryOptions);
      const request = await ctx.request();
      const { predicate } = bindWhere(this.options.where ?? {}, request, 0);

      request.input('__list', sql.NVarChar(sql.MAX), json);

      const result = await query(
        request,
        buildSetStatement(operation, this.table, keys, predicate, this.options),
      );

      return result.recordsets ?? [];
    }, options);
  }

  /** Reads the key columns' types and collations from the catalog, once per set. */
  private async loadKeyColumns(ctx: CommandContext, options: QueryOptions): Promise<KeyColumn[]> {
    if (this.keyColumns) {
      return this.keyColumns;
    }

    const query = ctx.runner('set', options);
    const request = await ctx.request();
    const names = this.keys.map((key, n) => {
      request.input(`k${String(n)}`, sql.NVarChar(128), key);

      return `@k${String(n)}`;
    });

    request.input('table', sql.NVarChar(512), quoteIdentifier(this.table));

    const { recordset } = await query(
      request,
      `SELECT c.name, TYPE_NAME(c.system_type_id) AS type, c.precision, c.scale, c.collation_name AS collation
       FROM sys.columns AS c
       WHERE c.object_id = OBJECT_ID(@table) AND c.name IN (${names.join(', ')});`,
    );
    const found = new Map(
      (recordset as unknown as CatalogColumn[]).map((column) => [
        column.name.toLowerCase(),
        column,
      ]),
    );

    this.keyColumns = this.keys.map((key) => {
      const column = found.get(key.toLowerCase());

      if (!column) {
        throw new SqlClientError(`Key column "${key}" not found in ${this.table}`);
      }

      return toKeyColumn({ ...column, name: key });
    });

    return this.keyColumns;
  }
}
