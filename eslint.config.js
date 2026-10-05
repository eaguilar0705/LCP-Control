import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      '.tools',
      'private-data',
      'output',
      'tmp',
      'playwright-report',
      'test-results',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ['*.js', 'scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['frontend/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/backend/**', '@lcp/backend', '@lcp/backend/*'],
              message:
                'El frontend sólo consume contratos y la API de Supabase.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/frontend/**',
                '**/backend/**',
                '@lcp/frontend',
                '@lcp/frontend/*',
                '@lcp/backend',
                '@lcp/backend/*',
                'react',
                'react/*',
                'react-dom',
                'react-dom/*',
                '@supabase/supabase-js',
              ],
              message:
                'Los contratos compartidos no dependen de la interfaz ni del backend.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['backend/**/*.{js,mjs,ts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/frontend/**', '@lcp/frontend', '@lcp/frontend/*'],
              message: 'El backend no importa código del navegador.',
            },
          ],
        },
      ],
    },
  },
)
