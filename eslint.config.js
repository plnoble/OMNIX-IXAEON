// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '**/release/**',
      'packages/test-fixtures/fixtures/**',
      '**/*.d.ts',
    ],
  },
  {
    files: ['**/*.{ts,tsx,mjs}'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'off',
    },
  },
  {
    // Electron 渲染进程不支持 window.prompt，调用直接抛错，按钮等于失效。
    // 9-07 修过一次（ea7c721），D6 又带回来（9-17 用户实测「改名」无反应），故上升为规则。
    // 需要输入时用页面内的输入框。
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'prompt',
          message: 'Electron 不支持 window.prompt（调用即抛错），请用页面内输入框。',
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'prompt', message: 'Electron 不支持 prompt（调用即抛错），请用页面内输入框。' },
      ],
    },
  },
);
