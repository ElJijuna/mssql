import { SqlClientError } from '../errors/SqlClientError';
import { quoteIdentifier } from '../utils/quoteIdentifier';
import { analyzeSql } from './analyze';
import type { SqlParams } from './bindNamed';

/**
 * A piece of SQL built with {@link tsql}: text plus the values to send as parameters. Fragments can
 * be nested inside other fragments.
 */
export class SqlFragment {
  /**
   * @internal
   */
  public constructor(
    public readonly strings: readonly string[],
    public readonly values: readonly unknown[],
  ) {}
}

/**
 * A table/column name inserted with `tsql.id(name)`; bracket-quoted, never a parameter.
 */
export class SqlIdentifier {
  /**
   * @internal
   */
  public constructor(public readonly name: string) {}
}

/**
 * Text inserted as-is with `tsql.raw(text)`.
 */
export class SqlRaw {
  /**
   * @internal
   */
  public constructor(public readonly text: string) {}
}

const join = (items: readonly unknown[], separator: string): SqlFragment =>
  new SqlFragment(
    items.length === 0 ? [''] : ['', ...items.slice(1).map(() => separator), ''],
    items,
  );

/**
 * Tagged template for SQL. Every `${value}` becomes a real parameter (`@p0`, `@p1`…), so values are
 * never pasted into the SQL. Arrays expand for `IN (${ids})`, {@link t} builders set the type, and
 * nested `tsql` fragments are inlined, which lets you build dynamic SQL safely.
 *
 * @example
 * ```ts
 * const onlyActive = includeInactive ? tsql`` : tsql`AND active = 1`;
 *
 * await client.query(
 *   tsql`SELECT * FROM ${tsql.id('dbo.Users')} WHERE tenantId = ${tenantId} ${onlyActive}`,
 *   { timeout: 5_000 },
 * );
 * ```
 */
export const tsql = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]): SqlFragment =>
    new SqlFragment([...strings], values),
  {
    /**
     * A table or column name, bracket-quoted (`dbo.Users` → `[dbo].[Users]`). Use it for names
     * that come from variables; values still go in `${…}` directly.
     */
    id: (name: string): SqlIdentifier => new SqlIdentifier(name),
    /**
     * Text inserted as-is. **Never pass user input**: it is not escaped. Meant for trusted
     * keywords such as a sort direction you picked from a fixed list.
     */
    raw: (text: string): SqlRaw => new SqlRaw(text),
    /**
     * Joins values or fragments with a separator (`, ` by default).
     *
     * @example
     * ```ts
     * const columns = tsql.join(['id', 'name'].map(tsql.id));
     * await client.query`SELECT ${columns} FROM dbo.Users`;
     * ```
     */
    join: (items: readonly unknown[], separator = ', '): SqlFragment => join(items, separator),
  },
);

/**
 * Whether `value` is the first argument of a tagged template call.
 *
 * @internal
 */
export const isTemplateStringsArray = (value: unknown): value is TemplateStringsArray =>
  Array.isArray(value) && 'raw' in value;

/**
 * Turns a fragment into SQL text with `@p0`, `@p1`… and their parameters. Throws when a value
 * landed inside a string literal or comment, where it would silently be sent as text.
 *
 * @internal
 */
export const compileFragment = (fragment: SqlFragment): { text: string; params: SqlParams } => {
  const params: SqlParams = {};

  let next = 0;

  const render = (current: SqlFragment): string =>
    current.strings.reduce((text, chunk, index) => {
      if (index === 0) {
        return chunk;
      }

      const value = current.values[index - 1];

      if (value instanceof SqlFragment) {
        return text + render(value) + chunk;
      }

      if (value instanceof SqlIdentifier) {
        return text + quoteIdentifier(value.name) + chunk;
      }

      if (value instanceof SqlRaw) {
        return text + value.text + chunk;
      }

      const name = `p${next++}`;

      params[name] = value;

      return `${text}@${name}${chunk}`;
    }, '');
  const text = render(fragment);
  const used = new Set(
    analyzeSql(text).references.map((reference) => reference.name.toLowerCase()),
  );
  const lost = Object.keys(params).filter((name) => !used.has(name));

  if (lost.length > 0) {
    throw new SqlClientError(
      `Template value(s) ${lost.map((name) => `@${name}`).join(', ')} ended up inside a string literal or comment. ` +
        "Remove the quotes around ${…}: values are sent as parameters (e.g. WHERE name = ${name}, not '${name}').",
    );
  }

  return { text, params };
};
