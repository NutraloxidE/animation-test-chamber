import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'generated/**',
      'schemas/**',
      'presets/**',
      'reports/**',
      '.chamber-fake-git/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Buffer: 'readonly',
        HTMLElement: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        Gamepad: 'readonly',
        File: 'readonly',
        btoa: 'readonly',
        structuredClone: 'readonly',
        __dirname: 'readonly',
        React: 'readonly',
      },
    },
    rules: {
      // Unused values are usually a sign something was half-removed. Warn, but
      // allow the leading-underscore convention for deliberate placeholders.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // Empty catch blocks are used deliberately where a failure must not
      // interrupt playback; they carry a comment explaining why.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
    },
  },
];
