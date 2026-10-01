/**
 * Shipped code reads the process environment only at a process boundary.
 *
 * Every source file under `core/src` and `packages/<name>/src` that reads the
 * process environment, comments ignored, is either on the permanent
 * allow-list below, one file per entry with the reason it is a boundary, or
 * listed in `scripts/expected-failures/process-env.json`, which only shrinks.
 * A read is `process.env` (property, optional or bracket access, or
 * destructuring `env` from `process`), or the same through the `process`
 * module: a named `env` import from `node:process` or `process`, `.env` on
 * its namespace or default import binding, or on a `require` or dynamic
 * `import()` of it. Anything else declares its variables: a plugin through
 * `env` in `definePlugin` (read by
 * `core/src/plugins/contract/env-variables.ts` alone), app code through the
 * resolved environment. The list names files, never directories, so a new
 * reader is a decision someone makes; an entry that matches no reading file
 * fails too, so the list cannot outlive its reason.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { readGateLedger, ratchet } from '../expected-failures.mjs';
import { workspaceDirs } from '../workspaces.mjs';
import { stripComments } from './plugin-manifests.mjs';

export const name = 'process-env';
export const description =
  'process.env is read only at allow-listed process boundaries; other readers may only shrink';
export const needsBuild = false;

/**
 * The permanent readers, one file each: where a process starts, hands its
 * environment to a child it spawns, or the one declared-variable reader.
 */
export const ALLOWED = Object.freeze([
  {
    path: 'core/src/environment/accessor.ts',
    reason: 'the environment resolver: reads a resolved variable at call time',
  },
  {
    path: 'core/src/environment/read.ts',
    reason: 'the environment resolver: typed readers over the real environment',
  },
  {
    path: 'core/src/environment/resolve.ts',
    reason:
      'the environment resolver: reads the real environment once and applies the result, under its precedence rules',
  },
  {
    path: 'core/src/plugins/contract/env-variables.ts',
    reason: "the plugin environment reader: reads exactly the variables a plugin's env declares",
  },
  {
    path: 'core/src/cli/dispatch.ts',
    reason: 'the jsails dispatcher: resolves and applies the environment of every CLI invocation',
  },
  {
    path: 'core/src/cli/owned-process-tree.ts',
    reason: 'hands its environment to the npm child process it spawns and owns',
  },
  {
    path: 'core/src/cli/commands/test.ts',
    reason: 'hands its environment to the test runner child process it spawns',
  },
  {
    path: 'packages/jamal/src/bin.ts',
    reason: "jamal's bin: the process boundary of every jamal invocation",
  },
  {
    path: 'packages/jamal/src/docker.ts',
    reason: 'hands its environment to the docker child process it spawns',
  },
  {
    path: 'core/src/dev/runtime.ts',
    reason: 'the dev supervisor hands its environment to the server child it spawns',
  },
  {
    path: 'core/src/dev/serve-child.ts',
    reason: 'the dev server child reads the handoff variables its supervisor set',
  },
  {
    path: 'core/src/mcp/server.ts',
    reason: 'the jsails mcp process entry reads its own debug switch for failure reports',
  },
  {
    path: 'core/src/support/syntax-location.server.ts',
    reason: 'spawns a parse-only child with a filtered copy of the environment',
  },
  {
    path: 'core/src/app/dockerfile.ts',
    reason: "text of the generated image's healthcheck script, read inside the container",
  },
  {
    path: 'core/src/testing/app.ts',
    reason: "a test helper: reads the test runner's own origin variable",
  },
  {
    path: 'core/src/testing/seeded-random.ts',
    reason: "a test helper: reads the test runner's own seed variable",
  },
  {
    path: 'packages/database/src/testing/driver-matrix.ts',
    reason: "the driver matrix reads the test runner's database variables",
  },
  {
    path: 'packages/database/src/testing/test-data-source.ts',
    reason: "a test helper: reads the test runner's own worker id (NODE_TEST_WORKER_ID)",
  },
  {
    path: 'packages/editor/src/prosemirror/codec.ts',
    reason: 'browser code: a bundler replaces process.env.NODE_ENV at build time',
  },
]);

/** The `process` module, by either specifier. */
const PROCESS_MODULE = String.raw`['"](?:node:)?process['"]`;

/** An expression that evaluates to the `process` module: `require(...)` or `await import(...)`. */
const PROCESS_LOAD = String.raw`(?:require|(?:await\s+)?import)\s*\(\s*${PROCESS_MODULE}\s*\)`;

/** Reads of `env` from an object named `binding` (an identifier pattern). */
function envReads(binding) {
  return [
    new RegExp(String.raw`(?<![\w$])${binding}\s*(?:\?\.|\.)\s*env\b`),
    new RegExp(String.raw`(?<![\w$])${binding}\s*\[\s*(['"\`])env\1\s*\]`),
    new RegExp(String.raw`\{[^{}]*\benv\b[^{}]*\}\s*=\s*(?:globalThis\s*\.\s*)?${binding}\b`),
  ];
}

const READ_PATTERNS = [
  ...envReads('process'),
  // `require('node:process').env` or `(await import('node:process')).env`
  new RegExp(String.raw`${PROCESS_LOAD}\s*\)?\s*(?:\?\.|\.)\s*env\b`),
  // `const { env } = require('node:process')` or `= await import('node:process')`
  new RegExp(String.raw`\{[^{}]*\benv\b[^{}]*\}\s*=\s*${PROCESS_LOAD}`),
  // `import { env } from 'node:process'`, also renamed
  new RegExp(String.raw`import\s*\{[^}]*\benv\b[^}]*\}\s*from\s*${PROCESS_MODULE}`),
];

/** The bindings a file gives the `process` module through a namespace or default import. */
function processBindings(code) {
  const bindings = [];
  const pattern = new RegExp(
    String.raw`import\s+(?:\*\s+as\s+([\w$]+)|([\w$]+))(?:\s*,\s*(?:\*\s+as\s+([\w$]+)|\{[^}]*\}))?\s+from\s*${PROCESS_MODULE}`,
    'g',
  );
  for (const match of code.matchAll(pattern)) {
    for (const binding of [match[1], match[2], match[3]]) {
      if (binding !== undefined) bindings.push(binding.replaceAll('$', '\\$'));
    }
  }
  return bindings;
}

/** Whether source text reads the process environment, comments ignored. */
export function readsProcessEnv(source) {
  const code = stripComments(source);
  const patterns = [...READ_PATTERNS, ...processBindings(code).flatMap(envReads)];
  return patterns.some((pattern) => pattern.test(code));
}

/** The allow-list entry for a repo-relative POSIX path, if any. */
export function allowedEntry(file, allowed = ALLOWED) {
  return allowed.find((entry) => file === entry.path);
}

/** Every shipped source root: each workspace's `src`. */
function sourceRoots(root) {
  return workspaceDirs(root)
    .map((dir) => join(dir, 'src'))
    .filter((dir) => existsSync(dir));
}

/** The repo-relative POSIX paths of every source file that reads `process.env`, sorted. */
export function processEnvReaders(root) {
  const readers = [];
  for (const dir of sourceRoots(root)) {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ts|tsx|mts|js|mjs)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      const path = join(entry.parentPath, entry.name);
      if (readsProcessEnv(readFileSync(path, 'utf8'))) {
        readers.push(relative(root, path).split(sep).join('/'));
      }
    }
  }
  return readers.sort();
}

export function run({ repoRoot }) {
  const readers = processEnvReaders(repoRoot);
  const failures = ALLOWED.filter(
    (entry) => !readers.some((file) => allowedEntry(file, [entry]) !== undefined),
  ).map(
    (entry) =>
      `allow-list entry ${entry.path} is not a file that reads the process environment; remove it`,
  );
  const listed = readers.filter((file) => allowedEntry(file) === undefined);
  const { unlisted, fixed } = ratchet(readGateLedger(name, { root: repoRoot }), listed);
  failures.push(
    ...unlisted.map(
      (file) =>
        `${file} reads process.env; declare the variable (a plugin's env, the resolved environment) instead`,
    ),
    ...fixed.map(
      (file) => `fixed: ${file} no longer reads process.env; remove it from process-env.json`,
    ),
  );
  return failures;
}
