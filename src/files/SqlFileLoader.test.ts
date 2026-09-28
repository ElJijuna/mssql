import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqlClientError } from '../errors/SqlClientError';
import { SqlFileLoader } from './SqlFileLoader';

describe('SqlFileLoader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pilmee-mssql-'));
    await mkdir(join(dir, 'users'));
    await writeFile(
      join(dir, 'users', 'get-by-tenant.sql'),
      '﻿SELECT * FROM dbo.Users WHERE tenantId = @tenantId;',
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads and analyzes a file relative to the base directory, stripping the BOM', async () => {
    const file = await new SqlFileLoader(dir, true).load('users/get-by-tenant.sql');

    expect(file).toMatchObject({
      name: 'users/get-by-tenant.sql',
      path: join(dir, 'users', 'get-by-tenant.sql'),
      text: 'SELECT * FROM dbo.Users WHERE tenantId = @tenantId;',
    });
    expect(file.analysis.required).toEqual(['tenantId']);
  });

  it('accepts a file URL as base directory and adds the .sql extension', async () => {
    const loader = new SqlFileLoader(pathToFileURL(`${dir}/`), true);

    await expect(loader.load('users/get-by-tenant')).resolves.toMatchObject({
      name: 'users/get-by-tenant.sql',
    });
  });

  it('caches files unless caching is off', async () => {
    const path = join(dir, 'users', 'get-by-tenant.sql');
    const cached = new SqlFileLoader(dir, true);
    const uncached = new SqlFileLoader(dir, false);

    await cached.load('users/get-by-tenant');
    await uncached.load('users/get-by-tenant');
    await writeFile(path, 'SELECT 2;');

    await expect(cached.load('users/get-by-tenant')).resolves.toMatchObject({
      text: expect.stringContaining('@tenantId') as string,
    });
    await expect(uncached.load('users/get-by-tenant')).resolves.toMatchObject({
      text: 'SELECT 2;',
    });
  });

  it('rejects paths outside the base directory', () => {
    expect(() => new SqlFileLoader(dir, true).resolve('../secrets.sql')).toThrow(SqlClientError);
    expect(() => new SqlFileLoader(dir, true).resolve('/etc/passwd')).toThrow(SqlClientError);
  });

  it('reports missing files clearly and does not cache the failure', async () => {
    const loader = new SqlFileLoader(dir, true);

    await expect(loader.load('users/nope')).rejects.toThrow('SQL file "users/nope.sql" not found');

    await writeFile(join(dir, 'users', 'nope.sql'), 'SELECT 1;');
    await expect(loader.load('users/nope')).resolves.toMatchObject({ text: 'SELECT 1;' });
  });

  it('rejects files with GO batch separators', async () => {
    await writeFile(join(dir, 'script.sql'), 'SELECT 1\nGO\nSELECT 2');

    await expect(new SqlFileLoader(dir, true).load('script')).rejects.toThrow(
      'contains GO batch separators',
    );
  });
});
