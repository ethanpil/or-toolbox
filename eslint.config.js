import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Architecture rules from CLAUDE.md that are cheap to enforce mechanically.
 * `no-restricted-syntax` entries are plain ESLint selectors.
 */
const noHtmlStrings = [
  {
    selector:
      "AssignmentExpression[left.type='MemberExpression'][left.property.name=/^(innerHTML|outerHTML)$/]",
    message:
      'Never assign innerHTML/outerHTML. Build DOM with h() from src/ui/dom.ts; render model Markdown with renderMarkdown().',
  },
  {
    selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
    message: 'Never use insertAdjacentHTML. Build DOM with h() from src/ui/dom.ts.',
  },
];

const storageGlobals = ['localStorage', 'sessionStorage', 'indexedDB'].map((name) => ({
  name,
  message: 'Only src/core may touch browser storage (CLAUDE.md, architecture rule 1).',
}));

export default defineConfig(
  globalIgnores([
    'dist/',
    'coverage/',
    'test-results/',
    'playwright-report/',
    'blob-report/',
    'docs/',
    'tests/fixtures/',
  ]),

  // TypeScript everywhere, with type information.
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': ['error', ...noHtmlStrings],
    },
  },

  // Browser code outside src/core: no direct storage access.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/core/**', 'src/sw/**', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': ['error', ...storageGlobals],
      'no-restricted-properties': [
        'error',
        ...storageGlobals.flatMap(({ name, message }) => [
          { object: 'window', property: name, message },
          { object: 'globalThis', property: name, message },
        ]),
      ],
    },
  },

  // Plain JS: the theme bootstrap served as-is, and Node scripts.
  {
    files: ['public/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
  {
    files: ['*.js', 'scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },

  // Must stay last: turns off rules that would fight Prettier.
  prettier,
);
