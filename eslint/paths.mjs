/**
 * Portable path handling in core (`core/src`), so path code behaves the same
 * on POSIX and Windows (KRN-02; Windows is supported for development).
 *
 * `core/src/support/project-paths.server.ts` is the one module that turns a
 * filesystem path into a module id or an import URL. Outside it:
 *
 * - `jsails/no-raw-dynamic-import`: `import()` takes only a string literal.
 *   A computed argument is a filesystem path or a specifier, and a path handed
 *   to `import()` fails on Windows (`C:\...` is read as a URL scheme) and on
 *   any platform when it contains `#`, `?`, or `%`. Use `importFile(path)` or
 *   `importModule(specifier)`.
 * - `jsails/no-separator-conversion`: no hand-written separator handling:
 *   `.split(sep)`, a comparison against `sep`, a backslash turned into `/`
 *   (`.replace(/\\/g, '/')`, `.replaceAll('\\', '/')`, `.split('\\')`) on any
 *   value, or `.split('/')` and a `.replace(..., '/')` applied directly to a
 *   `relative`/`join`/`resolve`/`normalize`/`dirname` result. A platform path
 *   is `\`-separated on Windows, and on POSIX a `\` is a legal file-name
 *   character that a blanket replace corrupts; `toPosixId(path)` converts by
 *   the platform's own separator. The two-step form (a path call stored in a
 *   variable, then `.split('/')` on it) is beyond a syntax selector.
 *
 * Packages are not covered, because the module is internal to core. Known
 * hand-written conversions there: `packages/filesystem/src/local-disk.ts`
 * (`.split(sep)`) and `packages/content/src/discovery.ts` (a backslash
 * replace); they move to a shared path module once one is public.
 */

const CORE_SOURCE = ['core/src/**/*.{ts,tsx}'];
const PATH_MODULE = ['core/src/support/project-paths.server.ts'];

/** The `node:path` functions whose result uses the platform separator. */
const PATH_CALL = '/^(relative|join|resolve|normalize|dirname)$/';

/** A first argument that is a lone backslash, as a string or as a regex. */
const BACKSLASH_ARGUMENT = String.raw`:matches([arguments.0.value='\\'], [arguments.0.regex.pattern='\\\\'])`;

/** `relative(...)` or `path.relative(...)` and the other platform-path calls. */
const ON_PATH_CALL = `:matches([callee.object.callee.name=${PATH_CALL}], [callee.object.callee.property.name=${PATH_CALL}])`;

export const restrictedSyntax = [
  {
    name: 'no-raw-dynamic-import',
    files: CORE_SOURCE,
    ignores: PATH_MODULE,
    selector:
      "ImportExpression:not([source.type='Literal']):not([source.type='TemplateLiteral'][source.expressions.length=0])",
    message:
      'import() takes a URL or a specifier, not a path: use importFile(path) or importModule(specifier) from core/src/support/project-paths.server.ts.',
  },
  {
    name: 'no-separator-conversion',
    files: CORE_SOURCE,
    ignores: PATH_MODULE,
    selector: [
      "CallExpression[callee.property.name='split'][arguments.0.name='sep']",
      "CallExpression[callee.property.name='split'][arguments.0.property.name='sep']",
      "BinaryExpression:matches([left.name='sep'], [right.name='sep'], [left.property.name='sep'], [right.property.name='sep'])",
      `CallExpression[callee.property.name='split'][arguments.0.value='/']${ON_PATH_CALL}`,
      `CallExpression[callee.property.name=/^replace(All)?$/][arguments.1.value='/']${ON_PATH_CALL}`,
      `CallExpression[callee.property.name=/^replace(All)?$/][arguments.1.value='/']${BACKSLASH_ARGUMENT}`,
      `CallExpression[callee.property.name='split']${BACKSLASH_ARGUMENT}`,
    ].join(', '),
    message:
      'A platform path uses \\ on Windows: convert it with toPosixId(path) from core/src/support/project-paths.server.ts instead of handling separators by hand.',
  },
];

export default [];
