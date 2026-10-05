// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.claude/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/*.d.ts',
      'docs/design/**',
      'docs/brand/**',
      'fixtures/data/**',
      'apps/desktop/demo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'vitest.config.ts',
            'packages/*/vitest.config.ts',
            'apps/*/vitest.config.ts',
            'tools/vitest.config.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: [
      'apps/desktop/src/renderer/**/*.{ts,tsx}',
      'packages/{engine,pointcloud,maps,video,annotate,ui,volumetric}/src/**/*.{ts,tsx}',
    ],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'node:*'],
              message: 'Renderer code must not import Electron or Node. Use window.aio IPC.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/e2e/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  prettier,
);
