// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const RENDERER_ONLY = {
  group: ['electron', 'node:*'],
  message: 'Renderer code must not import Electron or Node. Use window.aio IPC.',
};

/** CesiumJS exports that reach an online service (packages/globe/src/offline.ts). */
const BANNED_CESIUM_IMPORTS = [
  'Ion',
  'IonResource',
  'IonImageryProvider',
  'IonGeocoderService',
  'createWorldImageryAsync',
  'createWorldTerrainAsync',
  'createOsmBuildingsAsync',
  'createGooglePhotorealistic3DTileset',
  'BingMapsImageryProvider',
  'BingMapsGeocoderService',
  'GoogleEarthEnterpriseImageryProvider',
  'GoogleEarthEnterpriseTerrainProvider',
  'GoogleEarthEnterpriseMetadata',
  'GoogleMaps',
  'GoogleGeocoderService',
  'ITwinData',
  'ITwinPlatform',
  'ArcGisMapServerImageryProvider',
  'ArcGisMapService',
  'MapboxImageryProvider',
  'MapboxStyleImageryProvider',
];

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
      'packages/{engine,pointcloud,maps,video,annotate,ui,volumetric,change,modelling,collab,globe,tiles,survey}/src/**/*.{ts,tsx}',
    ],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': ['error', { patterns: [RENDERER_ONLY] }],
    },
  },
  {
    // M10 decision 3: the Globe stays offline. No Cesium ion, Bing, Google, Esri or Mapbox
    // provider, and never the widgets (Knockout needs 'unsafe-eval'). The names are the ones of
    // packages/globe/src/offline.ts (its test checks this list holds every one).
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}', 'packages/{globe,tiles}/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [RENDERER_ONLY],
          paths: [
            ...['cesium', '@cesium/widgets'].map((name) => ({
              name,
              message: 'Use @cesium/engine and @cesium/core only (no widgets, no eval).',
            })),
            ...['@cesium/engine', '@cesium/core'].map((name) => ({
              name,
              importNames: BANNED_CESIUM_IMPORTS,
              message: 'The Globe is offline: no ion, Bing, Google, Esri or Mapbox provider.',
            })),
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
