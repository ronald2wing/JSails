/**
 * One Valkey client factory (CNT-02).
 *
 * `core/src/valkey/connections.ts` is the only shipped module that constructs
 * an ioredis client: it gives every connection a role policy (connect and
 * reply deadlines, offline-queue behaviour, a client name) and the app's key
 * prefix. A second construction site would bring back a client that waits on
 * an unreachable server without a bound, so `jsails/no-ioredis-import` bans
 * `ioredis` in every shipped `src/` outside `core/src/valkey/`, in each form:
 * a static import or re-export, a dynamic `import()`, a `require()` (as from
 * `createRequire`), and a type-position `import('ioredis')`. Code takes a client from the app's `ValkeyConnections`
 * (`valkeyToken`, `jsails/plugin-sdk`) and names its type `ValkeyClient`.
 *
 * Tests are not covered: a live-service test may open its own raw client to
 * observe the server independently of the code under test.
 */

const SHIPPED_SOURCE = ['core/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'];
const VALKEY_MODULES = ['core/src/valkey/**'];

// esquery's regex literal cannot contain `/`, even escaped, so the subpath
// separator is written as `\x2F`.
const IOREDIS = String.raw`/^ioredis(\x2F|$)/`;

export const restrictedSyntax = [
  {
    name: 'no-ioredis-import',
    files: SHIPPED_SOURCE,
    ignores: VALKEY_MODULES,
    selector: [
      `ImportDeclaration[source.value=${IOREDIS}]`,
      `ExportNamedDeclaration[source.value=${IOREDIS}]`,
      `ExportAllDeclaration[source.value=${IOREDIS}]`,
      `ImportExpression[source.value=${IOREDIS}]`,
      `CallExpression[callee.name='require'][arguments.0.value=${IOREDIS}]`,
      `TSImportType[argument.literal.value=${IOREDIS}]`,
    ].join(', '),
    message:
      'ioredis is constructed only in core/src/valkey: take a client from the app ValkeyConnections (valkeyToken in jsails/plugin-sdk) and type it as ValkeyClient.',
  },
];

export default [];
