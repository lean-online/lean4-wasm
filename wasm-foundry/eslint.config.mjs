import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'work/**',
      'public/**',
      'coverage/**',
      'scripts/assets/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'scripts/**/*.ts',
      'scripts/**/*.mjs',
      'npm/**/*.mjs',
      'vitest.config.ts',
      'eslint.config.mjs',
    ],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['scripts/depth-probe/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.worker } },
  },
);
