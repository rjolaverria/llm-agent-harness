import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      curly: ['error', 'all'],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  { files: ['**/*.js', '**/*.config.ts'], extends: [tseslint.configs.disableTypeChecked] },
  { files: ['test/**/*.ts'], extends: [tseslint.configs.disableTypeChecked] },
  // Type-checked separately via `tsc -p tsconfig.examples.json` (README snippet
  // verification); not part of the root tsconfig's project service.
  { files: ['examples/**/*.ts'], extends: [tseslint.configs.disableTypeChecked] },
  { ignores: ['dist/', 'coverage/', 'docs/'] },
);
