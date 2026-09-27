import eslintJest from 'super-configs/eslint/jest';
import eslintTs from 'super-configs/eslint/ts';

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'docs/**', 'node_modules/**'],
  },
  ...eslintTs,
  ...eslintJest,
];
