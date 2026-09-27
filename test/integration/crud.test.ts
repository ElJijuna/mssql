import { SqlClientError, t } from '../../src';
import { count, createClient, ddl } from './helpers';

const client = createClient();

interface User {
  id: number;
  email: string;
  name: string | null;
  role: string;
  deletedAt: Date | null;
}

beforeAll(async () => {
  await ddl(
    client,
    'DROP TABLE IF EXISTS dbo.it_crud_audit; DROP TABLE IF EXISTS dbo.it_crud_users;',
    `CREATE TABLE dbo.it_crud_users (
       id int IDENTITY(1, 1) PRIMARY KEY,
       email nvarchar(100) NOT NULL UNIQUE,
       name nvarchar(100) NULL,
       role nvarchar(20) NOT NULL DEFAULT 'member',
       deletedAt datetime2(3) NULL
     );`,
    'CREATE TABLE dbo.it_crud_audit (id int IDENTITY(1000, 1) PRIMARY KEY, userId int NOT NULL);',
    // A trigger that inserts into another identity table: @@IDENTITY would return the audit id.
    `CREATE TRIGGER dbo.it_crud_users_audit ON dbo.it_crud_users AFTER INSERT AS
       INSERT INTO dbo.it_crud_audit (userId) SELECT id FROM inserted;`,
  );
});

beforeEach(async () => {
  await ddl(client, 'DELETE FROM dbo.it_crud_audit; DELETE FROM dbo.it_crud_users;');
});

afterAll(async () => {
  await client.close();
});

describe('insert', () => {
  it('returns the identity of the inserted row even with a trigger inserting elsewhere', async () => {
    const id = await client.insert('dbo.it_crud_users', {
      email: 'ana@example.com',
      name: t.nvarchar("Ana O'Brien", 100),
    });
    const user = await client.findOne<User>('dbo.it_crud_users', { id });

    expect(user).toMatchObject({ email: 'ana@example.com', name: "Ana O'Brien", role: 'member' });
    expect(await count(client, 'dbo.it_crud_audit')).toBe(1);
  });

  it('returns null for a table without identity', async () => {
    await ddl(
      client,
      'DROP TABLE IF EXISTS dbo.it_crud_tags; CREATE TABLE dbo.it_crud_tags (name nvarchar(20) PRIMARY KEY);',
    );

    await expect(client.insert('dbo.it_crud_tags', { name: 'sql' })).resolves.toBeNull();
  });
});

describe('select / findOne / update / delete', () => {
  beforeEach(async () => {
    await client.insertMany('dbo.it_crud_users', [
      { email: 'a@x.com', name: 'Ana', role: 'admin' },
      { email: 'b@x.com', name: 'Bea', role: 'editor' },
      {
        email: 'c@x.com',
        name: 'Cal',
        role: 'member',
        deletedAt: new Date('2026-01-01T00:00:00Z'),
      },
      { email: 'd@x.com', name: null, role: 'member' },
    ]);
  });

  it('filters with IN and IS NULL, orders and pages', async () => {
    const active = await client.select<User>(
      'dbo.it_crud_users',
      { role: ['admin', 'member'], deletedAt: null },
      { columns: ['email', 'role'], orderBy: { email: 'desc' } },
    );

    expect(active).toEqual([
      { email: 'd@x.com', role: 'member' },
      { email: 'a@x.com', role: 'admin' },
    ]);

    const page = await client.select<User>(
      'dbo.it_crud_users',
      {},
      { orderBy: 'email', limit: 2, offset: 1 },
    );

    expect(page.map((user) => user.email)).toEqual(['b@x.com', 'c@x.com']);
    expect(await client.select('dbo.it_crud_users', {}, { limit: 3 })).toHaveLength(3);
  });

  it('matches arrays with null and empty arrays', async () => {
    await expect(client.select('dbo.it_crud_users', { name: ['Ana', null] })).resolves.toHaveLength(
      2,
    );
    await expect(client.select('dbo.it_crud_users', { id: [] })).resolves.toEqual([]);
  });

  it('finds one row or null', async () => {
    await expect(
      client.findOne<User>('dbo.it_crud_users', { role: 'member' }, { orderBy: { email: 'desc' } }),
    ).resolves.toMatchObject({
      email: 'd@x.com',
    });
    await expect(
      client.findOne('dbo.it_crud_users', { email: 'nobody@x.com' }),
    ).resolves.toBeNull();
  });

  it('updates and deletes the matching rows only', async () => {
    await expect(
      client.update('dbo.it_crud_users', { role: 'guest' }, { role: 'member', deletedAt: null }),
    ).resolves.toBe(1);
    await expect(
      client.delete('dbo.it_crud_users', { email: ['a@x.com', 'b@x.com'] }),
    ).resolves.toBe(2);
    await expect(
      client.select('dbo.it_crud_users', {}, { columns: ['email', 'role'], orderBy: 'email' }),
    ).resolves.toEqual([
      { email: 'c@x.com', role: 'member' },
      { email: 'd@x.com', role: 'guest' },
    ]);
  });

  it('refuses to update or delete without where', async () => {
    await expect(client.delete('dbo.it_crud_users', {})).rejects.toThrow(SqlClientError);
    expect(await count(client, 'dbo.it_crud_users')).toBe(4);
  });
});
