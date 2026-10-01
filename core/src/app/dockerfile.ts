/**
 * The production image of a server-rendered JSails app: the one generator of
 * its `Dockerfile` and `.dockerignore`.
 *
 * `jsails make:dockerfile` writes both files into an existing project, and the
 * server-rendered starters (`--admin`, `--saas`, `--blog`) generate them
 * through the same two functions, so a fresh app and a retrofitted one deploy
 * the same image. `jamal deploy` builds it with `docker buildx build` from the
 * project root and has no generator of its own; its `missing_dockerfile`
 * preflight points at `make:dockerfile`.
 *
 * The image matches what the deploy expects of it:
 *
 * - It listens on {@link APP_IMAGE_PORT} on every interface (`JSAILS_PORT`,
 *   `JSAILS_HOST`), the port kamal-proxy targets. `jamal deploy` passes the
 *   same values on `docker run`; the image sets them too so a container started
 *   without them (`local.app: 'image'`, a plain `docker run`) still answers.
 * - `node` is on `PATH`: the deploy's health step runs `docker exec <container>
 *   node -e "fetch(...)"` against `127.0.0.1:3000<health path>`. The image's
 *   own `HEALTHCHECK` runs the same probe, so `docker ps` and Compose's
 *   `service_healthy` agree with the deploy's verdict.
 * - `node` is PID 1 (the base image's entrypoint `exec`s the command), and
 *   `jsails serve` drains and exits on SIGTERM, which is what `docker stop`
 *   sends; no init process is added.
 *
 * Three stages share one base, so native modules compiled while installing run
 * on the same libc in the runtime stage: `deps` installs the production
 * dependencies, `build` installs everything and runs the app's `npm run build`
 * (compiled server output, `.jsails/`, the client bundle), and the runtime
 * stage copies the built tree without its `node_modules` over the production
 * ones. The app's files stay root-owned and read-only to the non-root `node`
 * user; only `storage/` (the default local disk) is writable. No build
 * argument or secret enters the image: the `.dockerignore` keeps `.env*`,
 * `.jamal/`, and credential keys out of the build context, the runtime stage's
 * copy excludes them again, and the app reads its secrets from the environment
 * `jamal deploy` gives the container.
 *
 * Both renderers are pure: the same options give the same bytes.
 */

import { DEFAULT_HEALTH_PATH } from './config/defaults.js';
import { resolveHealthPath } from './config/paths.js';

/**
 * The Node major the image runs: the framework's `engines.node` floor (and the
 * `.nvmrc` line), so the image runs the Node line the app was written for.
 */
export const APP_IMAGE_NODE_MAJOR = 26;

/**
 * The base image every stage starts from. The Debian release is named, so a
 * new Debian default never changes the base libc under an app between two
 * builds; the floating Node major still picks up patch releases on rebuild.
 */
export const APP_IMAGE_BASE: string = `node:${APP_IMAGE_NODE_MAJOR}-trixie-slim`;

/** The port the app listens on inside the container; `jamal deploy` targets it. */
export const APP_IMAGE_PORT = 3000;

/**
 * What the runtime stage leaves out of the built tree: the build stage's full
 * `node_modules` (the production set comes from the `deps` stage), and every
 * secret and the local state (`storage/`) the `.dockerignore` keeps out of the
 * context. The repetition is
 * deliberate: the build stage copies the whole context, so an edited or
 * missing `.dockerignore`, or a build run against another context, would
 * otherwise carry an `.env` or a credentials key into the shipped image.
 */
const RUNTIME_COPY_EXCLUDES = Object.freeze([
  'node_modules',
  '.env',
  '.env.*',
  '.jamal',
  'config/credentials/*.key',
  'storage',
]);

/** Per-probe timeout of the image health check, matching jamal's default. */
const HEALTH_TIMEOUT_MS = 5000;

/** Options for {@link renderAppDockerfile}. */
export interface AppDockerfileOptions {
  /**
   * The app's health path (`healthPath` in the app config), probed by the
   * image's `HEALTHCHECK`. Defaults to `/up`; `false` (an app that disabled
   * its health route) omits the `HEALTHCHECK`.
   */
  readonly healthPath?: string | false;
}

/**
 * The health probe, as the argument to `node -e`: one request to the health
 * path on the app's own port, exiting 0 only on a 2xx answer. It reads
 * `JSAILS_PORT` at probe time so a container started on another port is still
 * probed where it listens.
 */
function healthProbeScript(path: string): string {
  // A valid health path holds no backslash, so escaping `'` is all a
  // single-quoted literal needs (double quotes would be escaped again by the
  // JSON exec form around the script).
  const literal = `'${path.replaceAll("'", "\\'")}'`;
  return (
    `fetch('http://127.0.0.1:'+(process.env.JSAILS_PORT||${APP_IMAGE_PORT})+${literal},` +
    `{signal:AbortSignal.timeout(${HEALTH_TIMEOUT_MS})})` +
    '.then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))'
  );
}

/** A Dockerfile exec-form argument list (a JSON array). */
function execForm(argv: readonly string[]): string {
  return `[${argv.map((arg) => JSON.stringify(arg)).join(', ')}]`;
}

/**
 * Render the production `Dockerfile`. A health path that the app config would
 * refuse throws the config's own value-free `AppConfigError`.
 */
export function renderAppDockerfile(options: AppDockerfileOptions = {}): string {
  const healthPath = resolveHealthPath(options.healthPath ?? DEFAULT_HEALTH_PATH);
  const healthcheck =
    healthPath === undefined
      ? [
          '# The app disabled its health route, so the image declares no HEALTHCHECK;',
          '# point `health.path` in jamal.config.ts at a route that answers 2xx.',
        ]
      : [
          `# The same probe \`jamal deploy\` runs inside a new container before it`,
          `# switches traffic to it. Keep the path equal to \`health.path\` in`,
          `# jamal.config.ts and \`healthPath\` in the app config.`,
          `HEALTHCHECK --interval=30s --timeout=${HEALTH_TIMEOUT_MS / 1000}s --start-period=30s --start-interval=2s --retries=3 \\`,
          `  CMD ${execForm(['node', '-e', healthProbeScript(healthPath)])}`,
        ];
  return [
    '# syntax=docker/dockerfile:1',
    '# The production image of this JSails app, generated by `jsails make:dockerfile`.',
    '# `jamal deploy` builds it from the project root; edit it freely.',
    '#',
    '# The build needs a committed package-lock.json (`npm ci`). No secret or build',
    '# argument enters the image: .dockerignore keeps .env*, .jamal/, and credential',
    '# keys out of the build context, and the app reads its secrets from the',
    '# environment the container is started with.',
    '',
    `FROM ${APP_IMAGE_BASE} AS base`,
    'WORKDIR /app',
    '',
    '# Production dependencies only; the npm cache stays in a BuildKit cache mount.',
    'FROM base AS deps',
    'COPY package.json package-lock.json ./',
    'RUN --mount=type=cache,target=/root/.npm,sharing=locked \\',
    '    npm ci --omit=dev --no-audit --no-fund',
    '',
    '# Every dependency, then the app build: compiled server output, .jsails/, and',
    '# the client bundle.',
    'FROM base AS build',
    'COPY package.json package-lock.json ./',
    'RUN --mount=type=cache,target=/root/.npm,sharing=locked \\',
    '    npm ci --no-audit --no-fund',
    'COPY . .',
    'RUN npm run build',
    '',
    'FROM base',
    `ENV JSAILS_ENV=production NODE_ENV=production JSAILS_HOST=0.0.0.0 JSAILS_PORT=${APP_IMAGE_PORT}`,
    '# Root-owned and read-only to the app; only storage/ (the default local disk)',
    '# is writable by the unprivileged `node` user. The exclusions repeat the',
    '# secrets and local state .dockerignore keeps out, so a context that still',
    '# holds them never ships them.',
    'COPY --from=deps /app/node_modules ./node_modules',
    'COPY --from=build \\',
    ...RUNTIME_COPY_EXCLUDES.map((pattern) => `    --exclude=${pattern} \\`),
    '    /app ./',
    'RUN install -d -o node -g node storage',
    'USER node',
    `EXPOSE ${APP_IMAGE_PORT}`,
    ...healthcheck,
    '# node is PID 1 and `jsails serve` exits cleanly on the SIGTERM `docker stop` sends.',
    `CMD ${execForm(['node', 'node_modules/.bin/jsails', 'serve'])}`,
    '',
  ].join('\n');
}

/**
 * Render the `.dockerignore`: what never enters the build context. Secrets and
 * local state are listed first because leaving them out is a security
 * property, not an optimization; build output and dependencies are rebuilt
 * inside the image, so a stale host copy can never shadow them.
 */
export function renderAppDockerignore(): string {
  return [
    '# Generated by `jsails make:dockerfile`: what never enters the image build.',
    '',
    '# Secrets and local state.',
    '.env',
    '.env.*',
    '.jamal/',
    'config/credentials/*.key',
    'storage/',
    '*.sqlite',
    '*.sqlite3',
    '*.sqlite-*',
    '*.db',
    '*.db-*',
    '',
    '# Version control and deploy tooling.',
    '.git/',
    'jamal.config.ts',
    'jamal.config.js',
    'Dockerfile',
    '.dockerignore',
    '',
    '# Dependencies and build output, rebuilt inside the image.',
    'node_modules/',
    'dist/',
    'out/',
    'public/assets/',
    '.jsails/',
    '.content-cache/',
    '',
    '# Tests and their output.',
    'test/',
    'test-results/',
    'playwright-report/',
    'coverage/',
    'playwright.config.ts',
    '',
  ].join('\n');
}
