import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: { allowDefaultProject: ['*.js', '*.ts'] }, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // No float math on money: ban the usual escape hatches outright.
      'no-restricted-globals': ['error', { name: 'parseFloat', message: 'No float math on money. Use bigint minor units.' }],
      'no-restricted-properties': [
        'error',
        { object: 'Number', property: 'parseFloat', message: 'No float math on money. Use bigint minor units.' },
        { property: 'toFixed', message: 'No float formatting on money. Use fromMinorUnits().' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    files: ['**/test/**'],
    rules: { '@typescript-eslint/no-unsafe-member-access': 'off', '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
  { files: ['*.config.js', '*.config.ts'], extends: [tseslint.configs.disableTypeChecked] },
);
