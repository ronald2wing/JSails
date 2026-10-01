/**
 * Jamal production deployment planner.
 *
 * {@link planProduction} turns a normalized {@link JamalConfig} plus a target
 * image tag into a {@link ProductionPlan}: a value-free, deterministic data
 * layout of the ordered deploy flow — build and push locally, then pull, run,
 * health-check, switch, and stop on the remote server, with an optional
 * rollback step — that `production/execute.ts` materializes as real commands.
 * It is pure: it reads only its arguments, writes no file, reads no environment
 * variable, and its output is deterministic (stable ordering, no timestamps,
 * no clock or network access).
 *
 * The flow mirrors Kamal's deploy sequence:
 *
 *   0. `network` — `ssh <server>` ensure the shared {@link JAMAL_NETWORK}
 *                  network exists and attach the proxy and accessories to it.
 *   1. `build`   — `docker buildx build` locally (skipped by a rollback).
 *   2. `push`    — `docker push` locally (skipped by a rollback).
 *   3. `pull`    — `ssh <server> docker pull`.
 *   4. `run`     — `ssh <server> docker run` the new container on the shared
 *                  network with a restart policy, after removing a stopped
 *                  leftover of the same name (a running one is never removed:
 *                  the run fails on the name conflict instead).
 *   5. `health`  — probe the NEW container from inside it over ssh, one
 *                  bounded attempt at a time, retried by the executor.
 *   6. `switch`  — when a production domain or an on-demand TLS URL is set, the
 *                  `kamal-proxy deploy` argv (assembled by {@link proxyDeployArgv}
 *                  and prefixed with `ssh <server>`) targeting
 *                  `<container>:<port>`; otherwise a description-only directive.
 *   7. `stop`    — `ssh <server>` stop and remove the previous container.
 *
 * Redeploying the tag that is live (the git short hash of an unchanged
 * commit) must not touch the serving container before the new one is
 * healthy, so the new container takes an alternate name ({@link
 * containerNameForRelease}) whenever the default one is the live container's.
 * The executor records the name in the deploy history.
 *   8. `rollback` — only when `previousTag` is given; re-runs the previous
 *                  image so a failed cutover can be reverted.
 *
 * Backing services (`config.services`) add a set of `accessory` steps — a
 * data-volume creation, a credentials env file, a container start, and a
 * health poll per service — before the build step, and their env refs
 * (`DATABASE_HOST`/`DATABASE_PORT`/`DATABASE_TYPE`, `VALKEY_URL`, all naming
 * the accessory container on the shared network) are appended to the app
 * `run` argv so the app reaches them.
 *
 * Every remote argv is data: the ssh transport quotes each element for the
 * remote shell, so a value containing spaces or shell metacharacters reaches
 * the server's `docker` unchanged.
 *
 * No secret value ever reaches the plan. `config.env` is reduced to
 * `{ name, secret }` entries — a {@link SecretRef} contributes only its NAME,
 * and a literal value is dropped entirely — and nothing else (image reference,
 * container name, health URL, argv, descriptions, warnings) embeds a resolved
 * value. Because the plan is already value-free, a `redactProductionPlan`
 * pass would be a no-op and is deliberately not provided.
 */

import {
  JamalConfigError,
  SecretRef,
  type JamalConfig,
  type JamalHealthConfig,
} from '../config/index.js';
import { clearEnvFlags, type ResolvedEnv } from '../env-resolve.js';
import { planAccessories, type AccessoryStep } from './accessories.js';
import {
  cacheProxyBootArgv,
  cacheProxyHealthArgv,
  cacheProxyWriteVclArgv,
  resolveVcl,
  CACHE_PROXY_CONTAINER_NAME,
  CACHE_PROXY_PORT_DEFAULT,
} from './cache-proxy.js';
import { proxyDeployArgv, PROXY_CONTAINER_NAME } from './proxy.js';
import { assertProxyValue } from './proxy-validation.js';
import { splitCommandLine } from '../command-line.js';
import { JAMAL_NETWORK, SERVICE_LABEL } from './host-layout.js';
import { ensureNetworkArgv } from './network.js';
import { shellQuote } from './transport.js';

/**
 * Docker's tag grammar: up to 128 letters, digits, `_`, `.`, and `-`, not
 * starting with `.` or `-`. A tag that passes is also safe inside a container
 * name and needs no quoting anywhere.
 */
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** The port the app listens on inside its container (`JSAILS_PORT`). */
export const PRODUCTION_APP_PORT = 3000;

/** Health path used when `config.health` is absent (matches the app's `/up` default). */
const DEFAULT_HEALTH_PATH = '/up';

/** Per-probe timeout default when `config.health` is absent. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Poll interval default when `config.health` is absent. */
const DEFAULT_INTERVAL_MS = 30000;

/** One ordered remote/local command in the deploy flow. */
export type ProductionStepKind =
  | 'network'
  | 'build'
  | 'push'
  | 'pull'
  | 'env-file'
  | 'run'
  | 'health'
  | 'switch'
  | 'stop'
  | 'rollback'
  | 'accessory'
  | 'cache-proxy:write-vcl'
  | 'cache-proxy:boot'
  | 'cache-proxy:health';

/** A single step: its kind, a human description, and an optional fixed argv array. */
export interface ProductionStep {
  readonly kind: ProductionStepKind;
  readonly description: string;
  /** Fixed argv as data (never shell-interpolated); absent for pure directives. */
  readonly argv?: readonly string[];
  /** Structured metadata for an accessory step; absent for app steps. */
  readonly accessory?: AccessoryStep;
  /**
   * Absolute host path an `env-file` step writes to. The contents are never
   * stored here — the executor draws them from its `ResolvedEnv` — so a secret
   * value cannot reach the plan, its logs, or `ps`.
   */
  readonly envFilePath?: string;
  /**
   * When this step fails, remove the new container (it never received
   * traffic). Set on the steps after `run` whose failure leaves the previous
   * release serving.
   */
  readonly cleanupOnFailure?: boolean;
}

/** A `config.env` entry reduced to its name, secret flag, optional alias, and clear flag. */
export interface ProductionEnvEntry {
  readonly name: string;
  readonly secret: boolean;
  readonly alias: string | undefined;
  readonly clear: boolean;
}

/** A `config.volumes` entry: volume name, source/path/options, and host flag. */
export interface ProductionVolumeEntry {
  readonly name: string;
  readonly source: string;
  readonly containerPath: string;
  readonly options: string | undefined;
  readonly host: boolean;
}

/** Options for {@link planProduction}. */
export interface PlanProductionOptions {
  /** The image tag to deploy (validated: no whitespace or control characters). */
  readonly imageTag: string;
  /** The previously deployed tag, when rolling forward; enables `stop`/`rollback`. */
  readonly previousTag?: string;
  /**
   * The container the previous release runs in, as the deploy history
   * recorded it; defaults to {@link containerNameForTag} of `previousTag`.
   */
  readonly previousContainer?: string;
  /**
   * The resolved env split. When present, `clear` entries become `-e` flags and
   * `secret` entries become an `env-file` step. When absent, every `config.env`
   * entry is treated as a name-only reference and no env file is planned — the
   * pre-secrets behavior, kept for callers that only preview a plan.
   */
  readonly env?: ResolvedEnv;
  /** Host path the env file is written to; required when `env` has secrets. */
  readonly envFilePath?: string;
  /**
   * Omit the local `build` and `push` steps: a rollback redeploys an image
   * that is already in the registry, and rebuilding it from the current tree
   * would overwrite it.
   */
  readonly skipBuild?: boolean;
}

/** The deterministic, value-free production plan. */
export interface ProductionPlan {
  /** `<config.image>:<tag>` — the full image reference to build, push, and run. */
  readonly imageRef: string;
  /** `<service>-web-<tag>` — the new container name. */
  readonly containerName: string;
  /**
   * The public URL of the health path. Only an injected `HealthCheck` probes
   * it; the default health step probes the new container from inside it.
   */
  readonly healthUrl: string;
  /** The production server every remote step targets. */
  readonly server: string;
  /** `config.health.timeoutMs` (defaults applied); the per-probe health timeout. */
  readonly healthTimeoutMs: number;
  /** `config.health.intervalMs` (defaults applied); the health poll interval. */
  readonly healthIntervalMs: number;
  /** `config.env` reduced to names plus a secret flag; never a value. */
  readonly env: readonly ProductionEnvEntry[];
  /** `config.volumes` as `{ name, containerPath }`, sorted by name. */
  readonly volumes: readonly ProductionVolumeEntry[];
  /** The ordered deploy flow as data. */
  readonly steps: readonly ProductionStep[];
  /** `config.health.retries` (undefined when unset); the executor applies its default. */
  readonly healthRetries: number | undefined;
  /** `config.health.retryDelayMs` (undefined when unset); the executor applies its default. */
  readonly healthRetryDelayMs: number | undefined;
  /** `config.health.readinessDelayMs` (undefined when unset); slept once before the first probe. */
  readonly healthReadinessDelayMs: number | undefined;
  /** Deterministic reminders (registry login, version skew); never a secret. */
  readonly warnings: readonly string[];
  /** The ssh argv that removes the new container after a failed release step. */
  readonly cleanupArgv: readonly string[];
}

/** Docker's container-name grammar. */
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The suffix that gives a same-tag redeploy a name distinct from the live container. */
const ALTERNATE_CONTAINER_SUFFIX = '-r';

/** Reject a tag outside Docker's tag grammar, value-free. */
function assertImageTag(tag: string): void {
  if (typeof tag !== 'string' || tag.length === 0) {
    throw new JamalConfigError('the image tag must be a non-empty string');
  }
  if (!IMAGE_TAG.test(tag)) {
    throw new JamalConfigError(
      'the image tag must be at most 128 letters, digits, "_", ".", or "-", ' +
        'and must not start with "." or "-"',
    );
  }
}

/**
 * Reject a production domain that cannot be a safe proxy `--host` value. The
 * domain becomes a proxy deploy argv token when the switch step is assembled,
 * so it must satisfy the same rules as every other proxy value.
 */
function assertProxyHost(host: string): void {
  assertProxyValue(host, 'config.production.domain', (message) => new JamalConfigError(message));
}

/** Build --log-driver / --log-opt flags from config.logging, sorted by option key. */
function logDriverFlags(config: JamalConfig): readonly string[] {
  const logging = config.logging;
  if (logging === undefined) return [];
  const flags: string[] = ['--log-driver', logging.driver];
  const sorted = Object.entries(logging.options).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of sorted) {
    flags.push('--log-opt', `${key}=${value}`);
  }
  return flags;
}

/**
 * The deterministic container name for a service at a tag. Exported so the
 * remote inspection verbs (`jamal app logs`/`jamal app exec`) can reconstruct the
 * container a deploy left behind from the recorded history entry. The full tag
 * is used (a tag that passed {@link assertImageTag} is a valid name suffix), so
 * two distinct tags never share a container name.
 */
export function containerNameForTag(service: string, tag: string): string {
  return `${service}-web-${tag}`;
}

/**
 * The container a release runs in: {@link containerNameForTag}, or that name
 * plus {@link ALTERNATE_CONTAINER_SUFFIX} when the default is the live
 * container (`previousContainer`), so a same-tag redeploy alternates between
 * two names and never replaces the serving container before its successor is
 * healthy.
 */
export function containerNameForRelease(
  service: string,
  tag: string,
  previousContainer: string | undefined,
): string {
  const name = containerNameForTag(service, tag);
  return name === previousContainer ? `${name}${ALTERNATE_CONTAINER_SUFFIX}` : name;
}

/**
 * The container a recorded deploy runs in: the name the history entry
 * recorded, or, for an entry written before names were recorded,
 * {@link containerNameForTag} of its tag.
 */
export function containerNameForEntry(
  service: string,
  entry: { readonly tag: string; readonly container?: string },
): string {
  return entry.container ?? containerNameForTag(service, entry.tag);
}

/**
 * Wrap a `docker run` argv so a stopped leftover of the same name (the
 * stopped container a rollback returns to, a container that exited) is
 * removed first, and a container `docker run` created but could not start is
 * removed after. Both removals are without `-f`: a RUNNING container of that
 * name may be serving traffic (a deploy from another checkout whose history
 * this one lacks), so the run fails on the name conflict rather than kill it.
 * The container name and the run argv are positional parameters.
 */
function runFreshContainerArgv(name: string, runArgv: readonly string[]): readonly string[] {
  return [
    'sh',
    '-c',
    'n=$1; shift; docker rm "$n" >/dev/null 2>&1; "$@" && exit 0; ' +
      's=$?; docker rm "$n" >/dev/null 2>&1; exit $s',
    'sh',
    name,
    ...runArgv,
  ];
}

/**
 * Load the new VCL into the running cache proxy, or start it. A running
 * Varnish on the configured image reloads in place (`varnishreload`), so it
 * keeps serving through the deploy; a missing or stopped container, a changed
 * image, or a failed reload falls back to replacing the container, which
 * briefly interrupts traffic routed through it. The container name, image,
 * and boot argv are positional parameters.
 */
function cacheProxyLoadArgv(image: string, bootArgv: readonly string[]): readonly string[] {
  return [
    'sh',
    '-c',
    'n=$1; img=$2; shift 2; ' +
      `state=$(docker inspect --type container -f '{{.State.Running}} {{.Config.Image}}' "$n" 2>/dev/null); ` +
      '[ "$state" = "true $img" ] && docker exec "$n" varnishreload >/dev/null && exit 0; ' +
      'docker rm -f "$n" >/dev/null 2>&1; exec "$@"',
    'sh',
    CACHE_PROXY_CONTAINER_NAME,
    image,
    ...bootArgv,
  ];
}

/** Stop and remove a container when it exists; a missing one is not an error. */
function retireContainerArgv(name: string): readonly string[] {
  return [
    'sh',
    '-c',
    'docker inspect --type container "$1" >/dev/null 2>&1 || exit 0; ' +
      'docker stop "$1" >/dev/null && docker rm "$1" >/dev/null',
    'sh',
    name,
  ];
}

/**
 * The health probe run inside the new container: one request to the health
 * path on the app's own port, bounded by the per-probe timeout, exiting 0 only
 * on a 2xx response. JSails images run Node, so `node -e` with the built-in
 * `fetch` needs nothing else in the image.
 */
function healthProbeScript(path: string, timeoutMs: number): string {
  const url = JSON.stringify(`http://127.0.0.1:${PRODUCTION_APP_PORT}${path}`);
  return (
    `fetch(${url},{signal:AbortSignal.timeout(${timeoutMs})})` +
    '.then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))'
  );
}

/**
 * A host volume source as the server's Docker CLI should read it. A `$PWD/`
 * prefix (meaningful to Compose locally) becomes `./`, which the CLI resolves
 * against the ssh session's working directory, the deploy user's home.
 */
function productionHostSource(source: string): string {
  return source.startsWith('$PWD/') ? `./${source.slice('$PWD/'.length)}` : source;
}

/**
 * Plan the production deployment for `config` at `options.imageTag`.
 *
 * `config.production` is required — the remote server (and optional domain)
 * name the SSH target and the health URL. Both `imageTag` and `previousTag`
 * (when given) are validated value-free. The result is pure and deterministic:
 * same input, same deep-equal plan, with stable key and step ordering and no
 * timestamps.
 */
export function planProduction(
  config: JamalConfig,
  options: PlanProductionOptions,
): ProductionPlan {
  const production = config.production;
  if (production === undefined) {
    throw new JamalConfigError('config.production is required to plan a production deployment');
  }
  assertImageTag(options.imageTag);
  const previousTag = options.previousTag;
  if (previousTag !== undefined) {
    assertImageTag(previousTag);
  }

  const { server, domain, onDemandTlsUrl, registry } = production;
  if (domain !== undefined) {
    assertProxyHost(domain);
  }
  const imageRef = `${config.image}:${options.imageTag}`;
  const previousImageRef = previousTag === undefined ? undefined : `${config.image}:${previousTag}`;
  const previousContainerName =
    previousTag === undefined
      ? undefined
      : (options.previousContainer ?? containerNameForTag(config.service, previousTag));
  if (previousContainerName !== undefined && !CONTAINER_NAME.test(previousContainerName)) {
    throw new JamalConfigError('the previous container name is not a valid Docker container name');
  }
  const containerName = containerNameForRelease(
    config.service,
    options.imageTag,
    previousContainerName,
  );

  const health: JamalHealthConfig = config.health ?? {
    path: DEFAULT_HEALTH_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    retries: undefined,
    retryDelayMs: undefined,
    readinessDelayMs: undefined,
  };
  // A domain implies a TLS terminator, so the public URL is https; a bare
  // server has no certificate, so it is plain http. Registry/secret values
  // never enter the URL.
  const healthHost = domain ?? server;
  const healthUrl = `${domain === undefined ? 'http' : 'https'}://${healthHost}${health.path}`;

  // Backing services are provisioned before the app image is built, so the app
  // can start against a live database/Valkey. The env refs name the accessory
  // containers, which the app resolves on the shared network.
  const accessoryPlan = planAccessories(config);
  const accessoryEnvFlags = accessoryPlan.appEnv.flatMap((entry) => [
    '-e',
    `${entry.name}=${entry.value}`,
  ]);

  // The clear channel goes on the command line; the secret channel goes into an
  // env file the container reads, so a secret value never reaches `ps`.
  const clearFlags = options.env === undefined ? [] : clearEnvFlags(options.env);
  const secretEntries = options.env?.secret ?? [];
  const envFileStep: ProductionStep[] =
    secretEntries.length === 0
      ? []
      : [
          {
            kind: 'env-file',
            description: `Write ${secretEntries.length} secret env entries to ${options.envFilePath ?? 'the host env file'}.`,
            envFilePath: options.envFilePath,
          },
        ];
  const envFileFlags =
    secretEntries.length === 0 || options.envFilePath === undefined
      ? []
      : ['--env-file', options.envFilePath];

  const volumes = Object.entries(config.volumes)
    .map(([name, spec]) => ({
      name,
      source: spec.source,
      containerPath: spec.containerPath,
      options: spec.options,
      host: spec.host,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // Every volume becomes a -v flag on the run step. A named volume is
  // prefixed with the service, as Compose prefixes it with the project name
  // locally, so two apps on one server never share a volume by accident.
  const volumeFlags = volumes.flatMap((v) => {
    if (!v.host) {
      return ['-v', `${config.service}_${v.name}:${v.containerPath}`];
    }
    const source = productionHostSource(v.source);
    const spec = v.options
      ? `${source}:${v.containerPath}:${v.options}`
      : `${source}:${v.containerPath}`;
    return ['-v', spec];
  });
  const commandTokens = config.command === undefined ? [] : splitCommandLine(config.command);

  // The app listens on every interface inside its container, on a fixed port
  // the proxy and the cache proxy target. NODE_ENV is set because the image
  // need not set it, and an unset NODE_ENV boots the app with development
  // defaults. A user `-e` later in the argv wins.
  const runArgv = (name: string, image: string): readonly string[] =>
    runFreshContainerArgv(name, [
      'docker',
      'run',
      '-d',
      '--name',
      name,
      '--network',
      JAMAL_NETWORK,
      '--restart',
      'unless-stopped',
      '--label',
      `${SERVICE_LABEL}=${config.service}`,
      '-e',
      'NODE_ENV=production',
      '-e',
      'JSAILS_HOST=0.0.0.0',
      '-e',
      `JSAILS_PORT=${PRODUCTION_APP_PORT}`,
      ...accessoryEnvFlags,
      ...clearFlags,
      ...envFileFlags,
      ...volumeFlags,
      ...logDriverFlags(config),
      image,
      ...commandTokens,
    ]);

  // When the cache proxy is enabled, kamal-proxy routes to the Varnish
  // container (not the app), and Varnish forwards to the app on its internal
  // port. The cache proxy is booted and health-checked AFTER the app health
  // check but BEFORE the proxy switch, so it is serving before traffic arrives.
  const cacheProxyEnabled = config.cacheProxy?.enabled === true;
  const switchTarget = cacheProxyEnabled
    ? `${CACHE_PROXY_CONTAINER_NAME}:${CACHE_PROXY_PORT_DEFAULT}`
    : `${containerName}:${PRODUCTION_APP_PORT}`;
  const cacheProxyImage = config.cacheProxy?.image ?? 'varnish:7.7';
  const cacheProxySize = config.cacheProxy?.size ?? '256m';

  const buildSteps: ProductionStep[] =
    options.skipBuild === true
      ? []
      : [
          {
            kind: 'build',
            description: `Build ${imageRef} locally with docker buildx.`,
            argv: ['docker', 'buildx', 'build', '-t', imageRef, '.'],
          },
          {
            kind: 'push',
            description: `Push ${imageRef} to the registry.`,
            argv: ['docker', 'push', imageRef],
          },
        ];

  const steps: ProductionStep[] = [
    {
      kind: 'network',
      description: `Ensure the ${JAMAL_NETWORK} Docker network on ${server} and attach the proxy and accessories to it.`,
      argv: [
        'ssh',
        server,
        ...ensureNetworkArgv([PROXY_CONTAINER_NAME, ...accessoryPlan.containers]),
      ],
    },
    ...accessoryPlan.steps,
    ...buildSteps,
    {
      kind: 'pull',
      description: `Pull ${imageRef} on ${server}.`,
      argv: ['ssh', server, 'docker', 'pull', imageRef],
    },
    // The env file must exist before `docker run --env-file` reads it.
    ...envFileStep,
    {
      kind: 'run',
      description: `Start ${containerName} from ${imageRef} on ${server}.`,
      // No cleanup on a failed run: the run removes what it created itself,
      // and a name conflict means the container is not this release's.
      argv: ['ssh', server, ...runArgv(containerName, imageRef)],
    },
    {
      kind: 'health',
      description: `Probe ${health.path} inside ${containerName} (${health.timeoutMs} ms per probe) until it responds.`,
      argv: [
        'ssh',
        server,
        'docker',
        'exec',
        containerName,
        'node',
        '-e',
        healthProbeScript(health.path, health.timeoutMs),
      ],
      cleanupOnFailure: true,
    },
    // Cache-proxy steps: inserted only when `cacheProxy.enabled` is true.
    // Varnish must be up and healthy before kamal-proxy switches traffic to it.
    ...(cacheProxyEnabled
      ? [
          {
            kind: 'cache-proxy:write-vcl' as const,
            description: `Write the VCL file to ${server} for the cache proxy.`,
            argv: [
              'ssh',
              server,
              ...cacheProxyWriteVclArgv(
                resolveVcl(containerName, PRODUCTION_APP_PORT, {
                  cookieAllowlist: config.cacheProxy?.cookieAllowlist,
                }),
              ),
            ],
          },
          {
            kind: 'cache-proxy:boot' as const,
            description: `Reload the cache-proxy VCL on ${server}, or boot the Varnish container (image ${cacheProxyImage}).`,
            // The VCL names this release's container; a running Varnish
            // loads it in place and keeps serving the previous release
            // until the switch.
            argv: [
              'ssh',
              server,
              ...cacheProxyLoadArgv(
                cacheProxyImage,
                cacheProxyBootArgv({ image: cacheProxyImage, size: cacheProxySize }),
              ),
            ],
          },
          {
            kind: 'cache-proxy:health' as const,
            description: `Wait for the Varnish cache-proxy container to become healthy on ${server}.`,
            argv: ['ssh', server, ...cacheProxyHealthArgv()],
          },
        ]
      : []),
    {
      kind: 'switch',
      // kamal-proxy keeps the previous target when a deploy fails its health
      // check, so the new container never served and can go.
      cleanupOnFailure: !cacheProxyEnabled,
      description: cacheProxyEnabled
        ? `Switch the proxy to route traffic to the cache-proxy container ${switchTarget}.`
        : `Switch the proxy to route traffic to ${switchTarget}.`,
      // When the cache proxy is enabled, kamal-proxy targets the Varnish
      // container; Varnish forwards to the app container on its internal
      // port. The proxy still terminates TLS and routes the public host.
      argv:
        domain !== undefined
          ? [
              'ssh',
              server,
              ...proxyDeployArgv({
                service: config.service,
                target: switchTarget,
                host: domain,
                tls: true,
                healthCheckPath: health.path,
              }),
            ]
          : onDemandTlsUrl !== undefined
            ? [
                'ssh',
                server,
                ...proxyDeployArgv({
                  service: config.service,
                  target: switchTarget,
                  onDemandTlsUrl,
                  tls: true,
                  healthCheckPath: health.path,
                }),
              ]
            : undefined,
    },
    // The new container's name always differs from the previous one
    // (containerNameForRelease), so retiring it never touches this release.
    previousContainerName === undefined
      ? {
          kind: 'stop',
          description: `Stop the previous container on ${server}.`,
        }
      : {
          kind: 'stop',
          description: `Stop and remove the previous container ${previousContainerName} on ${server}.`,
          argv: ['ssh', server, ...retireContainerArgv(previousContainerName)],
        },
  ];

  if (
    previousTag !== undefined &&
    previousImageRef !== undefined &&
    previousContainerName !== undefined
  ) {
    steps.push({
      kind: 'rollback',
      description: `Roll back to the previous release ${previousImageRef}.`,
      argv: ['ssh', server, ...runArgv(previousContainerName, previousImageRef)],
    });
  }

  const env = Object.entries(config.env)
    .map(([name, entry]) => ({
      name,
      secret: entry.value instanceof SecretRef,
      alias: entry.alias,
      clear: entry.clear,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const warnings: string[] = [];
  if (registry !== undefined) {
    warnings.push(`Sign in to the registry before pushing: docker login ${registry.server}.`);
  }
  if (previousTag !== undefined) {
    warnings.push(
      `Rolling forward from ${previousImageRef} to ${imageRef}: run any pending migrations ` +
        `before the proxy switch and keep ${previousTag} and ${options.imageTag} compatible ` +
        `during the cutover.`,
    );
  }

  return {
    imageRef,
    containerName,
    healthUrl,
    server,
    healthTimeoutMs: health.timeoutMs,
    healthIntervalMs: health.intervalMs,
    healthRetries: health.retries,
    healthRetryDelayMs: health.retryDelayMs,
    healthReadinessDelayMs: health.readinessDelayMs,
    env,
    volumes,
    steps,
    warnings,
    cleanupArgv: ['ssh', server, 'docker', 'rm', '-f', containerName],
  };
}

/**
 * Render a {@link ProductionPlan} as a deterministic, plain-text preview for
 * `jamal deploy --dry-run` / `jamal rollback --dry-run`. Each step prints its
 * kind and human description, followed by its fixed argv (when the step carries
 * one), shell-quoted exactly as the remote shell receives it, so the operator
 * can see what would run. Accessory steps (backing
 * services) come first, then the app release flow; no secret value appears
 * because the plan is already value-free.
 */
export function formatProductionPlan(plan: ProductionPlan): string {
  const lines: string[] = [`image: ${plan.imageRef}`, `container: ${plan.containerName}`, ''];
  for (const step of plan.steps) {
    lines.push(`${step.kind}: ${step.description}`);
    if (step.argv !== undefined) {
      lines.push(`  $ ${step.argv.map((token) => shellQuote(token)).join(' ')}`);
    }
  }
  if (plan.warnings.length > 0) {
    lines.push('');
    for (const warning of plan.warnings) {
      lines.push(`warning: ${warning}`);
    }
  }
  return lines.join('\n');
}
