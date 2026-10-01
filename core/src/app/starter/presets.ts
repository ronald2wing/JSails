/**
 * Starter meta-module catalog.
 *
 * The five starter shapes are Magento-style meta modules: they own no
 * implementation. A preset only declares the feature modules it requires. Each
 * feature module owns its own template contributions, package dependencies,
 * app/database config provider, and guide text, so adding a shape is
 * data-only.
 *
 * Every preset generates a developer-mode app: plugins run only from
 * `plugins.use`, and no preset activates plugin code from database state or
 * ships the admin plugin manager.
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
  /** The database config provider; highest priority wins. */
  readonly databaseConfig?: {
    readonly template: string;
    readonly base: StarterTemplateBase;
    readonly priority: number;
  };
  /**
   * Environment variable names the generated `jamal.config.ts` forwards on the
   * clear channel, each from the deploy secret of the same name. A feature
   * whose runtime switches on a variable lists it here so a production deploy
   * either carries it or stops with `missing_secret`, rather than silently
   * running with the feature off.
   */
  readonly deployEnv?: readonly string[];
  /**
   * Whether this feature ships the production image a `jamal deploy` builds:
   * the `Dockerfile` and `.dockerignore` rendered by `app/dockerfile.ts`, the
   * generator behind `jsails make:dockerfile`, rather than a template copy.
   */
  readonly productionImage?: boolean;
}

/** A meta module: only its requirements. */
export interface StarterPreset {
  /** Stable preset id. */
  readonly id: StarterPresetId;
  /** Human description of the shape. */
  readonly description: string;
  /** Shape category, used to select the guide builder. */
  readonly kind: StarterKind;
  /** The feature modules this meta module requires. */
  readonly requires: readonly StarterFeatureId[];
}

/**
 * The dependency range a generated app declares for every first-party
 * `@jsails/*` package. The framework and its packages share a major version,
 * so a caret range on that major lets npm pick any compatible minor or patch:
 * an exact pin would strand a generated app the moment `jsails` ships a patch
 * that a package has not been republished for. This constant is the single
 * declaration of that range: no template names a first-party version, and a
 * test checks that it is `^<framework major>.0.0`, that every workspace
 * package version satisfies it, and that every workspace's peer and
 * dependency on another first-party package uses exactly this range.
 */
export const FIRST_PARTY_PACKAGE_RANGE = '^1.0.0';

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
  'components/load-more-feed.tsx',
  'components/task-list.tsx',
  '.env.auth.example.template',
  '.gitignore.template',
  'jamal.config.ts.template',
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
  'pages/load-more.tsx',
  'pages/login.tsx.template',
  'pages/register.tsx.template',
  'pages/tasks.tsx',
  'playwright.config.ts.template',
  'scripts/auth-migrate.mjs.template',
  'scripts/create-user.mjs.template',
  'scripts/db-push.mjs.template',
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
  'ui/styles.css',
  'ui/task-notes.ts',
  'vite.config.js.template',
];

const BLOG_TEMPLATE_FILES: readonly string[] = ['pages/blog/[slug].tsx', 'server/theme.ts'];

const SAAS_TEMPLATE_FILES: readonly string[] = ['models/project.ts.template'];

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
  'pages/load-more.tsx',
  'pages/tags/[term].tsx',
  'pages/tags/index.tsx',
  'scripts/generate-feeds.mjs',
  'server/content.ts',
  'shared/site.ts',
  'tsconfig.client.json.template',
  'tsconfig.json.template',
  'ui/components.tsx',
  'ui/layout.tsx',
  'ui/load-more.tsx',
  'ui/styles.css',
  'vite.config.js.template',
];

const CLI_TEMPLATE_FILES: readonly string[] = [
  '.gitignore.template',
  'app/application-command.ts.template',
  'commands/about.ts.template',
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

const ADMIN_DATABASE = Object.freeze({
  template: 'jsails.database.js.template',
  base: 'starter-web',
  priority: 10,
} as const);

const BLOG_DATABASE = Object.freeze({
  template: 'jsails.database.blog.js.template',
  base: 'starter-web',
  priority: 20,
} as const);

const SAAS_DATABASE = Object.freeze({
  template: 'jsails.database.js.template',
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
    dependencies: Object.freeze({ '@jsails/content': FIRST_PARTY_PACKAGE_RANGE }),
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
      '@jsails/cache': FIRST_PARTY_PACKAGE_RANGE,
      '@jsails/filesystem': FIRST_PARTY_PACKAGE_RANGE,
      // Local services (`jamal up`) and deploys read `jamal.config.ts`. A
      // deploy runs from a production install (CI with `npm ci --omit=dev`, or
      // an operator's checkout), so the deploy tool and its config's imports
      // must be a runtime dependency.
      '@jsails/jamal': FIRST_PARTY_PACKAGE_RANGE,
      '@jsails/live': FIRST_PARTY_PACKAGE_RANGE,
      '@jsails/mail': FIRST_PARTY_PACKAGE_RANGE,
    }),
    // `jamal deploy` builds the app from a Dockerfile in the project root.
    productionImage: true,
  }),
  Object.freeze({
    id: 'auth',
    description: 'Local email/password sign-in through `@jsails/auth`.',
    dependencies: Object.freeze({ '@jsails/auth': FIRST_PARTY_PACKAGE_RANGE }),
  }),
  Object.freeze({
    id: 'editor',
    description: 'The ProseMirror rich-text editor island.',
    dependencies: Object.freeze({ '@jsails/editor': FIRST_PARTY_PACKAGE_RANGE }),
  }),
  Object.freeze({
    id: 'theme',
    description: 'Theme token and package activation support.',
    dependencies: Object.freeze({ '@jsails/theme': FIRST_PARTY_PACKAGE_RANGE }),
  }),
  Object.freeze({
    id: 'admin',
    description: 'The first-party admin panel mounted at `/admin`.',
    requires: Object.freeze(['editor', 'theme'] as readonly StarterFeatureId[]),
    dependencies: Object.freeze({ '@jsails/admin': FIRST_PARTY_PACKAGE_RANGE }),
    appConfig: ADMIN_CONFIG,
    databaseConfig: ADMIN_DATABASE,
  }),
  Object.freeze({
    id: 'blog',
    description: 'The first-party blog CMS, its admin surface, and theme activation.',
    requires: Object.freeze(['admin'] as readonly StarterFeatureId[]),
    templates: Object.freeze({
      base: 'starter-web' as const,
      files: Object.freeze(BLOG_TEMPLATE_FILES),
    }),
    dependencies: Object.freeze({
      '@jsails/blog': FIRST_PARTY_PACKAGE_RANGE,
      '@jsails/config': FIRST_PARTY_PACKAGE_RANGE,
    }),
    appConfig: BLOG_CONFIG,
    databaseConfig: BLOG_DATABASE,
  }),
  Object.freeze({
    id: 'media',
    description: 'The disk-backed media library and its admin surface.',
    dependencies: Object.freeze({ '@jsails/media': FIRST_PARTY_PACKAGE_RANGE }),
  }),
  Object.freeze({
    id: 'tenancy',
    description: 'Opt-in multi-tenancy through `@jsails/tenancy`.',
    dependencies: Object.freeze({ '@jsails/tenancy': FIRST_PARTY_PACKAGE_RANGE }),
  }),
  Object.freeze({
    id: 'flags',
    description: 'Feature flags through `@jsails/flags`.',
    dependencies: Object.freeze({ '@jsails/flags': FIRST_PARTY_PACKAGE_RANGE }),
  }),
  Object.freeze({
    id: 'saas-config',
    description: 'The SaaS app/database config layer (overrides the admin config).',
    requires: Object.freeze(['admin'] as readonly StarterFeatureId[]),
    // A tenant-owned example model; `db:push` harvests it from the compiled
    // model registry, so the database config needs no entry for it.
    templates: Object.freeze({
      base: 'starter-web' as const,
      files: Object.freeze(SAAS_TEMPLATE_FILES),
    }),
    appConfig: SAAS_CONFIG,
    databaseConfig: SAAS_DATABASE,
    // The tenant resolver is on only when TENANT_ROOT_DOMAIN is set.
    deployEnv: Object.freeze(['TENANT_ROOT_DOMAIN']),
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
  }),
  Object.freeze({
    id: 'admin',
    description: 'A server-rendered app with auth, the admin panel, and server components.',
    kind: 'web',
    requires: Object.freeze(['web-base', 'auth', 'admin'] as readonly StarterFeatureId[]),
  }),
  Object.freeze({
    id: 'blog',
    description: 'A standalone blog CMS with admin, blog, and media; no tenancy.',
    kind: 'web',
    requires: Object.freeze(['web-base', 'auth', 'blog', 'media'] as readonly StarterFeatureId[]),
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
  }),
  Object.freeze({
    id: 'cli',
    description: 'A Laravel-Zero-style CLI-only command project.',
    kind: 'cli',
    requires: Object.freeze(['cli'] as readonly StarterFeatureId[]),
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
