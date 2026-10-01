/**
 * Starter meta-module catalog.
 *
 * The five starter shapes are Magento-style meta modules: they own no
 * implementation. A preset only declares the feature modules it requires and
 * its plugin-discovery policy. Each feature module owns its own template
 * contributions, package dependencies, app/migration config provider, and
 * guide text.
 *
 * This keeps adding a shape data-only and makes imported plugins
 * not exposed to the managed/marketplace surface by default: `managedPlugins`
 * is an explicit policy on the meta module (`'all'`, `'none'`, or a list).
 * Code-imported plugins still run through `plugins.use` regardless.
 */

/** The five starter shapes, by stable id. */
export type StarterPresetId = 'starter' | 'admin' | 'blog' | 'saas' | 'cli';

/** The build-time feature modules a preset can require. */
export type StarterFeatureId =
  | 'static-site'
  | 'cli'
  | 'web-base'
  | 'auth'
  | 'admin'
  | 'editor'
  | 'theme'
  | 'plugin-manager'
  | 'blog'
  | 'media'
  | 'tenancy'
  | 'flags'
  | 'saas-config';

/** Which bundled template directory a feature draws its templates from. */
export type StarterTemplateBase = 'starter' | 'starter-web' | 'starter-cli';

/** The shape category a preset belongs to. */
export type StarterKind = 'static' | 'web' | 'cli';

/** The server-rendered web preset ids. */
export type WebStarterVariant = Extract<StarterPresetId, 'admin' | 'blog' | 'saas'>;

/**
 * Which installed plugins the generated app exposes to the managed/marketplace
 * surface (`plugins.enabled`). `'all'` omits the allow-list, `'none'` writes an
 * empty list, and an array writes exactly those ids. This never enables or
 * disables code-imported `plugins.use` entries: those always run.
 */
export type StarterManagedPlugins = 'all' | 'none' | readonly string[];

/** A build-time feature module. */
export interface StarterFeature {
  /** Stable feature id, referenced by presets and other features. */
  readonly id: StarterFeatureId;
  /** Human description of what shipping this module gives a generated project. */
  readonly description: string;
  /** Other feature modules this module depends on. */
  readonly requires?: readonly StarterFeatureId[];
  /** Template contributions, copied under the preset's output tree. */
  readonly templates?: {
    readonly base: StarterTemplateBase;
    readonly files: readonly string[];
  };
  /** Runtime package dependencies this feature adds to `package.json`. */
  readonly dependencies?: Readonly<Record<string, string>>;
  /** The app-config provider; the highest-priority provider wins. */
  readonly appConfig?: {
    readonly template: string;
    readonly base: StarterTemplateBase;
    readonly priority: number;
  };
  /** The migration/data-source config provider; highest priority wins. */
  readonly migrationConfig?: {
    readonly template: string;
    readonly base: StarterTemplateBase;
    readonly priority: number;
  };
}

/** A meta module: only requirements and the plugin-discovery policy. */
export interface StarterPreset {
  /** Stable preset id. */
  readonly id: StarterPresetId;
  /** Human description of the shape. */
  readonly description: string;
  /** Shape category, used to select the guide builder. */
  readonly kind: StarterKind;
  /** The feature modules this meta module requires. */
  readonly requires: readonly StarterFeatureId[];
  /** Which imported plugins are discoverable through the managed surface. */
  readonly managedPlugins: StarterManagedPlugins;
}

// ---------------------------------------------------------------------------
// Feature-owned template contributions
// ---------------------------------------------------------------------------

const WEB_TEMPLATE_FILES: readonly string[] = [
  'app/application-auth.ts.template',
  'app/application-client.ts.template',
  'app/application-command.ts.template',
  'app/application-component.ts.template',
  'app/application-plugin.ts.template',
  'app/application-resource.ts.template',
  'app/application-testing.ts.template',
  'client/main.tsx',
  'components/task-list.tsx',
  '.env.auth.example.template',
  '.gitignore.template',
  'jamal.config.js.template',
  'api/me.ts.template',
  'auth/README.md.template',
  'commands/login.ts.template',
  'commands/logout.ts.template',
  'commands/whoami.ts.template',
  'package.json.template',
  'pages/about.tsx',
  'pages/dashboard.tsx.template',
  'pages/device.tsx.template',
  'pages/index.tsx',
  'pages/live.tsx',
  'pages/login.tsx.template',
  'pages/register.tsx.template',
  'pages/reset-password.tsx.template',
  'pages/tasks.tsx',
  'playwright.config.ts.template',
  'scripts/auth-migrate.mjs.template',
  'scripts/create-user.mjs.template',
  'scripts/db-migrate.mjs.template',
  'scripts/run-tests.mjs.template',
  'test/app.test.ts.template',
  'test/auth.test.ts.template',
  'test/browser/auth.spec.ts.template',
  'test/browser/fixtures.ts.template',
  'test/browser/home.spec.ts.template',
  'tsconfig.client.json.template',
  'tsconfig.json.template',
  'ui/class-names.ts',
  'ui/dialog.tsx',
  'ui/field.tsx',
  'ui/counter.tsx',
  'ui/layout.tsx',
  'ui/live-posts.tsx',
  'ui/register-form.tsx',
  'ui/reset-password.tsx',
  'ui/styles.css',
  'ui/task-notes.ts',
  'vite.config.js.template',
];

const BLOG_TEMPLATE_FILES: readonly string[] = [
  'pages/blog/index.tsx',
  'pages/blog/[slug].tsx',
  'server/theme.ts',
];

const STARTER_TEMPLATE_FILES: readonly string[] = [
  '.gitignore.template',
  'app/application-client.ts.template',
  'client/main.tsx',
  'content/about/about.md',
  'content/posts/islands-without-the-framework-tax.md',
  'content/posts/static-sites-with-typed-content.md',
  'content/posts/why-we-built-jsails.md',
  'package.json.template',
  'pages/about.tsx',
  'pages/blog/[slug].tsx',
  'pages/blog/index.tsx',
  'pages/categories/[term].tsx',
  'pages/categories/index.tsx',
  'pages/index.tsx',
  'pages/tags/[term].tsx',
  'pages/tags/index.tsx',
  'scripts/generate-feeds.mjs',
  'server/content.ts',
  'shared/site.ts',
  'tsconfig.client.json.template',
  'tsconfig.json.template',
  'ui/components.tsx',
  'ui/layout.tsx',
  'ui/styles.css',
  'vite.config.js.template',
];

const CLI_TEMPLATE_FILES: readonly string[] = [
  '.gitignore.template',
  'app/application-command.ts.template',
  'commands/hello.ts.template',
  'package.json.template',
  'tsconfig.json.template',
];

// ---------------------------------------------------------------------------
// Feature modules
// ---------------------------------------------------------------------------

const STATIC_CONFIG = Object.freeze({
  template: 'jsails.app.js.template',
  base: 'starter',
  priority: 0,
} as const);

const CLI_CONFIG = Object.freeze({
  template: 'jsails.app.js.template',
  base: 'starter-cli',
  priority: 0,
} as const);

const ADMIN_CONFIG = Object.freeze({
  template: 'jsails.app.admin.js.template',
  base: 'starter-web',
  priority: 10,
} as const);

const BLOG_CONFIG = Object.freeze({
  template: 'jsails.app.blog.js.template',
  base: 'starter-web',
  priority: 20,
} as const);

const SAAS_CONFIG = Object.freeze({
  template: 'jsails.app.saas.js.template',
  base: 'starter-web',
  priority: 30,
} as const);

const ADMIN_MIGRATION = Object.freeze({
  template: 'jsails.config.js.template',
  base: 'starter-web',
  priority: 10,
} as const);

const BLOG_MIGRATION = Object.freeze({
  template: 'jsails.config.blog.js.template',
  base: 'starter-web',
  priority: 20,
} as const);

const SAAS_MIGRATION = Object.freeze({
  template: 'jsails.config.js.template',
  base: 'starter-web',
  priority: 30,
} as const);

/** The catalog of feature modules, in declaration order. */
export const STARTER_FEATURES: readonly StarterFeature[] = Object.freeze([
  Object.freeze({
    id: 'static-site',
    description: 'A content-backed static site built on `@jsails/content`.',
    templates: Object.freeze({
      base: 'starter' as const,
      files: Object.freeze(STARTER_TEMPLATE_FILES),
    }),
    appConfig: STATIC_CONFIG,
  }),
  Object.freeze({
    id: 'cli',
    description: 'A Laravel-Zero-style CLI-only project with no web surface.',
    templates: Object.freeze({
      base: 'starter-cli' as const,
      files: Object.freeze(CLI_TEMPLATE_FILES),
    }),
    appConfig: CLI_CONFIG,
  }),
  Object.freeze({
    id: 'web-base',
    description: 'The server-rendered web surface: pages, client runtime, and Vite.',
    templates: Object.freeze({
      base: 'starter-web' as const,
      files: Object.freeze(WEB_TEMPLATE_FILES),
    }),
    dependencies: Object.freeze({
      '@jsails/cache': '1.0.0',
      '@jsails/filesystem': '1.0.0',
      '@jsails/live': '1.0.0',
      '@jsails/mail': '1.0.0',
      '@jsails/plugin-tools': '1.0.0',
    }),
  }),
  Object.freeze({
    id: 'auth',
    description: 'Local email/password sign-in through `@jsails/auth`.',
    dependencies: Object.freeze({ '@jsails/auth': '1.0.0' }),
  }),
  Object.freeze({
    id: 'editor',
    description: 'The Editor.js rich-text editor island.',
    dependencies: Object.freeze({ '@jsails/editor': '1.0.0' }),
  }),
  Object.freeze({
    id: 'theme',
    description: 'Theme token and package activation support.',
    dependencies: Object.freeze({ '@jsails/theme': '1.0.0' }),
  }),
  Object.freeze({
    id: 'admin',
    description: 'The first-party admin panel mounted at `/admin`.',
    requires: Object.freeze(['editor', 'theme'] as readonly StarterFeatureId[]),
    dependencies: Object.freeze({ '@jsails/admin': '1.0.0' }),
    appConfig: ADMIN_CONFIG,
    migrationConfig: ADMIN_MIGRATION,
  }),
  Object.freeze({
    id: 'plugin-manager',
    description: 'The admin plugin manager for managed plugin installs.',
    dependencies: Object.freeze({ '@jsails/admin-plugin-manager': '1.0.0' }),
  }),
  Object.freeze({
    id: 'blog',
    description: 'The first-party blog CMS, its admin surface, and theme activation.',
    requires: Object.freeze(['admin'] as readonly StarterFeatureId[]),
    templates: Object.freeze({
      base: 'starter-web' as const,
      files: Object.freeze(BLOG_TEMPLATE_FILES),
    }),
    dependencies: Object.freeze({ '@jsails/blog': '1.0.0' }),
    appConfig: BLOG_CONFIG,
    migrationConfig: BLOG_MIGRATION,
  }),
  Object.freeze({
    id: 'media',
    description: 'The disk-backed media library and its admin surface.',
    dependencies: Object.freeze({ '@jsails/media': '1.0.0' }),
  }),
  Object.freeze({
    id: 'tenancy',
    description: 'Opt-in multi-tenancy through `@jsails/tenancy`.',
    dependencies: Object.freeze({ '@jsails/tenancy': '1.0.0' }),
  }),
  Object.freeze({
    id: 'flags',
    description: 'Feature flags through `@jsails/flags`.',
    dependencies: Object.freeze({ '@jsails/flags': '1.0.0' }),
  }),
  Object.freeze({
    id: 'saas-config',
    description: 'The SaaS app/migration config layer (overrides the admin config).',
    requires: Object.freeze(['admin'] as readonly StarterFeatureId[]),
    appConfig: SAAS_CONFIG,
    migrationConfig: SAAS_MIGRATION,
  }),
]);

// ---------------------------------------------------------------------------
// Meta modules
// ---------------------------------------------------------------------------

/** The five starter shapes as meta modules. */
export const STARTER_PRESETS: readonly StarterPreset[] = Object.freeze([
  Object.freeze({
    id: 'starter',
    description: 'A content-backed static site: Markdown content, Preact pages, and Vite.',
    kind: 'static',
    requires: Object.freeze(['static-site'] as readonly StarterFeatureId[]),
    managedPlugins: 'none',
  }),
  Object.freeze({
    id: 'admin',
    description: 'A server-rendered app with auth, the admin panel, and server components.',
    kind: 'web',
    requires: Object.freeze(['web-base', 'auth', 'admin'] as readonly StarterFeatureId[]),
    managedPlugins: 'none',
  }),
  Object.freeze({
    id: 'blog',
    description: 'A standalone blog CMS with admin, plugin manager, blog, and media; no tenancy.',
    kind: 'web',
    requires: Object.freeze([
      'web-base',
      'auth',
      'blog',
      'plugin-manager',
      'media',
    ] as readonly StarterFeatureId[]),
    managedPlugins: Object.freeze(['flags'] as readonly string[]),
  }),
  Object.freeze({
    id: 'saas',
    description: 'A server-rendered app with admin, multi-tenancy, and feature flags.',
    kind: 'web',
    requires: Object.freeze([
      'web-base',
      'auth',
      'saas-config',
      'tenancy',
      'flags',
    ] as readonly StarterFeatureId[]),
    managedPlugins: 'none',
  }),
  Object.freeze({
    id: 'cli',
    description: 'A Laravel-Zero-style CLI-only command project.',
    kind: 'cli',
    requires: Object.freeze(['cli'] as readonly StarterFeatureId[]),
    managedPlugins: 'none',
  }),
]);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** A resolved meta module plus its full feature graph, dependencies first. */
export interface ResolvedStarterPreset {
  readonly preset: StarterPreset;
  readonly features: readonly StarterFeature[];
}

/** Resolve a meta module from the CLI shape flags. */
export type StarterPresetResolution =
  | { readonly ok: true; readonly preset: StarterPreset }
  | { readonly ok: false; readonly message: string };

export function resolveStarterPreset(options: {
  admin?: boolean;
  blog?: boolean;
  saas?: boolean;
  cli?: boolean;
  starter?: boolean;
}): StarterPresetResolution {
  const chosen: StarterPresetId[] = [];
  if (options.cli === true) chosen.push('cli');
  if (options.blog === true) chosen.push('blog');
  if (options.saas === true) chosen.push('saas');
  if (options.admin === true) chosen.push('admin');
  if (options.starter === true) chosen.push('starter');

  if (chosen.length > 1) {
    return { ok: false, message: `starter shape flags conflict: ${chosen.join(', ')}` };
  }
  const id = chosen[0] ?? 'starter';
  const preset = STARTER_PRESETS.find((candidate) => candidate.id === id);
  return preset === undefined
    ? { ok: false, message: `unknown starter shape: ${id}` }
    : { ok: true, preset };
}

/** Resolve the full feature graph for a meta module, dependencies first. */
export function resolveStarterFeatures(preset: StarterPreset): readonly StarterFeature[] {
  const byId = new Map(STARTER_FEATURES.map((feature) => [feature.id, feature]));
  const resolved: StarterFeature[] = [];
  const visiting = new Set<StarterFeatureId>();
  const done = new Set<StarterFeatureId>();

  const visit = (id: StarterFeatureId): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      throw new TypeError('starter feature graph contains a cycle');
    }
    const feature = byId.get(id);
    if (feature === undefined) {
      throw new TypeError('starter preset requires an unknown feature');
    }
    visiting.add(id);
    for (const dependency of feature.requires ?? []) {
      visit(dependency);
    }
    visiting.delete(id);
    done.add(id);
    resolved.push(feature);
  };

  for (const id of preset.requires) {
    visit(id);
  }
  return Object.freeze(resolved);
}

/** Render the `plugins.enabled` literal for a meta module's discovery policy. */
export function managedPluginsLiteral(preset: StarterPreset): string {
  if (preset.managedPlugins === 'all') return 'undefined';
  if (preset.managedPlugins === 'none') return '[]';
  return JSON.stringify(preset.managedPlugins);
}
