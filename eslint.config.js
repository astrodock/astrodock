// Minimal lint, aimed at one class of bug: code that parses but cannot run.
//
// A bulk edit once turned `onClick={e => e.stopPropagation()}` into
// `onClick={e = noValidate}` in seven modals. That is valid JSX — an assignment
// to an undefined variable — so the build passed and every "add" dialog in the
// product threw ReferenceError at the moment someone clicked it. It shipped.
//
// This is deliberately not a style config. no-undef is the rule that would have
// caught it, and the rest is there to catch the same shape of mistake rather
// than to have opinions about formatting.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'apps/admin/design/**', 'docs/**']
  },

  // Browser code: the admin SPA.
  {
    files: ['apps/admin/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      // Off for JSX: without the React plugin, ESLint does not count `<Foo/>` as
      // using `Foo`, so every imported component is reported. The noise would
      // bury the one rule that matters here.
      'no-unused-vars': 'off',
      'no-unused-labels': 'error',
      'no-cond-assign': ['error', 'always'],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },

  // Node code: control plane, runner, CLI, scripts.
  {
    files: ['apps/control-plane/**/*.js', 'packages/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },

  // Tests are ESM with node globals.
  {
    files: ['**/test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: { ...js.configs.recommended.rules, 'no-undef': 'error', 'no-unused-vars': 'off' }
  }
];
