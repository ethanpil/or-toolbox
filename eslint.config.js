import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Architecture rules from CLAUDE.md that are cheap to enforce mechanically.
 * `no-restricted-syntax` entries are ESLint selectors. tests/lint/ proves each
 * one fires.
 */
const HTML_SINK = /^(innerHTML|outerHTML)$/;
const htmlSinkMessage =
  'Never parse HTML strings into the page. Build DOM with h() from src/ui/dom.ts; render model Markdown with renderMarkdown().';
const noHtmlStrings = [
  {
    // el.innerHTML = …, el.outerHTML += …
    selector: `AssignmentExpression > MemberExpression.left[computed=false][property.name=${HTML_SINK}]`,
    message: htmlSinkMessage,
  },
  {
    // el['innerHTML'] = …
    selector: `AssignmentExpression > MemberExpression.left[computed=true][property.value=${HTML_SINK}]`,
    message: htmlSinkMessage,
  },
  {
    // Object.assign(el, { innerHTML: … }) and { 'innerHTML': … }
    selector: `CallExpression[callee.object.name='Object'][callee.property.name='assign'] > ObjectExpression > Property[key.name=${HTML_SINK}], CallExpression[callee.object.name='Object'][callee.property.name='assign'] > ObjectExpression > Property[key.value=${HTML_SINK}]`,
    message: htmlSinkMessage,
  },
  {
    // insertAdjacentHTML, setHTMLUnsafe, Document.parseHTMLUnsafe, Range#createContextualFragment
    selector:
      'CallExpression[callee.property.name=/^(insertAdjacentHTML|setHTMLUnsafe|parseHTMLUnsafe|createContextualFragment)$/]',
    message: htmlSinkMessage,
  },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^write(ln)?$/]",
    message: htmlSinkMessage,
  },
];

const storageMessage = 'Only src/core may touch browser storage (CLAUDE.md, architecture rule 1).';
const STORAGE = ['localStorage', 'sessionStorage', 'indexedDB'];
const storageGlobals = STORAGE.map((name) => ({ name, message: storageMessage }));
const storageProperties = ['window', 'globalThis', 'self', 'top', 'parent', 'frames'].flatMap(
  (object) => STORAGE.map((property) => ({ object, property, message: storageMessage })),
);

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
      'no-restricted-properties': ['error', ...storageProperties],
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
