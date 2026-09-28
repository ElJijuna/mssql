import { SqlClientError } from '../../src';
import { createClient, ddl } from './helpers';

const client = createClient();

interface User {
  id: number;
  email: string | null;
  tenantId: number;
  code: string;
}

beforeAll(async () => {
  await ddl(
    client,
    'DROP TABLE IF EXISTS dbo.it_set_users;',
    `CREATE TABLE dbo.it_set_users (
       id int PRIMARY KEY,
       email nvarchar(100) NULL,
       tenantId int NOT NULL,
       code varchar(10) NOT NULL
     );
     INSERT INTO dbo.it_set_users (id, email, tenantId, code) VALUES
       (1, 'ana@x.com', 1, 'A'), (2, 'bea@x.com', 1, 'B'), (3, 'cal@x.com', 1, 'C'),
       (4, NULL, 1, 'D'), (5, 'dan@x.com', 2, 'A');`,
  );
});

afterAll(async () => {
  await client.close();
});

const users = client.set<User>('dbo.it_set_users', {
  key: 'email',
  where: { tenantId: 1 },
  orderBy: 'id',
});
const incoming = [
  { email: 'ana@x.com', name: 'Ana' },
  { email: 'eva@x.com', name: 'Eva' },
  { email: 'bea@x.com', name: 'Bea' },
  { email: 'eva@x.com', name: 'Eva (duplicate)' },
  { email: null, name: 'No email' },
];

it('difference: rows in the table whose key is not in the list (NULL keys ignored)', async () => {
  await expect(users.difference(incoming)).resolves.toEqual([
    { id: 3, email: 'cal@x.com', tenantId: 1, code: 'C' },
  ]);
});

it('intersection: rows in the table whose key is in the list', async () => {
  const rows = await users.intersection(incoming);

  expect(rows.map((row) => row.id)).toEqual([1, 2]);
});

it('missing: your own items not in the table, first occurrence per key', async () => {
  await expect(users.missing(incoming)).resolves.toEqual([{ email: 'eva@x.com', name: 'Eva' }]);
});

it('symmetricDifference and union', async () => {
  const diff = await users.symmetricDifference(incoming);
  const union = await users.union(incoming);

  expect(diff.onlyInDb.map((row) => row.id)).toEqual([3]);
  expect(diff.onlyInList).toEqual([{ email: 'eva@x.com', name: 'Eva' }]);
  expect(union.inDb.map((row) => row.id)).toEqual([1, 2, 3]);
  expect(union.onlyInList).toEqual([{ email: 'eva@x.com', name: 'Eva' }]);
});

it('subset / superset / disjoint', async () => {
  const all = ['ana@x.com', 'bea@x.com', 'cal@x.com'];

  await expect(users.isSubsetOf(all)).resolves.toBe(true);
  await expect(users.isSubsetOf(['ana@x.com'])).resolves.toBe(false);
  await expect(users.isSupersetOf(['ana@x.com', 'cal@x.com'])).resolves.toBe(true);
  await expect(users.isSupersetOf(['ana@x.com', 'zoe@x.com'])).resolves.toBe(false);
  await expect(users.isDisjointFrom(['zoe@x.com', 'dan@x.com'])).resolves.toBe(true);
  await expect(users.isDisjointFrom(['zoe@x.com', 'bea@x.com'])).resolves.toBe(false);
});

it('empty list', async () => {
  await expect(users.difference([])).resolves.toHaveLength(3);
  await expect(users.missing([])).resolves.toEqual([]);
  await expect(users.isSupersetOf([])).resolves.toBe(true);
});

it('follows the column collation by default and can compare exactly', async () => {
  await expect(users.missing(['ANA@X.COM'])).resolves.toEqual([]);

  const exact = client.set('dbo.it_set_users', {
    key: 'email',
    where: { tenantId: 1 },
    caseSensitive: true,
  });

  await expect(exact.missing(['ANA@X.COM', 'ana@x.com'])).resolves.toEqual(['ANA@X.COM']);
});

it('supports numeric and composite keys and varchar columns', async () => {
  const byId = client.set('dbo.it_set_users', { key: 'id', columns: ['id'] });

  await expect(byId.missing([1, 5, 42])).resolves.toEqual([42]);

  const byTenantCode = client.set('dbo.it_set_users', {
    key: ['tenantId', 'code'],
    columns: ['id'],
    orderBy: 'id',
  });
  const pairs = [
    { tenantId: 1, code: 'A' },
    { tenantId: 2, code: 'A' },
    { tenantId: 2, code: 'Z' },
  ];

  await expect(byTenantCode.intersection(pairs)).resolves.toEqual([{ id: 1 }, { id: 5 }]);
  await expect(byTenantCode.missing(pairs)).resolves.toEqual([{ tenantId: 2, code: 'Z' }]);
});

it('handles lists far beyond the 2100-parameter limit', async () => {
  const many = Array.from({ length: 20_000 }, (_, i) => `user${String(i)}@x.com`).concat(
    'bea@x.com',
  );

  await expect(users.intersection(many)).resolves.toEqual([expect.objectContaining({ id: 2 })]);
  await expect(users.missing(many)).resolves.toHaveLength(20_000);
});

it('works inside a transaction', async () => {
  const missing = await client.transaction(async (tx) =>
    tx.set('dbo.it_set_users', { key: 'email' }).missing(['ana@x.com', 'new@x.com']),
  );

  expect(missing).toEqual(['new@x.com']);
});

it('reports unknown key columns and invalid items', async () => {
  await expect(client.set('dbo.it_set_users', { key: 'nope' }).missing(['x'])).rejects.toThrow(
    'Key column "nope" not found in dbo.it_set_users',
  );
  await expect(
    client.set('dbo.it_set_users', { key: ['tenantId', 'code'] }).missing(['x']),
  ).rejects.toThrow(SqlClientError);
});
