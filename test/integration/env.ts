import type sql from 'mssql';

/**
 * Connection settings for the integration database. Defaults match compose.yaml; override them
 * with MSSQL_HOST, MSSQL_PORT, MSSQL_USER, MSSQL_PASSWORD and MSSQL_DATABASE.
 */
export const env = {
  host: process.env.MSSQL_HOST ?? 'localhost',
  port: Number(process.env.MSSQL_PORT ?? 14330),
  user: process.env.MSSQL_USER ?? 'sa',
  password: process.env.MSSQL_PASSWORD ?? 'Pilmee_Test_2026!',
  database: process.env.MSSQL_DATABASE ?? 'pilmee_mssql_test',
};

export const connectionConfig = (database = env.database): sql.config => ({
  server: env.host,
  port: env.port,
  user: env.user,
  password: env.password,
  database,
  options: { encrypt: false, trustServerCertificate: true },
  pool: { max: 10 },
});
