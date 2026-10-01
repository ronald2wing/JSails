/**
 * The import-graph policy: which third-party packages each public entry and
 * each scenario process may load. This file is the target architecture as
 * data (PERF-1's tiers, with KRN-22's final dependency list for the kernel);
 * the loaded-set gate (`scripts/gates/import-graph.mjs`) measures what really
 * loads and compares.
 *
 * Every public entry of every workspace has a tier. A tier names the packages
 * its entries may *enter* (import from first-party code); what such a package
 * loads in turn is covered by it. Today's excess (an entry entering a package
 * its tier does not allow) is listed in `scripts/expected-failures/import-graph.json`,
 * which may only shrink. Module counts are ceilings in
 * `scripts/import-graph/budgets.json`.
 *
 * Tiers:
 * - leaf: contracts and the CLI bootstrap; nothing third party but `cookie`.
 * - browser: runs in a browser bundle; Preact and signals and the isomorphic
 *   helpers `jsails/support` wraps, plus the per-entry additions below. Its static and dynamic closure must also stay free of
 *   `node:` builtins and server packages.
 * - runtime: the serving kernel (`jsails` after KRN-22).
 * - data: the data layer (`@jsails/database`): runtime plus TypeORM.
 * - adapter: transport adapters behind their own subpaths (BullMQ, ioredis,
 *   Socket.IO server).
 * - tooling: build, dev, deploy and agent tooling (`@jsails/dev`,
 *   `@jsails/jamal`, `@jsails/mcp`).
 * - plugin: a first-party plugin package: runtime plus the packages its own
 *   manifest declares (dependencies, peers, optional dependencies).
 */

const RUNTIME = Object.freeze([
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
]);

/** The ProseMirror packages the rich-text editor is built on. */
const PROSEMIRROR = Object.freeze([
  'prosemirror-commands',
  'prosemirror-history',
  'prosemirror-inputrules',
  'prosemirror-keymap',
  'prosemirror-model',
  'prosemirror-schema-list',
  'prosemirror-state',
  'prosemirror-transform',
  'prosemirror-view',
]);

export const TIERS = Object.freeze({
  leaf: Object.freeze(['cookie']),
  browser: Object.freeze(['preact', '@preact/signals', 'es-toolkit', 'qs', 'slugify']),
  runtime: RUNTIME,
  data: Object.freeze([...RUNTIME, 'typeorm', 'reflect-metadata']),
  adapter: Object.freeze([
    ...RUNTIME,
    'bullmq',
    'ioredis',
    'socket.io',
    'socket.io-adapter',
    '@socket.io/redis-adapter',
  ]),
  tooling: Object.freeze([
    ...RUNTIME,
    'rolldown',
    'tinyglobby',
    'yaml',
    'vite',
    '@preact/preset-vite',
    'typescript',
    '@modelcontextprotocol/server',
    '@modelcontextprotocol/client',
  ]),
  plugin: RUNTIME,
});

/**
 * The tier of every public entry, and what an entry may enter beyond its tier
 * (`mayLoad`). A plugin-tier entry also may enter its workspace's declared
 * packages. An entry missing here fails the gate, so a new subpath is placed
 * deliberately.
 */
export const ENTRIES = Object.freeze({
  // Kernel: contracts and leaves.
  'jsails/semver': { tier: 'leaf' },
  'jsails/security': { tier: 'leaf' },
  'jsails/services': { tier: 'leaf' },
  'jsails/diagnostics': { tier: 'leaf' },
  'jsails/facades': { tier: 'leaf' },
  'jsails/filesystem': { tier: 'leaf' },
  // The encryption plugin declares its key variables with `envVar` schemas.
  'jsails/encryption': { tier: 'leaf', mayLoad: ['zod'] },
  'jsails/routing': { tier: 'leaf' },
  // The error kernel: dependency-free and browser-safe (core/test/errors
  // holds its closure to its own modules), so a package that only raises or
  // recognizes framework errors loads nothing else.
  'jsails/errors': { tier: 'leaf' },
  // One execution context per unit of work: node builtins and the error
  // kernel only, so every layer can read the ambient request, trace and keys.
  'jsails/context': { tier: 'leaf' },
  // Cache, lease and defined-cache contracts: node builtins (the loader's
  // detached async context, random tag tokens) and the error kernel only;
  // server-side by nature, so not browser-safe.
  'jsails/cache': { tier: 'leaf' },
  // The CLI's environment bootstrap, for first-party bins (`jamal`).
  'jsails/internal': { tier: 'leaf' },
  'jsails/internal/plugin-manifest': { tier: 'leaf', mayLoad: ['zod'] },
  // The plugin-authoring contract: a plugin's config entry loads the kernel
  // and zod (its options and env schemas), nothing else.
  'jsails/kernel': { tier: 'leaf', mayLoad: ['zod'] },
  // Kernel: browser-safe subpaths (core's BROWSER_SAFE_SUBPATHS plus the ones
  // core/AGENTS.md documents as browser-safe).
  'jsails/api': { tier: 'browser', mayLoad: ['zod'] },
  'jsails/broadcast/client': { tier: 'browser', mayLoad: ['socket.io-client'] },
  'jsails/client': { tier: 'browser', mayLoad: ['@hotwired/turbo'] },
  'jsails/client/model': { tier: 'browser' },
  'jsails/data': { tier: 'browser', mayLoad: ['zod'] },
  'jsails/extensions': { tier: 'browser' },
  'jsails/http': { tier: 'browser' },
  'jsails/i18n': { tier: 'browser' },
  'jsails/jsx-runtime': { tier: 'browser' },
  'jsails/rich-text': { tier: 'browser', mayLoad: ['zod'] },
  'jsails/signals': { tier: 'browser' },
  'jsails/support': { tier: 'browser' },
  // The browser installer loads every browser-safe subpath lazily.
  'jsails/symbols/client': {
    tier: 'browser',
    mayLoad: ['zod', 'socket.io-client', '@hotwired/turbo'],
  },
  'jsails/validation': { tier: 'browser', mayLoad: ['zod'] },
  'jsails/view': { tier: 'browser' },
  // Kernel: serving runtime.
  jsails: { tier: 'runtime' },
  'jsails/app': { tier: 'runtime' },
  'jsails/broadcast': { tier: 'runtime' },
  'jsails/i18n/loader': { tier: 'runtime' },
  'jsails/i18n/server': { tier: 'runtime' },
  'jsails/jobs': { tier: 'runtime' },
  'jsails/live': { tier: 'runtime' },
  'jsails/pages': { tier: 'runtime' },
  'jsails/plugin-sdk': { tier: 'runtime' },
  'jsails/plugins': { tier: 'runtime' },
  'jsails/render-to-string': { tier: 'runtime' },
  'jsails/server-components': { tier: 'runtime' },
  'jsails/support/server': { tier: 'runtime' },
  'jsails/zod': { tier: 'runtime' },
  // Moves to @jsails/seo.
  'jsails/seo': { tier: 'runtime', mayLoad: ['sitemap', 'unhead', 'schema-dts'] },
  // Data layer.
  'jsails/database': { tier: 'data' },
  'jsails/models': { tier: 'data' },
  '@jsails/database': { tier: 'data' },
  '@jsails/database/testing': { tier: 'data' },
  '@jsails/database/model': { tier: 'runtime' },
  '@jsails/database/schema': { tier: 'data' },
  '@jsails/database/unguarded': { tier: 'data' },
  // Tooling.
  'jsails/build': { tier: 'tooling' },
  'jsails/dev': { tier: 'tooling' },
  'jsails/introspect': { tier: 'tooling' },
  'jsails/mcp': { tier: 'tooling' },
  'jsails/symbols': { tier: 'tooling' },
  'jsails/testing': { tier: 'tooling' },
  '@jsails/jamal': { tier: 'tooling' },
  '@jsails/mcp': { tier: 'tooling' },
  // First-party packages: browser entries.
  '@jsails/theme': { tier: 'browser', mayLoad: ['zod'] },
  '@jsails/live/client': { tier: 'browser', mayLoad: ['socket.io-client'] },
  '@jsails/ai/client': { tier: 'browser' },
  // The ProseMirror editor: the root entry mounts it, and the island loads it
  // with `import()` (the browser closure follows dynamic imports).
  '@jsails/editor': { tier: 'browser', mayLoad: ['zod', ...PROSEMIRROR] },
  '@jsails/editor/preact': { tier: 'browser', mayLoad: ['zod', ...PROSEMIRROR] },
  // First-party packages: plugins.
  '@jsails/admin': { tier: 'plugin' },
  '@jsails/ai': { tier: 'plugin' },
  '@jsails/ai/anthropic': { tier: 'plugin' },
  '@jsails/ai/mcp': { tier: 'plugin' },
  '@jsails/ai/openai-compatible': { tier: 'plugin' },
  '@jsails/ai/testing': { tier: 'plugin' },
  '@jsails/auth': { tier: 'plugin' },
  '@jsails/blog': { tier: 'plugin' },
  '@jsails/blog/admin': { tier: 'plugin' },
  '@jsails/cache': { tier: 'plugin' },
  '@jsails/config': { tier: 'plugin' },
  '@jsails/config/admin': { tier: 'plugin' },
  '@jsails/config/commands/export': { tier: 'plugin' },
  '@jsails/config/commands/import': { tier: 'plugin' },
  '@jsails/config/database': { tier: 'plugin' },
  '@jsails/content': { tier: 'plugin' },
  '@jsails/diagnostics': { tier: 'plugin' },

  '@jsails/editor/server': { tier: 'plugin' },
  '@jsails/filesystem': { tier: 'plugin' },
  '@jsails/filesystem/testing': { tier: 'plugin' },
  '@jsails/flags': { tier: 'plugin' },
  '@jsails/flags/admin': { tier: 'plugin' },
  // The database feature store: the plugin tier with its TypeORM entity.
  '@jsails/flags/database': { tier: 'plugin' },
  '@jsails/inertia': { tier: 'plugin' },
  '@jsails/inertia/testing': { tier: 'plugin' },
  '@jsails/jobs': { tier: 'plugin' },
  '@jsails/jobs/testing': { tier: 'plugin' },
  '@jsails/jobs/valkey': { tier: 'adapter' },
  '@jsails/live': { tier: 'plugin' },
  '@jsails/logging': { tier: 'plugin' },
  '@jsails/mail': { tier: 'plugin' },
  // Pure trust primitives: the manifest contract (zod) and node builtins only.
  '@jsails/marketplace': { tier: 'leaf', mayLoad: ['zod'] },
  '@jsails/media': { tier: 'plugin' },
  '@jsails/media/admin': { tier: 'plugin' },
  '@jsails/notifications': { tier: 'plugin' },
  // The database notification store: the plugin tier with its TypeORM entity.
  '@jsails/notifications/database': { tier: 'plugin' },
  '@jsails/resources': { tier: 'plugin' },
  '@jsails/sessions': { tier: 'plugin' },
  '@jsails/tenancy': { tier: 'plugin' },
  '@jsails/webhook': { tier: 'plugin' },
});

/**
 * Workspaces another lane is still filling, each with that lane. Their entries
 * are measured and judged against their tiers, but they carry no module
 * ceiling and an entry they add without a tier is a note, because their
 * graphs move with every commit of the lane. When the lane lands, its line is
 * removed and `node scripts/import-graph/index.mjs --write` records the
 * ceilings.
 */
export const UNSETTLED = Object.freeze({});

/**
 * Scenario processes, measured like entries: the real CLI and the real
 * serving path, which catch eager dynamic imports that no entry import shows.
 * Their projects are defined in `scenarios.mjs`.
 */
export const SCENARIOS = Object.freeze({
  'cli-help': { tier: 'leaf' },
  'cli-usage-error': { tier: 'leaf' },
  'cli-unknown-command': { tier: 'leaf' },
  'cli-create-help': { tier: 'leaf' },
  'cli-make-help': { tier: 'leaf' },
  'cli-db-diff-help': { tier: 'leaf' },
  'cli-db-diff-no-config': { tier: 'leaf' },
  'cli-queue-failed-help': { tier: 'leaf' },
  'cli-describe-help': { tier: 'leaf' },
  'cli-plugins-help': { tier: 'leaf' },
  // Reading the app config scans it statically before the import (the oxc
  // parser of `rolldown/utils`, loaded by the scan alone: the kernel loader's
  // import-graph and activation-literal checks), validates it with Zod, and
  // loads nothing else.
  'cli-inspect-routes': { tier: 'leaf', mayLoad: ['zod', 'rolldown'] },
  // A static build reads the app config (as above), renders pages, and never
  // loads the HTTP pipeline or the node server.
  'cli-build': {
    tier: 'leaf',
    mayLoad: [
      'rolldown',
      'zod',
      'preact',
      'preact-render-to-string',
      'unhead',
      'sitemap',
      'es-toolkit',
      'slugify',
    ],
  },
  'mcp-ready': { tier: 'tooling' },
  // Serving reads the app config, so the config scan's parser loads at boot.
  'serve-first-request': { tier: 'runtime', mayLoad: ['rolldown'] },
  'serve-first-request-database': { tier: 'data', mayLoad: ['rolldown', 'sql.js'] },
});

/**
 * The packages an entry or scenario with policy `{ tier, mayLoad }` may enter;
 * `manifest` is its workspace manifest (a plugin tier adds what it declares).
 */
export function allowedPackages(policy, manifest, tiers = TIERS) {
  const allowed = new Set([...(tiers[policy.tier] ?? []), ...(policy.mayLoad ?? [])]);
  if (policy.tier === 'plugin' && manifest !== undefined) {
    for (const group of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(manifest[group] ?? {})) allowed.add(name);
    }
  }
  return allowed;
}
