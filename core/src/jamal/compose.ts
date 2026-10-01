/**
 * Jamal local Docker Compose planner.
 *
 * {@link planLocal} turns a normalized {@link JamalConfig} into the single
 * `.jamal/compose.yml` that `jamal dev --write` materializes for local
 * development. It is pure: it reads only its argument, writes no file, reads no
 * environment variable, and its output is deterministic (stable key order, no
 * timestamps, no network or clock access).
 *
 * Every backing service runs a pinned image with a healthcheck probe, a named
 * data volume, and a private bridge network. `mariadb`/`postgres`/`valkey`
 * take their image, port, volume, and data directory from the conventions
 * table shared with the production accessory planner (`service-conventions.ts`)
 * so a local container matches its production counterpart. A backing service
 * publishes no port unless `config.local.ports` lists it, and then only on
 * loopback (`127.0.0.1:<host>:<internal>`).
 *
 * The `mailpit`/`adminer` service types are dev-only tools: they are rendered
 * after the backing services with fixed loopback ports (mailpit 1025+8025,
 * adminer 8080), never create a named data volume, and never join the
 * application service's `depends_on` graph — a tool is a convenience for a
 * human, not a dependency of the app.
 *
 * `config.local.app` decides whether the app itself runs in the project:
 *
 * - `host` (the default): no app service; the app runs on the developer's
 *   machine and reaches the services through their loopback ports.
 * - `dev`: a Sail-style container. A small generated image (`dev.Dockerfile`)
 *   runs as the developer's own user id, so files the app writes into the
 *   mounted project stay owned by the developer. The project is mounted at
 *   `/app`, `node_modules` lives in a named volume (native modules built for
 *   the host OS would not load in Linux), and `jsails dev` reloads on save.
 *   `JSAILS_HOST`/`JSAILS_PORT` make it listen on every interface inside the
 *   container on a fixed port; only the loopback-published port on the host
 *   reaches it. The container gets no `config.env`
 *   values: it reads `.env` files and credentials from the mounted project
 *   exactly as the host would, so `jamal test` still selects the test
 *   database through `.env.testing`.
 * - `image`: the project's own Dockerfile, the way production runs it. With no
 *   project mounted it cannot read `.env`, so every `config.env` entry is
 *   rendered as `${KEY}` for Docker Compose to interpolate from the host
 *   environment at container start — the value is never written and is never
 *   read by this module.
 *
 * In both container modes the variables that locate a service
 * (`DATABASE_HOST`, `VALKEY_URL`, ...) name the service on the Compose network
 * instead of the host's loopback address, which would point at the container
 * itself.
 *
 * Compose resolves relative paths against the directory of the Compose file,
 * `.jamal/`, so a path into the project is written relative to that folder.
 */

import { posix } from 'node:path';

import { JamalConfigError, type JamalConfig, type JamalServiceType } from './config/index.js';
import { SERVICE_CONVENTIONS, type ServiceConvention } from './service-conventions.js';

/** Relative path of the generated Compose file. */
export const LOCAL_COMPOSE_PATH = '.jamal/compose.yml';

/** Relative path of the generated dev-container image definition (`local.app: 'dev'`). */
export const LOCAL_DEV_DOCKERFILE_PATH = '.jamal/dev.Dockerfile';

/** Compose service key for the application container. */
export const LOCAL_APP_SERVICE = 'app';
const APP_SERVICE = LOCAL_APP_SERVICE;

/** The port `jsails dev` listens on inside the dev container. */
const DEV_APP_PORT = 3000;

/** The Node image the dev container builds on; the same line as the generated production images. */
const DEV_NODE_IMAGE = 'node:26-bookworm-slim';

/** Named volume holding the dev container's `node_modules`. */
const DEV_NODE_MODULES_VOLUME = 'node-modules';

/** The user id fallback when the host has none (Windows): the Node image's `node` user. */
const DEFAULT_HOST_USER = Object.freeze({ uid: 1000, gid: 1000 });

/** Port-name aliases that target the application service rather than a backing service. */
const APP_PORT_NAMES: ReadonlySet<string> = new Set(['web', 'app']);

/** Private bridge network every service joins. */
const NETWORK = 'jsails';

/**
 * One backing-service environment entry: the container variable name plus the
 * host variable it interpolates from, or a fixed literal. A secret-backed value
 * is always rendered as `${hostKey}` — never a literal — so no secret reaches
 * the emitted file; a fixed flag (e.g. `discovery.type=single-node`) is rendered
 * verbatim because it is configuration, not a credential.
 */
interface ServiceEnvEntry {
  readonly key: string;
  readonly hostKey?: string;
  readonly value?: string;
}

/** A backing service's container convention plus its Compose healthcheck and environment. */
interface ComposeServiceConvention extends ServiceConvention {
  readonly healthcheckTest: string;
  readonly interval: string;
  readonly timeout: string;
  readonly retries: string;
  /**
   * Container environment entries. A database image aborts on first boot when
   * its credentials are unset, so these are required for mariadb/postgres;
   * valkey needs none locally.
   */
  readonly environment: readonly ServiceEnvEntry[];
  /** Container command override, for images whose data dir is a CLI flag. */
  readonly command?: string;
}

const MARIADB: ComposeServiceConvention = {
  ...SERVICE_CONVENTIONS.mariadb,
  healthcheckTest: '["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]',
  interval: '10s',
  timeout: '5s',
  retries: '10',
  environment: [
    { key: 'MARIADB_DATABASE', hostKey: 'DATABASE_NAME' },
    { key: 'MARIADB_USER', hostKey: 'DATABASE_USER' },
    { key: 'MARIADB_PASSWORD', hostKey: 'DATABASE_PASSWORD' },
    { key: 'MARIADB_ROOT_PASSWORD', hostKey: 'DATABASE_ROOT_PASSWORD' },
  ],
};

const POSTGRES: ComposeServiceConvention = {
  ...SERVICE_CONVENTIONS.postgres,
  healthcheckTest: '["CMD-SHELL", "pg_isready -U ${DATABASE_USER} -d ${DATABASE_NAME}"]',
  interval: '10s',
  timeout: '5s',
  retries: '10',
  environment: [
    { key: 'POSTGRES_DB', hostKey: 'DATABASE_NAME' },
    { key: 'POSTGRES_USER', hostKey: 'DATABASE_USER' },
    { key: 'POSTGRES_PASSWORD', hostKey: 'DATABASE_PASSWORD' },
    // PGDATA points at a subdirectory of the mount so the image's own VOLUME
    // declaration does not shadow the named volume.
    { key: 'PGDATA', hostKey: 'PGDATA' },
  ],
};

const VALKEY: ComposeServiceConvention = {
  ...SERVICE_CONVENTIONS.valkey,
  healthcheckTest: '["CMD", "valkey-cli", "ping"]',
  interval: '5s',
  timeout: '3s',
  retries: '5',
  environment: [],
};

const MEILISEARCH: ComposeServiceConvention = {
  image: 'getmeili/meilisearch:v1.12',
  port: 7700,
  volume: 'meilisearch-data',
  dataDir: '/meili_data',
  healthcheckTest: '["CMD", "wget", "--spider", "-q", "http://localhost:7700/health"]',
  interval: '10s',
  timeout: '5s',
  retries: '10',
  environment: [
    { key: 'MEILI_MASTER_KEY', hostKey: 'MEILISEARCH_KEY' },
    { key: 'MEILI_ENV', value: 'development' },
  ],
};

const TYPESENSE: ComposeServiceConvention = {
  image: 'typesense/typesense:27.1',
  port: 8108,
  volume: 'typesense-data',
  dataDir: '/data',
  healthcheckTest: '["CMD", "wget", "--spider", "-q", "http://localhost:8108/health"]',
  interval: '10s',
  timeout: '5s',
  retries: '10',
  environment: [{ key: 'TYPESENSE_API_KEY', hostKey: 'TYPESENSE_API_KEY' }],
  command: '--data-dir /data --api-key ${TYPESENSE_API_KEY}',
};

const OPENSEARCH: ComposeServiceConvention = {
  image: 'opensearchproject/opensearch:2.19.0',
  port: 9200,
  volume: 'opensearch-data',
  dataDir: '/usr/share/opensearch/data',
  healthcheckTest: '["CMD-SHELL", "curl -fs http://localhost:9200/_cluster/health"]',
  interval: '10s',
  timeout: '5s',
  retries: '10',
  environment: [
    { key: 'discovery.type', value: 'single-node' },
    { key: 'DISABLE_SECURITY_PLUGIN', value: 'true' },
    { key: 'OPENSEARCH_JAVA_OPTS', value: '-Xms512m -Xmx512m' },
  ],
};

/**
 * Local S3-compatible object store. SeaweedFS (Apache-2.0, actively
 * maintained) is chosen over MinIO because MinIO's community edition is
 * archived and its images are absent from Docker Hub/Quay, so it cannot be
 * pulled deterministically; SeaweedFS publishes pinned semver
 * tags (`chrislusf/seaweedfs`). `weed server -s3` starts master, volume, filer,
 * and the S3 gateway in one process; the gateway speaks S3 natively on port
 * 8333, which is what `S3Disk`/`createDiskFromEnv` consume.
 *
 * Credentials are the AWS-standard variables the S3 gateway reads as its
 * "development setup" fallback; they interpolate from the host's
 * `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (the names `createDiskFromEnv`
 * reads), so the app and the store share one credential pair. With at least one
 * identity configured the gateway runs in Authentication-Required mode.
 *
 * The bucket is not created here (Compose conventions are pure config): a
 * caller that needs a concrete bucket creates one via the S3 `CreateBucket`
 * API against this endpoint.
 */
const S3: ComposeServiceConvention = {
  image: 'chrislusf/seaweedfs:3.91',
  port: 8333,
  volume: 'seaweedfs-data',
  dataDir: '/data',
  healthcheckTest: '["CMD", "wget", "--spider", "-q", "http://localhost:8333/"]',
  interval: '10s',
  timeout: '5s',
  retries: '10',
  environment: [
    { key: 'AWS_ACCESS_KEY_ID', hostKey: 'S3_ACCESS_KEY_ID' },
    { key: 'AWS_SECRET_ACCESS_KEY', hostKey: 'S3_SECRET_ACCESS_KEY' },
  ],
  command: 'server -s3 -s3.port 8333',
};

/** Dev-only tool conventions: fixed loopback ports, no data volume, optional probe. */
interface DevToolConvention {
  readonly image: string;
  readonly ports: readonly number[];
  readonly healthcheckTest?: string;
  readonly interval?: string;
  readonly timeout?: string;
  readonly retries?: string;
}

const MAILPIT: DevToolConvention = {
  image: 'axllent/mailpit:v1.31.4',
  ports: [1025, 8025],
  healthcheckTest: '["CMD", "/mailpit", "readyz"]',
  interval: '15s',
  timeout: '5s',
  retries: '5',
};

const ADMINER: DevToolConvention = {
  image: 'adminer:6.1.1-standalone',
  ports: [8080],
};

/** True for a dev-only tool rather than a backing service the app depends on. */
function isDevTool(type: JamalServiceType | undefined): boolean {
  return type === 'mailpit' || type === 'adminer';
}

function convention(type: JamalServiceType): ComposeServiceConvention {
  switch (type) {
    case 'mariadb':
      return MARIADB;
    case 'postgres':
      return POSTGRES;
    case 'valkey':
      return VALKEY;
    case 'meilisearch':
      return MEILISEARCH;
    case 'typesense':
      return TYPESENSE;
    case 'opensearch':
      return OPENSEARCH;
    case 's3':
      return S3;
    default:
      // Defensive: dev tools are rendered by `renderDevTool`, never here.
      throw new JamalConfigError('a dev tool is not a backing service');
  }
}

function devToolConvention(type: JamalServiceType): DevToolConvention {
  switch (type) {
    case 'mailpit':
      return MAILPIT;
    case 'adminer':
      return ADMINER;
    default:
      // Defensive: backing services are rendered by `renderBackingService`, never here.
      throw new JamalConfigError('a backing service is not a dev tool');
  }
}

/** A resolved published-port binding: the Compose service key plus the host port. */
interface PortBinding {
  readonly serviceKey: string;
  readonly hostPort: number;
}

/**
 * Resolve `config.local.ports` to Compose service keys, rejecting any entry
 * whose named service is not configured. `web`/`app` alias the application
 * service, which exists only when `config.local.app` is not `host`; every
 * other name must be a key of `config.services`. Errors are value-free — the
 * offending name is never echoed.
 */
function resolvePortBindings(config: JamalConfig): PortBinding[] {
  const bindings: PortBinding[] = [];
  for (const [name, hostPort] of Object.entries(config.local.ports)) {
    if (APP_PORT_NAMES.has(name)) {
      if (config.local.app === 'host') {
        throw new JamalConfigError('config.local.ports names a service that is not configured');
      }
      bindings.push({ serviceKey: APP_SERVICE, hostPort });
      continue;
    }
    const service = config.services[name];
    if (service === undefined || isDevTool(service.type)) {
      // Dev tools carry fixed loopback ports and are never port-mapped here.
      throw new JamalConfigError('config.local.ports names a service that is not configured');
    }
    bindings.push({ serviceKey: name, hostPort });
  }
  return bindings.sort((a, b) =>
    a.serviceKey === b.serviceKey ? a.hostPort - b.hostPort : a.serviceKey < b.serviceKey ? -1 : 1,
  );
}

/** One generated file: a project-relative path and its contents. */
export interface LocalPlanFile {
  readonly path: string;
  readonly contents: string;
}

/** The result of a local plan: the files to write and the Compose project name. */
export interface LocalPlan {
  /** The Compose file first, then the dev-container files when `local.app` is `dev`. */
  readonly files: readonly LocalPlanFile[];
  readonly projectName: string;
}

/** Host facts the plan needs but must not read itself. */
export interface LocalPlanOptions {
  /** The developer's user and group id, so dev-container writes stay theirs. */
  readonly hostUser?: { readonly uid: number; readonly gid: number };
}

/**
 * Plan the local development files for `config`: the Compose file and, for a
 * `dev` app, its image definition and wrapper config. Side-effect free: no
 * file is written, no environment variable is read, and host facts arrive
 * through `options`.
 */
export function planLocal(config: JamalConfig, options: LocalPlanOptions = {}): LocalPlan {
  const projectName = config.service;
  const serviceNames = Object.keys(config.services).sort();
  const backingNames = serviceNames.filter((name) => {
    const type = config.services[name]?.type;
    return type !== undefined && !isDevTool(type);
  });
  const devToolNames = serviceNames.filter((name) => isDevTool(config.services[name]?.type));
  const bindings = resolvePortBindings(config);

  const lines: string[] = [
    '# Jamal local development Docker Compose project.',
    '#',
    '# Environment values are interpolated by Docker Compose from the host',
    '# environment (${KEY}); no secret values are ever written to this file.',
    '',
    `name: ${projectName}`,
    '',
    'services:',
  ];

  for (const name of backingNames) {
    const service = config.services[name];
    if (service === undefined) continue;
    const ports = bindings.filter((binding) => binding.serviceKey === name).map((b) => b.hostPort);
    lines.push(...renderBackingService(name, service.type, ports));
  }

  for (const name of devToolNames) {
    const type = config.services[name]?.type;
    if (type === undefined) continue;
    lines.push(...renderDevTool(name, type));
  }

  const appPorts = bindings
    .filter((binding) => binding.serviceKey === APP_SERVICE)
    .map((binding) => binding.hostPort);
  const hostUser = options.hostUser ?? DEFAULT_HOST_USER;
  if (config.local.app === 'image') {
    lines.push(...renderImageAppService(config, backingNames, appPorts));
  } else if (config.local.app === 'dev') {
    lines.push(...renderDevAppService(config, backingNames, appPorts, hostUser));
  }

  lines.push('', 'networks:', `  ${NETWORK}:`, '    driver: bridge', '', 'volumes:');

  const volumeNames = new Set<string>();
  for (const name of backingNames) {
    const service = config.services[name];
    if (service !== undefined) {
      volumeNames.add(convention(service.type).volume);
    }
  }
  if (config.local.app === 'image') {
    for (const [name, spec] of Object.entries(config.volumes)) {
      if (!spec.host) {
        volumeNames.add(name);
      }
    }
  }
  if (config.local.app === 'dev') {
    volumeNames.add(DEV_NODE_MODULES_VOLUME);
  }
  for (const name of [...volumeNames].sort()) {
    lines.push(`  ${name}:`);
  }
  lines.push('');

  const files: LocalPlanFile[] = [{ path: LOCAL_COMPOSE_PATH, contents: lines.join('\n') }];
  if (config.local.app === 'dev') {
    files.push({ path: LOCAL_DEV_DOCKERFILE_PATH, contents: devDockerfile() });
  }
  return { files, projectName };
}

/** The generated Compose file of a plan. */
export function composeFileOf(plan: LocalPlan): LocalPlanFile {
  const file = plan.files.find((candidate) => candidate.path === LOCAL_COMPOSE_PATH);
  if (file === undefined) {
    throw new JamalConfigError('the local plan has no Compose file');
  }
  return file;
}

/** Emit one backing service with the shared image/healthcheck/volume conventions. */
function renderBackingService(name: string, type: JamalServiceType, ports: number[]): string[] {
  const c = convention(type);
  const lines: string[] = [`  ${name}:`, `    image: ${c.image}`];
  if (c.command !== undefined) {
    lines.push(`    command: ${c.command}`);
  }
  if (c.environment.length > 0) {
    lines.push('    environment:');
    for (const entry of c.environment) {
      if (entry.value !== undefined) {
        lines.push(`      ${entry.key}: '${entry.value}'`);
      } else {
        lines.push(`      ${entry.key}: \${${entry.hostKey}}`);
      }
    }
  }
  lines.push(
    '    volumes:',
    `      - ${c.volume}:${c.dataDir}`,
    '    healthcheck:',
    `      test: ${c.healthcheckTest}`,
    `      interval: ${c.interval}`,
    `      timeout: ${c.timeout}`,
    `      retries: ${c.retries}`,
    '    restart: unless-stopped',
    '    networks:',
    `      - ${NETWORK}`,
  );
  if (ports.length > 0) {
    lines.push('    ports:');
    for (const port of ports) {
      lines.push(`      - "127.0.0.1:${port}:${c.port}"`);
    }
  }
  return lines;
}

/** Emit one dev-only tool with its fixed loopback ports and optional healthcheck. */
function renderDevTool(name: string, type: JamalServiceType): string[] {
  const c = devToolConvention(type);
  const lines: string[] = [`  ${name}:`, `    image: ${c.image}`];
  if (c.healthcheckTest !== undefined) {
    lines.push(
      '    healthcheck:',
      `      test: ${c.healthcheckTest}`,
      `      interval: ${c.interval ?? '10s'}`,
      `      timeout: ${c.timeout ?? '5s'}`,
      `      retries: ${c.retries ?? '5'}`,
    );
  }
  lines.push('    restart: unless-stopped', '    ports:');
  for (const port of c.ports) {
    lines.push(`      - "127.0.0.1:${port}:${port}"`);
  }
  lines.push('    networks:', `      - ${NETWORK}`);
  return lines;
}

/**
 * Where each kind of backing service lives on the Compose network, as the
 * variables the app reads. A kind with more than one service is left out
 * because there is no single right answer for it.
 */
function serviceLocations(
  config: JamalConfig,
  backingNames: readonly string[],
): [string, string][] {
  const only = (types: readonly JamalServiceType[]): string | undefined => {
    const matches = backingNames.filter((name) => {
      const type = config.services[name]?.type;
      return type !== undefined && types.includes(type);
    });
    return matches.length === 1 ? matches[0] : undefined;
  };
  const portOf = (name: string): number => convention(config.services[name]!.type).port;
  const locations: [string, string][] = [];
  const database = only(['mariadb', 'postgres']);
  if (database !== undefined) {
    locations.push(['DATABASE_HOST', database], ['DATABASE_PORT', String(portOf(database))]);
  }
  const valkey = only(['valkey']);
  if (valkey !== undefined) {
    locations.push(['VALKEY_URL', `redis://${valkey}:${portOf(valkey)}`]);
  }
  const search = only(['meilisearch', 'typesense', 'opensearch']);
  if (search !== undefined) {
    locations.push(['SEARCH_URL', `http://${search}:${portOf(search)}`]);
  }
  const objectStore = only(['s3']);
  if (objectStore !== undefined) {
    locations.push(['S3_ENDPOINT', `http://${objectStore}:${portOf(objectStore)}`]);
  }
  return locations;
}

/** `depends_on` on every backing service being healthy. */
function renderDependsOn(serviceNames: readonly string[]): string[] {
  if (serviceNames.length === 0) return [];
  const lines = ['    depends_on:'];
  for (const name of serviceNames) {
    lines.push(`      ${name}:`, '        condition: service_healthy');
  }
  return lines;
}

/** A path in the project written relative to `.jamal/`, where Compose resolves it. */
function fromComposeDir(source: string): string {
  return source.startsWith('/') || source.startsWith('$') ? source : posix.join('..', source);
}

/** Emit the app built from the project's Dockerfile (`local.app: 'image'`). */
function renderImageAppService(
  config: JamalConfig,
  serviceNames: readonly string[],
  ports: readonly number[],
): string[] {
  const lines: string[] = [`  ${APP_SERVICE}:`, '    build:', '      context: ..'];
  if (config.command !== undefined) {
    lines.push(`    command: ${config.command}`);
  }
  lines.push(...renderDependsOn(serviceNames));
  const environment = new Map<string, string>();
  for (const key of Object.keys(config.env).sort()) {
    const alias = config.env[key]!.alias;
    environment.set(alias !== undefined ? alias : key, `\${${key}}`);
  }
  for (const [key, value] of serviceLocations(config, serviceNames)) {
    environment.set(key, `'${value}'`);
  }
  if (environment.size > 0) {
    lines.push('    environment:');
    for (const key of [...environment.keys()].sort()) {
      lines.push(`      ${key}: ${environment.get(key)!}`);
    }
  }
  const volumeNames = Object.keys(config.volumes).sort();
  if (volumeNames.length > 0) {
    lines.push('    volumes:');
    for (const name of volumeNames) {
      const spec = config.volumes[name]!;
      if (spec.host) {
        const optSuffix = spec.options !== undefined ? `:${spec.options}` : '';
        lines.push(`      - ${fromComposeDir(spec.source)}:${spec.containerPath}${optSuffix}`);
      } else {
        lines.push(`      - ${name}:${spec.containerPath}`);
      }
    }
  }
  lines.push('    networks:', `      - ${NETWORK}`);
  if (ports.length > 0) {
    lines.push('    ports:');
    for (const port of ports) {
      // The image's listen port is not configured here, so the host port is reused.
      lines.push(`      - "127.0.0.1:${port}:${port}"`);
    }
  }
  return lines;
}

/**
 * The dev container's start command: install dependencies into the empty
 * `node_modules` volume on first start, then hand the process to `jsails dev`.
 * Written as a JSON array (valid YAML) and free of `$`, which Compose would
 * interpolate.
 */
const DEV_COMMAND = [
  'sh',
  '-c',
  'if [ ! -e node_modules/.bin/jsails ]; then npm install --no-audit --no-fund || exit 1; fi; ' +
    'exec node_modules/.bin/jsails dev',
];

/** Emit the Sail-style dev app (`local.app: 'dev'`). */
function renderDevAppService(
  config: JamalConfig,
  serviceNames: readonly string[],
  ports: readonly number[],
  hostUser: { readonly uid: number; readonly gid: number },
): string[] {
  const lines: string[] = [
    `  ${APP_SERVICE}:`,
    '    build:',
    '      context: .',
    `      dockerfile: ${posix.basename(LOCAL_DEV_DOCKERFILE_PATH)}`,
    '      args:',
    `        UID: '${hostUser.uid}'`,
    `        GID: '${hostUser.gid}'`,
    '    working_dir: /app',
    `    command: [${DEV_COMMAND.map((part) => JSON.stringify(part)).join(', ')}]`,
    '    init: true',
    ...renderDependsOn(serviceNames),
  ];
  // Listen on every interface inside the container; only the
  // loopback-published host port reaches it.
  const environment: [string, string][] = [
    ['JSAILS_HOST', '0.0.0.0'],
    ['JSAILS_PORT', String(DEV_APP_PORT)],
    ...serviceLocations(config, serviceNames),
  ];
  lines.push('    environment:');
  for (const [key, value] of environment) {
    lines.push(`      ${key}: '${value}'`);
  }
  lines.push(
    '    volumes:',
    '      - ..:/app',
    `      - ${DEV_NODE_MODULES_VOLUME}:/app/node_modules`,
    '    networks:',
    `      - ${NETWORK}`,
    '    ports:',
  );
  for (const port of ports.length > 0 ? ports : [DEV_APP_PORT]) {
    lines.push(`      - "127.0.0.1:${port}:${DEV_APP_PORT}"`);
  }
  return lines;
}

/**
 * The dev image: the Node image with its `node` user renumbered to the
 * developer's ids, and `/app/node_modules` created and owned by that user so
 * the empty named volume mounted there starts out writable.
 */
function devDockerfile(): string {
  return [
    '# Generated by jamal from jamal.config.js (local.app: "dev"). Do not edit.',
    `FROM ${DEV_NODE_IMAGE}`,
    `ARG UID=${DEFAULT_HOST_USER.uid}`,
    `ARG GID=${DEFAULT_HOST_USER.gid}`,
    'RUN if [ "$UID" != "0" ]; then \\',
    '      groupmod --non-unique --gid "$GID" node \\',
    '      && usermod --non-unique --uid "$UID" --gid "$GID" node; \\',
    '    fi \\',
    '    && mkdir -p /app/node_modules \\',
    '    && chown -R "$UID:$GID" /app',
    'USER ${UID}:${GID}',
    'WORKDIR /app',
    '',
  ].join('\n');
}
