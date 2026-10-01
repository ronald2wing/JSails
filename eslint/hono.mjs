/**
 * Hono is the request cluster's implementation detail.
 *
 * Every route reaches the app through the registrar (`routes.add`, a
 * `RouteContext` handler, `Respond`): no plugin receives the Hono app, so a
 * route cannot step around the access chain with `app.use`, a sub-app or a
 * raw handler. `jsails/no-hono-import` bans `hono` (and every `hono/*`
 * subpath) in each shipped `src/`, in each form: a static import or
 * re-export, a dynamic `import()`, a `require()`, and a type-position
 * `import('hono')`. The allowlist names the core server-module files that
 * still build on it; it only shrinks (the request handler is the last to
 * go).
 * `scripts/test/eslint-hono.test.mjs` holds it exact: every entry is a file
 * that still imports Hono, so a module that is deleted, moved or weaned off
 * Hono takes its entry with it instead of leaving an exemption behind.
 *
 * Tests are not covered: a test may build a bare Hono app to drive a handler.
 */

const SHIPPED_SOURCE = ['core/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'];

/** The files that may import Hono, each one of core's server module. */
const HONO_MODULES = [
  'core/src/app/application.ts',
  'core/src/app/http-pipeline.ts',
  'core/src/app/serve.ts',
  'core/src/server/app.ts',
  'core/src/server/env.ts',
  'core/src/server/http-server.ts',
  'core/src/server/output.ts',
  'core/src/server/request-handler.ts',
  'core/src/server/route-table.ts',
];

// esquery's regex literal cannot contain `/`, even escaped, so the subpath
// separator is written as `\x2F`.
const HONO = String.raw`/^hono(\x2F|$)/`;

export const restrictedSyntax = [
  {
    name: 'no-hono-import',
    files: SHIPPED_SOURCE,
    ignores: HONO_MODULES,
    selector: [
      `ImportDeclaration[source.value=${HONO}]`,
      `ExportNamedDeclaration[source.value=${HONO}]`,
      `ExportAllDeclaration[source.value=${HONO}]`,
      `ImportExpression[source.value=${HONO}]`,
      `CallExpression[callee.name='require'][arguments.0.value=${HONO}]`,
      `TSImportType[argument.literal.value=${HONO}]`,
    ].join(', '),
    message:
      'hono is core server-module internals: register routes through routes.add with a RouteContext handler and answer with Respond (jsails/api).',
  },
];

export default [];
