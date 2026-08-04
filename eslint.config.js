import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: { curly: ['error', 'all'] },
  },
  { files: ['**/*.js', '**/*.config.ts'], extends: [tseslint.configs.disableTypeChecked] },
  { files: ['test/**/*.ts'], extends: [tseslint.configs.disableTypeChecked] },
  { ignores: ['dist/', 'coverage/', 'docs/'] },
);
