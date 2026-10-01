/**
 * The access matrix over the framework's own apps (`check:access`, the
 * `access` gate).
 *
 * It runs `accessMatrix` (`jsails/testing`) over:
 *
 * - one fixture app per first-party plugin that serves HTTP, assembled from
 *   the built workspaces: the framework's own surfaces (probes,
 *   introspection, the server-component transport, the public files), the
 *   dev plugin, `@jsails/auth` with every optional surface on,
 *   `@jsails/blog`, `@jsails/admin` with every first-party admin plugin,
 *   `@jsails/mail`'s preview and `@jsails/webhook`;
 * - each starter preset that serves HTTP (`starter`, `admin`, `blog`,
 *   `saas`; `cli` serves none), generated into
 *   `test-results/access/starters/<preset>`, compiled by the preset's own
 *   steps (`jsails build:meta`, `tsc`, `jsails inject:auto-imports`) and
 *   assembled in process with `createTestApp`.
 *
 * Every app resolves sessions through `accessMatrixSession`: a fixture wires
 * it into each session seam (core's resolver, the admin panel's, the auth
 * plugin's `sessionResolver`); a starter keeps its own config and only its
 * auth plugin is given the resolver. Nothing connects to a database.
 *
 * Each app's matrix is written to `test-results/access/<app>.json`. A
 * violation is ledgered per app and invariant (`<app>:<invariant>`) in
 * `scripts/expected-failures/access.json`, the pending ledger, with the
 * package that makes it hold: an unlisted violation fails, and so does a
 * listed one that holds now (remove it with the fix).
 *
 * The invariants only say something about the requests the matrix could
 * make, so the gate also fails when the matrix itself went blind:
 *
 * - an app that resolves sessions identified no caller of a credential kind
 *   its surfaces accept (the administrator persona for the cookie, the
 *   exact-scope token for a token): its session seam does not reach
 *   `accessMatrixSession`, and every rule about identified callers would be
 *   judged on no row;
 * - a surface of the route-registration snapshot app
 *   (`scripts/route-registration.mjs`, the app behind `api/routes.md`) is in
 *   no app's matrix, or is registered there differently: the fixtures are a
 *   hand-written list, and a first-party route they leave out would never be
 *   sent a cross-site request;
 * - an app registers a surface known to activate plugin code
 *   ({@link CODE_ACTIVATING_SURFACES}) without declaring it, so
 *   `locked-no-code-activation` would not look at it.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readGateLedger, ratchet } from './expected-failures.mjs';
import { collectSurfaces } from './route-registration.mjs';
import { exitStatus, run } from './subprocess.mjs';
import { repoRoot as defaultRoot } from './workspaces.mjs';

/** Where each app's matrix is written, relative to the repo root. */
export const OUTPUT_DIR = 'test-results/access';

/** The starter presets that serve HTTP; the CLI preset serves none. */
export const STARTER_PRESETS = Object.freeze(['starter', 'admin', 'blog', 'saas']);

/** The administrator every app is also asked by. */
export const ADMIN_PERSONA = Object.freeze({
  id: 'admin',
  carrier: 'cookie',
  data: Object.freeze({
    user: Object.freeze({ id: 'user-admin', email: 'admin@access-matrix.invalid', role: 'admin' }),
    role: 'admin',
  }),
});

/**
 * The surfaces that install, enable or roll back plugin code: the POST of the
 * admin `plugins` page, a slug the admin panel reserves for the marketplace's
 * manager page. No first-party plugin registers it today; an app that does
 * must declare it.
 */
export const CODE_ACTIVATING_SURFACES = Object.freeze(['POST /admin/plugins']);

/**
 * The actor that must be identified somewhere in an app that resolves
 * sessions, for each credential kind one of its surfaces accepts.
 */
export const IDENTIFIED_PER_CARRIER = Object.freeze({
  cookie: ADMIN_PERSONA.id,
  token: 'token-exact-scope',
});

/** Import a built module of the repo by its path from the root. */
function load(root, path) {
  return import(pathToFileURL(join(root, path)).href);
}

/** A seam the matrix never reaches (the probe answers in place of every handler). */
function unused(name) {
  return () => {
    throw new Error(`check-access: ${name} is route code, which the access matrix never runs`);
  };
}

/** An empty route manifest: fixtures serve no filesystem route. */
const EMPTY_MANIFEST = Object.freeze({ entries: [], byRoute: new Map(), notFound: [] });

/**
 * The first-party fixture apps: each `assemble(root)` resolves to
 * `{ target, close, sessionSeam, options }`: the `accessMatrix` target,
 * whether the app resolves sessions, and its matrix options.
 */
export const FIXTURES = Object.freeze([
  { name: 'framework', assemble: framework },
  { name: 'dev', assemble: dev },
  { name: 'auth', assemble: authFixture },
  { name: 'blog', assemble: blogFixture },
  { name: 'admin', assemble: adminFixture },
  { name: 'mail', assemble: mailFixture },
  { name: 'webhook', assemble: webhookFixture },
]);

/** The modules every fixture reads from the built core. */
async function coreModules(root) {
  const core = await load(root, 'core/dist/src/index.js');
  const testing = await load(root, 'core/dist/src/testing/index.js');
  const { adminOnly } = await load(root, 'packages/auth/dist/src/index.js');
  return { core, testing, adminOnly };
}

/**
 * An app of `plugins` (extensions run as the app runner runs them), with
 * the matrix's session resolver and `extra` app options.
 */
async function pluginApp(root, plugins, { env = process.env, extra = {} } = {}) {
  const { core, testing } = await coreModules(root);
  const runtime = await core.runExtensions(plugins, { rootDir: root, env });
  try {
    const target = await core.createApp({
      manifest: EMPTY_MANIFEST,
      services: runtime.services,
      contributions: { routes: runtime.routes, transforms: runtime.transforms },
      resolveSession: testing.accessMatrixSession,
      onError: () => undefined,
      ...extra,
    });
    return { target, close: () => runtime.close(), sessionSeam: true };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

/** The development environment, which the dev plugin and the mail preview register in. */
const DEVELOPMENT = { ...process.env, NODE_ENV: 'development' };

async function framework(root) {
  const { adminOnly } = await coreModules(root);
  const { createAssetIndex } = await load(root, 'core/dist/src/app/index.js');
  const { serverComponentsToken } = await load(
    root,
    'core/dist/src/server-components/extension.js',
  );
  const { DEFAULT_RUNTIME_LIMITS: lanes } = await load(
    root,
    'core/dist/src/server-components/runtime/admission.js',
  );
  const components = {
    name: 'components',
    setup: ({ services }) =>
      services.provide(serverComponentsToken, {
        routes: {
          update: unused('components.update'),
          upload: unused('components.upload'),
          download: unused('components.download'),
          uploadBodyBytes: 10 * 1024 * 1024 + 64 * 1024,
          laneTotalMs: {
            update: Math.max(lanes.update.totalMs, lanes.refresh.totalMs),
            upload: lanes.upload.totalMs,
            download: lanes.download.totalMs,
          },
        },
      }),
  };
  return pluginApp(root, [components], {
    extra: {
      healthPath: '/up',
      readiness: { path: '/ready', probes: {}, authorize: adminOnly },
      introspect: { enabled: true, authorize: adminOnly, sections: [], providers: [] },
      // An asset index of no file: its surface is probed like any other.
      assets: await createAssetIndex({ roots: [] }),
    },
  });
}

async function dev(root) {
  const { devPlugin } = await load(root, 'core/dist/src/dev/index.js');
  return pluginApp(root, [devPlugin({ enabled: true })], { env: DEVELOPMENT });
}

async function authFixture(root) {
  const auth = await load(root, 'packages/auth/dist/src/index.js');
  const { testing } = await coreModules(root);
  return pluginApp(root, [
    auth.authPlugin({
      registration: { enabled: true },
      passwordReset: { enabled: true },
      verification: { enabled: true },
      sendMail: unused('auth.sendMail'),
      sessionResolver: (request) => testing.accessMatrixSession(request),
      createAuth: unused('auth.createAuth'),
      apiTokens: {
        enabled: true,
        store: {
          create: unused('tokens.create'),
          list: unused('tokens.list'),
          revoke: unused('tokens.revoke'),
          resolve: async () => null,
        },
      },
    }),
  ]);
}

async function blogFixture(root) {
  const blog = await load(root, 'packages/blog/dist/src/index.js');
  const { adminOnly } = await coreModules(root);
  return pluginApp(root, [
    blog.blogPlugin({
      repository: blog.createMemoryBlogRepository(),
      createRoute: { access: adminOnly },
    }),
  ]);
}

/** The admin plugin with `adminPlugins`, behind the matrix's sessions. */
async function adminApp(root, adminPlugins, services = []) {
  const admin = await load(root, 'packages/admin/dist/src/index.js');
  const { testing, adminOnly } = await coreModules(root);
  const panel = admin.defineAdminPanel({
    resolveSession: testing.accessMatrixSession,
    authorize: adminOnly,
    adminPlugins: adminPlugins.map((plugin) => admin.withAdminAuthorize(plugin, adminOnly)),
  });
  return pluginApp(root, [...services, admin.adminPlugin(panel)]);
}

async function adminFixture(root) {
  const admin = await load(root, 'packages/admin/dist/src/index.js');
  const blog = await load(root, 'packages/blog/dist/src/index.js');
  const blogAdmin = await load(root, 'packages/blog/dist/src/admin/index.js');
  const media = await load(root, 'packages/media/dist/src/index.js');
  const mediaAdmin = await load(root, 'packages/media/dist/src/admin/index.js');
  const config = await load(root, 'packages/config/dist/src/index.js');
  const configAdmin = await load(root, 'packages/config/dist/src/admin/index.js');
  const { flagsPlugin } = await load(root, 'packages/flags/dist/src/index.js');
  const flagsAdmin = await load(root, 'packages/flags/dist/src/admin/index.js');
  const theme = await load(root, 'packages/theme/dist/src/index.js');
  const { MemoryDisk } = await load(root, 'packages/filesystem/dist/src/index.js');
  const { cachePlugin } = await load(root, 'packages/cache/dist/src/index.js');
  const repository = blog.createMemoryBlogRepository();
  const siteConfig = config.configPlugin({ sets: [blog.blogSiteConfig] });
  return adminApp(
    root,
    [
      blogAdmin.blogAdmin({ repository }),
      blogAdmin.blogThemeAdmin({
        registry: theme.createThemeRegistry({ packages: theme.builtinThemePackages }),
        repository,
      }),
      mediaAdmin.mediaAdmin({
        library: media.createMediaLibrary({
          disk: new MemoryDisk(),
          diskName: 'memory',
          metadata: media.createMemoryMediaIndex(),
        }),
      }),
      configAdmin.configAdmin(),
      flagsAdmin.flagsAdmin(),
      admin.jobsAdmin({
        metrics: { snapshot: unused('jobs.metrics') },
        failed: { list: unused('jobs.failed') },
      }),
    ],
    [cachePlugin({ store: 'memory' }), flagsPlugin(), siteConfig],
  );
}

async function mailFixture(root) {
  const mail = await load(root, 'packages/mail/dist/src/index.js');
  return pluginApp(root, [mail.mailPlugin({ allowMemory: true })], { env: DEVELOPMENT });
}

async function webhookFixture(root) {
  const webhook = await load(root, 'packages/webhook/dist/src/index.js');
  const { cachePlugin } = await load(root, 'packages/cache/dist/src/index.js');
  return pluginApp(root, [
    cachePlugin({ store: 'memory' }),
    webhook.webhookPlugin({
      endpoints: [
        {
          id: 'payments',
          path: '/webhooks/payments',
          secret: 'access-matrix-only-signing-secret',
          onEvent: unused('webhook.onEvent'),
        },
      ],
    }),
  ]);
}

/** The generated and compiled directory of `preset`. */
function starterDir(root, preset) {
  return join(root, OUTPUT_DIR, 'starters', preset);
}

/** Generate `preset` into its directory and compile it as its own build does. */
export async function buildStarter(root, preset) {
  const { createStarterFiles } = await load(root, 'core/dist/src/app/starter/index.js');
  const { files } = await createStarterFiles(preset === 'starter' ? {} : { [preset]: true });
  const dir = starterDir(root, preset);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const cli = join(root, 'core/dist/src/cli/bin.cjs');
  const tsc = join(root, 'node_modules/@typescript/native/bin/tsc');
  for (const args of [
    [cli, 'build:meta'],
    [tsc, '-p', 'tsconfig.json'],
    [cli, 'inject:auto-imports'],
  ]) {
    const outcome = await run(process.execPath, args, {
      cwd: dir,
      env: { ...process.env, JSAILS_ENV: 'test', NODE_ENV: 'test' },
      capture: true,
    });
    if (exitStatus(outcome) !== 0) {
      const output = outcome.output.trim().split('\n').slice(0, 20);
      throw new Error(
        `the ${preset} starter does not build (${args.slice(1).join(' ')}):\n    ${output.join('\n    ')}`,
      );
    }
  }
  return dir;
}

/** The auth plugin's specifier in `plugins.use`. */
const AUTH_SPECIFIER = '@jsails/auth';

/**
 * Whether `entry` of `plugins.use` is the auth plugin as an instance (not
 * its specifier), which the matrix cannot give its resolver to.
 */
function isAuthInstance(entry) {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    (entry.name === 'auth' || entry.name === AUTH_SPECIFIER)
  );
}

/**
 * `config` with the auth plugin's sessions resolved by `resolve`: every
 * session seam of a starter (its own resolver, the admin panel's) reads the
 * auth plugin's. The plugin's entry is its specifier, alone or with
 * options; an instance in its place throws, since its sessions would never
 * reach the matrix.
 */
export function withMatrixSessions(config, resolve) {
  const use = config.plugins?.use;
  if (!Array.isArray(use)) return config;
  const sessionResolver = (request) => resolve(request);
  return {
    ...config,
    plugins: {
      ...config.plugins,
      use: use.map((entry) => {
        if (entry === AUTH_SPECIFIER) return [entry, { sessionResolver }];
        if (Array.isArray(entry) && entry[0] === AUTH_SPECIFIER) {
          return [entry[0], { ...entry[1], sessionResolver }];
        }
        if (isAuthInstance(entry)) {
          throw new Error(
            `check-access: plugins.use holds the auth plugin as an instance; the access matrix can give its session resolver only to a '${AUTH_SPECIFIER}' entry`,
          );
        }
        return entry;
      }),
    },
  };
}

/**
 * Whether `config` resolves sessions: an app resolver or identity source,
 * or the auth plugin in `plugins.use`.
 */
export function hasSessionSeam(config) {
  const use = Array.isArray(config.plugins?.use) ? config.plugins.use : [];
  return (
    config.resolveSession !== undefined ||
    config.identity !== undefined ||
    use.some(
      (entry) =>
        entry === AUTH_SPECIFIER ||
        (Array.isArray(entry) && entry[0] === AUTH_SPECIFIER) ||
        isAuthInstance(entry),
    )
  );
}

/** The starter `preset`, built and assembled in process. */
async function starterApp(root, preset) {
  const dir = await buildStarter(root, preset);
  const { testing } = await coreModules(root);
  const config = (await import(pathToFileURL(join(dir, 'jsails.app.js')).href)).default;
  const target = await testing.createTestApp({
    config: withMatrixSessions(config, testing.accessMatrixSession),
    cwd: dir,
  });
  const activation = config.plugins?.activation?.mode === 'managed' ? 'managed' : 'locked';
  return {
    target,
    close: () => target.close(),
    sessionSeam: hasSessionSeam(config),
    options: { activation },
  };
}

/** Every app the gate judges: the fixtures, then the starters. */
export function accessApps() {
  return [
    ...FIXTURES,
    ...STARTER_PRESETS.map((preset) => ({
      name: `starter-${preset}`,
      assemble: (root) => starterApp(root, preset),
    })),
  ];
}

/**
 * The matrix of every app in `apps` from the built workspaces under `root`:
 * `{ name, surfaces, rows, violations, sessionSeam, codeActivating, ms }`
 * each, its matrix written under {@link OUTPUT_DIR}.
 */
export async function collectMatrices(root, apps = accessApps()) {
  // The matrix judges apps in the test environment, as their own tests do.
  if (process.env.NODE_ENV === undefined && process.env.JSAILS_ENV === undefined) {
    process.env.JSAILS_ENV = 'test';
    process.env.NODE_ENV = 'test';
  }
  const { testing } = await coreModules(root);
  const results = [];
  mkdirSync(join(root, OUTPUT_DIR), { recursive: true });
  for (const app of apps) {
    const assembled = await app.assemble(root);
    try {
      const started = performance.now();
      const matrix = await testing.accessMatrix(assembled.target, {
        personas: [ADMIN_PERSONA],
        ...assembled.options,
      });
      const ms = Math.round(performance.now() - started);
      writeFileSync(
        join(root, OUTPUT_DIR, `${app.name}.json`),
        `${JSON.stringify({ rows: matrix.rows, violations: matrix.violations }, null, 2)}\n`,
      );
      results.push({
        name: app.name,
        surfaces: matrix.surfaces,
        rows: matrix.rows,
        violations: matrix.violations,
        sessionSeam: assembled.sessionSeam,
        codeActivating: assembled.options?.codeActivating ?? [],
        ms,
      });
    } finally {
      await assembled.close();
    }
  }
  return results;
}

/** The pending-ledger ids `matrices` violate: `<app>:<invariant>`, once each. */
export function violationIds(matrices) {
  return [
    ...new Set(
      matrices.flatMap(({ name, violations }) =>
        violations.map((violation) => `${name}:${violation.invariant}`),
      ),
    ),
  ].sort();
}

/** A violation as one line. */
function describeViolation(app, violation) {
  const request =
    violation.method === null
      ? ''
      : ` ${violation.method} as ${violation.actor} (${violation.origin} origin)`;
  return `${app}: ${violation.invariant} on ${violation.surface}${request}`;
}

/**
 * The failures of an app whose session seam the matrix did not reach: it
 * resolves sessions, a surface accepts a credential kind, and the actor
 * presenting that kind was identified on no row.
 */
export function identityFailures(matrix) {
  if (!matrix.sessionSeam) return [];
  const failures = [];
  for (const [carrier, actor] of Object.entries(IDENTIFIED_PER_CARRIER)) {
    const accepted = matrix.surfaces.some((surface) => surface.credentials.includes(carrier));
    const identified = matrix.rows.some((row) => row.actor === actor && row.identified);
    if (accepted && !identified) {
      failures.push(
        `${matrix.name}: no ${actor} request was identified, although the app resolves sessions and a surface accepts a ${carrier}; its session seam does not reach accessMatrixSession, so the rules about identified callers were judged on no row`,
      );
    }
  }
  return failures;
}

/** What a surface is judged as: its id, kind, owner, credentials and access kind. */
function registrationKey(surface) {
  const credentials = surface.credentials.length === 0 ? 'none' : surface.credentials.join(',');
  return `${surface.id} surface=${surface.kind} credentials=${credentials} access=${surface.access.kind} ${surface.owner}`;
}

/**
 * The failures for the route-registration snapshot's surfaces that no
 * matrix judged as registered there: each one, as the snapshot app
 * registers it, must be a surface of some app in `matrices`.
 */
export function coverageFailures(snapshot, matrices) {
  const judged = new Set(
    matrices.flatMap((matrix) => matrix.surfaces.map((surface) => registrationKey(surface))),
  );
  return snapshot
    .map((surface) => registrationKey(surface))
    .filter((key) => !judged.has(key))
    .map(
      (key) =>
        `${key} is registered by the route-registration snapshot app and judged by no access-matrix app as registered there; add it to a fixture in scripts/check-access.mjs, configured as in scripts/route-registration.mjs`,
    );
}

/**
 * The failures of an app that registers a surface known to activate plugin
 * code without declaring it to the matrix.
 */
export function codeActivationFailures(matrix) {
  const declared = new Set(matrix.codeActivating);
  return matrix.surfaces
    .filter((surface) => CODE_ACTIVATING_SURFACES.includes(surface.id) && !declared.has(surface.id))
    .map(
      (surface) =>
        `${matrix.name}: registers ${surface.id}, which activates plugin code, without declaring it codeActivating`,
    );
}

/**
 * Judge `matrices` against the pending ledger under `root` and
 * `snapshot`, the route-registration app's surfaces: the failure messages,
 * empty when every violation is listed, every listed one still occurs, and
 * the matrix saw what it judges.
 */
export function judge(root, matrices, snapshot) {
  const ledger = readGateLedger('access', {
    dir: join(root, 'scripts', 'expected-failures'),
    root,
  });
  const { unlisted, fixed } = ratchet(ledger, violationIds(matrices));
  const failures = [];
  for (const id of unlisted) {
    const [app, invariant] = id.split(':');
    const examples = matrices
      .find((matrix) => matrix.name === app)
      .violations.filter((violation) => violation.invariant === invariant);
    failures.push(
      `${id} is violated and not pending in access.json (${examples.length} row(s)); fix it, or ledger it with the package that makes it hold:`,
      ...examples.slice(0, 5).map((violation) => `    ${describeViolation(app, violation)}`),
    );
  }
  for (const id of fixed) {
    failures.push(`fixed: ${id} holds now; remove it from scripts/expected-failures/access.json`);
  }
  for (const matrix of matrices) {
    failures.push(...identityFailures(matrix), ...codeActivationFailures(matrix));
  }
  failures.push(...coverageFailures(snapshot, matrices));
  return failures;
}

/**
 * `collect` is the matrix source and `snapshot` the route-registration
 * app's surfaces (a test passes its own).
 */
export async function main({
  root = defaultRoot,
  collect = collectMatrices,
  snapshot = collectSurfaces,
} = {}) {
  const matrices = await collect(root);
  const failures = judge(root, matrices, await snapshot(root));
  const summary = matrices.map(
    ({ name, rows, violations, ms }) =>
      `${name}: ${rows.length} requests, ${violations.length} violation(s), ${ms} ms`,
  );
  return { status: failures.length === 0 ? 0 : 1, messages: [...summary, ...failures] };
}

if (import.meta.main) {
  const { status, messages } = await main();
  for (const message of messages) (status === 0 ? console.log : console.error)(message);
  process.exitCode = status;
}
