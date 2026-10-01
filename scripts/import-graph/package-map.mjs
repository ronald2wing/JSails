/**
 * The final package map (KRN-22) as data, while every future package is still
 * a directory of `core/src`. The direction gate (`scripts/gates/import-direction.mjs`)
 * reads it: an import from one future package into another that the map does
 * not allow, or of a third-party package the importing future package does not
 * own, is a violation, listed in `scripts/expected-failures/import-direction.json`
 * until the move that removes it.
 *
 * `PACKAGES` names each future package, the future packages it may import, and
 * the third-party packages it owns. `PLACEMENT` places every `core/src` path:
 * the longest matching prefix wins (a directory prefix ends in `/`), and a
 * path no rule places fails the gate, so a new directory is placed on purpose.
 *
 * Existing workspaces under `packages/` keep their names; the core directories
 * that merge into one of them (`live`, `mcp`, `diagnostics`) are placed under
 * that name, so an import cycle between a package and the code that will join
 * it is caught as well.
 */

/** Third-party packages of the kernel (KRN-22), each needed by the serving runtime. */
const KERNEL_DEPENDENCIES = [
  'hono',
  '@hono/node-server',
  'preact',
  'preact-render-to-string',
  '@preact/signals',
  '@hotwired/turbo',
  'zod',
  'cookie',
  'qs',
  'mime-types',
  'es-toolkit',
  'slugify',
];

export const PACKAGES = Object.freeze({
  jsails: { imports: [], dependencies: KERNEL_DEPENDENCIES },
  'create-jsails': { imports: [], dependencies: [] },
  '@jsails/dev': {
    imports: ['jsails'],
    dependencies: [
      'tinyglobby',
      'vite',
      '@preact/preset-vite',
      'rolldown',
      '@oxc-project/types',
      'typescript',
    ],
  },
  '@jsails/database': {
    imports: ['jsails'],
    dependencies: ['typeorm', 'reflect-metadata', 'mysql2', 'pg', 'sql.js'],
  },
  '@jsails/valkey': { imports: ['jsails'], dependencies: ['ioredis'] },
  '@jsails/jobs': {
    imports: ['jsails', '@jsails/valkey', '@jsails/database'],
    dependencies: ['bullmq', 'cron-parser'],
  },
  '@jsails/broadcast': {
    imports: ['jsails', '@jsails/valkey'],
    dependencies: [
      'socket.io',
      'socket.io-client',
      'socket.io-adapter',
      '@socket.io/redis-adapter',
    ],
  },
  '@jsails/seo': { imports: ['jsails'], dependencies: ['sitemap', 'schema-dts', 'unhead'] },
  '@jsails/marketplace': { imports: ['jsails', '@jsails/database'], dependencies: [] },
  '@jsails/jamal': { imports: ['jsails'], dependencies: [] },
  '@jsails/mcp': {
    imports: ['jsails', '@jsails/dev'],
    dependencies: ['@modelcontextprotocol/server', '@modelcontextprotocol/client'],
  },
  '@jsails/live': {
    imports: ['jsails', '@jsails/valkey', '@jsails/database', '@jsails/broadcast'],
    dependencies: ['socket.io', 'socket.io-client'],
  },
  '@jsails/diagnostics': { imports: ['jsails'], dependencies: [] },
  '@jsails/content': { imports: ['jsails'], dependencies: ['yaml'] },
  '@jsails/filesystem': { imports: ['jsails'], dependencies: ['file-type', 'image-size'] },
});

/** Where each `core/src` path goes; the longest matching prefix wins. */
export const PLACEMENT = Object.freeze({
  // The kernel and serving runtime.
  'api/': 'jsails',
  'app/': 'jsails',
  'cache/': 'jsails',
  'cli/': 'jsails',
  'client/': 'jsails',
  'contracts/': 'jsails',
  'config-modules.ts': 'jsails',
  'credentials.ts': 'jsails',
  'dotenv-document.ts': 'jsails',
  'dotenv.ts': 'jsails',
  'encryption/': 'jsails',
  'entry/': 'jsails',
  'environment.ts': 'jsails',
  'errors/': 'jsails',
  'extensions/': 'jsails',
  'facades/': 'jsails',
  'filesystem/': 'jsails',
  'http/': 'jsails',
  'i18n/': 'jsails',
  'index.ts': 'jsails',
  'json/': 'jsails',
  'jsx/': 'jsails',
  'pages/': 'jsails',
  'plugin-sdk/': 'jsails',
  'plugins/': 'jsails',
  'rich-text/': 'jsails',
  'routing/': 'jsails',
  'security/': 'jsails',
  'semver/': 'jsails',
  'server/': 'jsails',
  'server-components/': 'jsails',
  'services/': 'jsails',
  'signals/': 'jsails',
  'support/': 'jsails',
  'symbols/': 'jsails',
  'testing/': 'jsails',
  'url/': 'jsails',
  'validation/': 'jsails',
  'zod.ts': 'jsails',
  // Content and media helpers that leave the kernel.
  'support/frontmatter.server.ts': '@jsails/content',
  'support/media-detect.server.ts': '@jsails/filesystem',
  // The toolchain (devDependency).
  'build/': '@jsails/dev',
  'compiler/': '@jsails/dev',
  'dev/': '@jsails/dev',
  'introspect/': '@jsails/dev',
  'testing/app.ts': '@jsails/dev',
  'cli/commands/agents-setup.ts': '@jsails/dev',
  'cli/commands/app-shape.ts': '@jsails/dev',
  'cli/commands/build-meta.ts': '@jsails/dev',
  'cli/commands/console.ts': '@jsails/dev',
  'cli/commands/describe.ts': '@jsails/dev',
  'cli/commands/explain.ts': '@jsails/dev',
  'cli/commands/i18n-missing.ts': '@jsails/dev',
  'cli/commands/inject-auto-imports.ts': '@jsails/dev',
  'cli/commands/inspect.ts': '@jsails/dev',
  'cli/commands/make-templates.ts': '@jsails/dev',
  'cli/commands/make-test-templates.ts': '@jsails/dev',
  'cli/commands/make.ts': '@jsails/dev',
  'cli/commands/test.ts': '@jsails/dev',
  // The starter generator.
  'app/scaffold.ts': 'create-jsails',
  'app/starter/': 'create-jsails',
  'cli/create-jsails.ts': 'create-jsails',
  'cli/commands/create.ts': 'create-jsails',
  'cli/commands/create-git.ts': 'create-jsails',
  // The data layer.
  'data/': '@jsails/database',
  'database/': '@jsails/database',
  'migrations/': '@jsails/database',
  'models/': '@jsails/database',
  'testing/test-database.ts': '@jsails/database',
  'cli/commands/db.ts': '@jsails/database',
  'cli/commands/seed.ts': '@jsails/database',
  // Jobs, transports and realtime.
  'jobs/': '@jsails/jobs',
  'cli/commands/queue.ts': '@jsails/jobs',
  'cli/commands/queue-failed.ts': '@jsails/jobs',
  'cli/commands/runtime.ts': '@jsails/jobs',
  'cli/commands/schedules.ts': '@jsails/jobs',
  'valkey/': '@jsails/valkey',
  'broadcast/': '@jsails/broadcast',
  'live/': '@jsails/live',
  // Head, sitemap and structured data.
  'seo/': '@jsails/seo',
  // The managed-plugin installer; the kernel keeps the manifest, the
  // `plugins.use` resolver, enablement, schema discovery and the gate.
  'plugins/activation.ts': '@jsails/marketplace',
  'plugins/archive.ts': '@jsails/marketplace',
  'plugins/bundle-intake.ts': '@jsails/marketplace',
  'plugins/check.ts': '@jsails/marketplace',
  'plugins/database-state-entity.ts': '@jsails/marketplace',
  'plugins/database-state-store.ts': '@jsails/marketplace',
  'plugins/discovery/': '@jsails/marketplace',
  'plugins/download-capability.ts': '@jsails/marketplace',
  'plugins/installed-bundles.ts': '@jsails/marketplace',
  'plugins/installer-error.ts': '@jsails/marketplace',
  'plugins/installer-state.ts': '@jsails/marketplace',
  'plugins/installer.ts': '@jsails/marketplace',
  'plugins/provenance.ts': '@jsails/marketplace',
  'plugins/snapshot.ts': '@jsails/marketplace',
  'plugins/state-store.ts': '@jsails/marketplace',
  'cli/commands/plugins/': '@jsails/marketplace',
  // Agent tooling.
  'mcp/': '@jsails/mcp',
  'cli/commands/mcp.ts': '@jsails/mcp',
  // Joins the existing @jsails/diagnostics package.
  'diagnostics/': '@jsails/diagnostics',
});

/**
 * The future package of a `core/src`-relative POSIX path, or undefined when no
 * rule places it.
 */
export function placeOf(relativePath, placement = PLACEMENT) {
  let best;
  for (const prefix of Object.keys(placement)) {
    const matches = prefix.endsWith('/')
      ? relativePath.startsWith(prefix)
      : relativePath === prefix;
    if (matches && (best === undefined || prefix.length > best.length)) best = prefix;
  }
  return best === undefined ? undefined : placement[best];
}

/** Whether future package `from` may import future package `to`. */
export function mayImport(from, to, packages = PACKAGES) {
  return from === to || (packages[from]?.imports ?? []).includes(to);
}

/** Whether future package `owner` owns third-party package `dependency`. */
export function ownsDependency(owner, dependency, packages = PACKAGES) {
  return (packages[owner]?.dependencies ?? []).includes(dependency);
}

/** Every future package `name` may reach through allowed imports, itself included. */
export function reachable(name, packages = PACKAGES) {
  const seen = new Set();
  const queue = [name];
  while (queue.length > 0) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(packages[next]?.imports ?? []));
  }
  return seen;
}

/**
 * Problems in the map itself: a placement or an allowed import naming an
 * unknown package, or allowed imports that form a cycle (two packages that
 * may import each other cannot both be published).
 */
export function validateMap(packages = PACKAGES, placement = PLACEMENT) {
  const problems = [];
  for (const [prefix, owner] of Object.entries(placement)) {
    if (packages[owner] === undefined)
      problems.push(`placement "${prefix}" names unknown package ${owner}`);
  }
  for (const [name, { imports }] of Object.entries(packages)) {
    for (const target of imports) {
      if (packages[target] === undefined)
        problems.push(`${name} may import unknown package ${target}`);
      else if (target !== name && reachable(target, packages).has(name)) {
        problems.push(`${name} and ${target} may import each other`);
      }
    }
  }
  return problems;
}
