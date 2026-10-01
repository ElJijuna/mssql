import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqlQueryCatalog } from './SqlQueryCatalog';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sql-catalog-'));
  await mkdir(join(dir, 'src/users'), { recursive: true });
  await writeFile(join(dir, 'src/users/find.sql'), '\uFEFFSELECT @id AS id; -- @ignored');
  await writeFile(join(dir, 'src/list.sql'), 'SELECT 1;');
  await writeFile(join(dir, 'ignored.txt'), 'not SQL');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SqlQueryCatalog', () => {
  it('discovers root and nested files with names relative to the directory', async () => {
    const catalog = await SqlQueryCatalog.load({
      dir: pathToFileURL(`${dir}/`),
      pattern: 'src/**/*.sql',
    });

    expect(catalog.names()).toEqual(['src/list', 'src/users/find']);
    expect(catalog.has('src/users/find')).toBe(true);
    expect(catalog.has('missing')).toBe(false);
    expect(catalog.get('src/users/find')).toEqual({
      name: 'src/users/find',
      path: join(dir, 'src/users/find.sql'),
      text: 'SELECT @id AS id; -- @ignored',
      parameters: ['id'],
    });
  });

  it('supports default patterns and overlapping patterns without duplicates', async () => {
    expect((await SqlQueryCatalog.load({ dir })).names()).toHaveLength(2);
    expect(
      (
        await SqlQueryCatalog.load({ dir, pattern: ['src/**/*.sql', 'src/users/f?nd.sql'] })
      ).names(),
    ).toHaveLength(2);
  });

  it('distinguishes shallow and recursive discovery', async () => {
    expect((await SqlQueryCatalog.load({ dir, pattern: 'src/*.sql' })).names()).toEqual([
      'src/list',
    ]);
  });

  it('supports custom extensions and rejects name collisions', async () => {
    await writeFile(join(dir, 'src/list.tsql'), 'SELECT 2;');

    expect((await SqlQueryCatalog.load({ dir, pattern: '**/*.tsql' })).names()).toEqual([
      'src/list',
    ]);
    await expect(SqlQueryCatalog.load({ dir, pattern: ['**/*.sql', '**/*.tsql'] })).rejects.toThrow(
      'Duplicate SQL query name',
    );
  });

  it.each([
    '../*.sql',
    '/tmp/*.sql',
    'src/{a,b}.sql',
    'src/**x.sql',
    'src/!*.sql',
    'src\\*.sql',
    '',
  ])('rejects invalid pattern %p', async (pattern) => {
    await expect(SqlQueryCatalog.load({ dir, pattern })).rejects.toThrow();
  });

  it('rejects empty matches and patterns', async () => {
    await expect(SqlQueryCatalog.load({ dir, pattern: '*.sql' })).rejects.toThrow(
      'matched no files',
    );
    await expect(SqlQueryCatalog.load({ dir, pattern: [] })).rejects.toThrow(
      'at least one pattern',
    );
  });

  it('validates SQL at startup', async () => {
    await writeFile(join(dir, 'bad.sql'), 'SELECT 1;\nGO\nSELECT 2;');

    await expect(SqlQueryCatalog.load({ dir })).rejects.toThrow('GO');
    await writeFile(join(dir, 'bad.sql'), '   ');
    await expect(SqlQueryCatalog.load({ dir })).rejects.toThrow('non-empty');
  });

  it('keeps a snapshot and protects introspection from mutation', async () => {
    const catalog = await SqlQueryCatalog.load({ dir });

    await writeFile(join(dir, 'src/users/find.sql'), 'SELECT @changed;');
    catalog.get('src/users/find').parameters.push('oops');
    catalog.loadQuery('src/users/find').analysis.required.push('oops');

    expect(catalog.get('src/users/find').parameters).toEqual(['id']);
    expect(catalog.get('src/users/find').text).toContain('@id');
  });

  it('skips symlink files, directories and literal prefixes', async () => {
    await symlink(join(dir, 'src/users'), join(dir, 'linked'));
    await symlink(join(dir, 'src/list.sql'), join(dir, 'linked.sql'));

    expect((await SqlQueryCatalog.load({ dir })).names()).toHaveLength(2);
    await expect(SqlQueryCatalog.load({ dir, pattern: 'linked/*.sql' })).rejects.toThrow(
      'matched no files',
    );
  });

  it('wraps filesystem failures with their cause', async () => {
    await expect(SqlQueryCatalog.load({ dir: join(dir, 'missing') })).rejects.toMatchObject({
      code: 'SQL_CLIENT_ERROR',
    });
    await expect(SqlQueryCatalog.load({ dir: join(dir, 'missing') })).rejects.toHaveProperty(
      'cause.code',
      'ENOENT',
    );
  });

  it('registers bundled queries and excludes declared variables', () => {
    const catalog = SqlQueryCatalog.fromQueries({
      'users/byId': 'DECLARE @local int; SELECT @id, @local;',
      all: '\uFEFFSELECT 1;',
    });

    expect(catalog.names()).toEqual(['all', 'users/byId']);
    expect(catalog.get('users/byId').parameters).toEqual(['id']);
    expect(catalog.get('all').path).toBeNull();
    expect(() => catalog.get('unknown')).toThrow('Unknown SQL query');
  });

  it.each(['', '../bad', '/bad', 'a//b', 'a\\b'])('rejects invalid name %p', (name) => {
    expect(() => SqlQueryCatalog.fromQueries({ [name]: 'SELECT 1;' })).toThrow(
      'Invalid SQL query name',
    );
  });

  it('rejects empty catalogs, empty text and batch separators', () => {
    expect(() => SqlQueryCatalog.fromQueries({})).toThrow();
    expect(() => SqlQueryCatalog.fromQueries({ bad: '' })).toThrow();
    expect(() => SqlQueryCatalog.fromQueries({ bad: 'SELECT 1;\nGO' })).toThrow();
  });
});
