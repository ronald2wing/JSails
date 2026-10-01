import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier/flat';

/**
 * Node's own globals as the repo tooling uses them. `ecmaVersion: latest`
 * already supplies the ECMAScript builtins; these are the host additions.
 */
const nodeGlobals = Object.fromEntries(
  [
    'process',
    'console',
    'Buffer',
    'URL',
    'URLSearchParams',
    'fetch',
    'AbortController',
    'AbortSignal',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    'clearImmediate',
    'queueMicrotask',
    'structuredClone',
    'TextEncoder',
    'TextDecoder',
    'performance',
  ].map((name) => [name, 'readonly']),
);

const unusedVarsOptions = {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
};

export default tseslint.config(
  {
    // ESLint does not read `.gitignore`, so generated and local trees are
    // listed here. `.claude/worktrees` holds whole checkouts of this repo.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/test-results/**',
      '**/.jsails/**',
      '.claude/**',
      '**/*.d.ts',
      'website/out/**',
      'website/public/**',
    ],
  },
  {
    // The repo tooling and the hand-written JS configs: plain ESM with no
    // type information, so only the core recommended rules apply.
    files: [
      'scripts/**/*.mjs',
      'website/scripts/**/*.mjs',
      'eslint.config.mjs',
      'jamal.config.js',
      'website/vite.config.js',
      'website/jsails.app.js',
    ],
    languageOptions: {
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', unusedVarsOptions],
    },
  },
  {
    // The starter verifier drives a real browser: the callbacks these modules
    // hand to Playwright's `page.evaluate` run in the page, where these
    // globals exist.
    files: ['scripts/verify-starter/browser.mjs', 'scripts/verify-starter/dev-server.mjs'],
    languageOptions: {
      globals: { document: 'readonly', window: 'readonly', getComputedStyle: 'readonly' },
    },
  },
  // The recommended type-checked rules (and the typescript-eslint parser they
  // rely on) are scoped to TypeScript/TSX sources, so plain-JS scripts and
  // configs are never parsed as TypeScript.
  //
  // recommendedTypeChecked runs the parser over the whole TypeScript program
  // (via `projectService`) so rules like no-floating-promises and
  // no-unnecessary-type-assertion have real type information instead of
  // guessing from syntax alone. Stylistic rules are intentionally NOT enabled:
  // Prettier owns formatting.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
    // Template TypeScript has no tsconfig in this project, so it is excluded
    // from the type-checked program and linted by the untyped block below.
    ignores: ['core/templates/**'],
  })),
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['core/templates/**'],
    languageOptions: {
      parserOptions: {
        // Type-aware linting: resolve each file's tsconfig through the TS
        // project service (offers lazy config discovery + watch mode support
        // over the legacy `project` globs).
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `let` bindings are read inside closures declared before the binding is
      // assigned (a controller may invoke an error/cleanup callback during
      // construction). Converting those to `const` turns an `undefined` read
      // into a TDZ ReferenceError, so the declare-at-top/assign-once idiom is
      // kept as `let`.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],

      // A leading `_` marks a deliberately-unused callback argument or local
      // binding (e.g. `(_url, _options) => {}`); honor that convention.
      '@typescript-eslint/no-unused-vars': ['error', unusedVarsOptions],

      // Server components and the Zod schema builders sit at generic inference
      // boundaries (`z.ZodObject<any>`, `ServerComponentAction<..., any>`) where
      // a precise structural type is impractical; `any` is deliberate there
      // and converting it is a type-contract refactor, not a lint cleanup.
      '@typescript-eslint/no-explicit-any': 'off',

      // The portable schema model types entity constructors as `Function`
      // (mirroring TypeORM's `EntityTarget`) and uses `{}` as the "no options"
      // default generic plus reserved empty options interfaces. Both are public
      // API contracts; replacing them changes accepted types.
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',

      // The deliberate `any` at the generic-inference boundaries above flows
      // straight through to these unsafe rules (Zod `.parse()` on
      // `ZodObject<any>`, `Object.getPrototypeOf` prototype guards,
      // `Object.create(null)` prototype-free maps). They re-flag the same `any`
      // that `no-explicit-any` documents as intentional, so enforcing them is
      // the same type-contract refactor the repo already declined.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // `async` is kept for interface conformance (the in-memory session store
      // and the resource/store fixtures implement promise-returning interfaces
      // with synchronous bodies) and for delegating to a promise-returning
      // function without an explicit `await`; neither is a defect.
      '@typescript-eslint/require-await': 'off',

      // A caught error is re-thrown verbatim after teardown and forwarded as a
      // rejection reason across the client runtime, preserving its stack trace,
      // subclass, and fields. Forcing an `Error` wrapper would lose that
      // fidelity, so `throw <unknown>` / `reject(<unknown>)` is intentional; the
      // rule's `allow*` options cannot express it (type narrowing turns the
      // forwarded `unknown` into `{}`).
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',

      // Callbacks (authorize/authenticate hooks, adapter methods, stdout
      // writers) are passed by reference and are plain functions/closures that
      // never rely on `this`; the one detached method is already re-bound via
      // `.call(adapter, ...)`.
      '@typescript-eslint/unbound-method': 'off',

      // `String()` is applied to control values (`JsonValue`) and an entity
      // label (`EntityTarget`) where object arms are out of contract; the
      // stringification is a deliberate coercion, not an accidental
      // `[object Object]` render.
      '@typescript-eslint/no-base-to-string': 'off',
    },
  },
  {
    // The docs site's browser bundle is a second program (`tsconfig.client.json`,
    // DOM + Vite) that the project service cannot discover by name, so its
    // files name their tsconfig explicitly.
    files: ['website/client/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['website/tsconfig.client.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // node:test's `test`/`it`/`describe` all return `Promise<void>` and are
    // invoked at module top level without awaiting by design; the rule cannot
    // tell those scheduler calls apart from genuinely un-awaited work inside a
    // test body, so it is disabled for tests only.
    files: ['core/test/**/*.{ts,tsx}', 'packages/**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  // Template TypeScript/TSX (both the plain compiled modules and the `.template`
  // scaffolds) is its own program: it imports `jsails`, `vite`,
  // `@playwright/test`, and Preact via `jsxImportSource: jsails`, and no
  // tsconfig in this project covers `core/templates/` (`core/tsconfig.json`
  // includes only `core/src/` and `core/test/`). Type-aware rules therefore have no
  // project to resolve against, so templates are linted with the UNTYPED
  // `recommended` preset — syntax and convention only, no type information.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: [
      'core/templates/**/*.ts',
      'core/templates/**/*.tsx',
      'core/templates/**/*.ts.template',
      'core/templates/**/*.tsx.template',
    ],
  })),
  {
    // `@typescript-eslint/parser` enables JSX by file extension (`.tsx`); the
    // `.tsx.template` scaffolds end in `.template`, so JSX must be turned on
    // explicitly for them or the parser rejects the JSX syntax.
    files: ['core/templates/**/*.tsx.template'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    // A leading `_` marks a deliberately-unused parameter in template code too
    // (`GET(_request, context)` in API handlers, `run(_input, ctx)` in CLI
    // commands), matching the repo-wide convention; the untyped preset's
    // `args: 'after-used'` default only recognizes that positionally.
    files: [
      'core/templates/**/*.ts',
      'core/templates/**/*.tsx',
      'core/templates/**/*.ts.template',
      'core/templates/**/*.tsx.template',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', unusedVarsOptions],
    },
  },
  {
    // Plain-JS templates (`.js`/`.mjs` scaffolds like `jsails.app.js.template`
    // and `scripts/*.mjs.template`) end in `.template`, so no glob above
    // matches them and ESLint otherwise reports "ignored because no matching
    // configuration was supplied" — silently unlinted. Lint them as
    // JavaScript (no type information is available or needed) with the same
    // `_`-prefix unused-parameter convention the TypeScript templates use.
    files: [
      'core/templates/**/*.js',
      'core/templates/**/*.mjs',
      'core/templates/**/*.js.template',
      'core/templates/**/*.mjs.template',
    ],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  // Prettier owns formatting; this disables every ESLint rule that would
  // otherwise conflict with (or merely duplicate) Prettier's output. It must
  // stay last so the stylistic rules above cannot be re-enabled.
  eslintConfigPrettier,
);
