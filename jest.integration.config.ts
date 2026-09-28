import type { Config } from 'jest';

/**
 * Integration tests against a real SQL Server (see compose.yaml).
 * Run with `npm run db:up && npm run test:integration`.
 */
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/integration/**/*.test.ts'],
  globalSetup: '<rootDir>/test/integration/globalSetup.ts',
  testTimeout: 30_000,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
};

export default config;
