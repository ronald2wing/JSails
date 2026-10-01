/**
 * The release planner: {@link planRelease} and {@link planRollback} turn a
 * normalized {@link JamalConfig}, the release to run, and what `observe`
 * read on the server into a {@link ProductionPlan}, the ordered host steps
 * that `release.ts` executes under the deploy lock.
 *
 * Both are pure: they read only their arguments (the clock, the lock's
 * sequence number, and the operator arrive as inputs), write nothing, and
 * return equal plans for equal inputs. Both first {@link reconcile} the
 * observed host, so a plan always starts from the release the proxy serves,
 * whatever `state.json` or the local checkout believes. Both refuse a routed
 * app whose kamal-proxy is not running: its switch could not run, and
 * nothing it would change on the host could be judged against what serves.
 *
 * A deploy's steps, in order:
 *
 *   - `repair-state`  rewrite `state.json` to the reconciled truth, by
 *                     compare-and-replace of the observed bytes (only when
 *                     they differ from it).
 *   - `network`       ensure the shared {@link JAMAL_NETWORK} network and
 *                     attach the proxy and accessories to it.
 *   - `accessory`     the backing services (`accessories.ts`).
 *   - `pull`          pull the release image by digest.
 *   - `secrets-file`  create the release's secrets file (`secrets-file.ts`).
 *   - `check`         run `jsails check --deploy` in the image with the
 *                     release's environment and no network.
 *   - `manifest`      create the release's immutable manifest
 *                     (`manifest.ts`), before any container of it runs.
 *   - `run`           start the web container `<app>-web-<release id>`,
 *                     labelled with the service, destination, role, and
 *                     release.
 *   - `health`        probe it from inside, retried by the executor.
 *   - `cache-proxy:*` write the VCL naming the new container, reload or boot
 *                     Varnish, wait for it (when the cache proxy is enabled).
 *   - `switch`        `kamal-proxy deploy` to the new target (when routed).
 *   - `state`         record the new live and previous releases in
 *                     `state.json`, compare-and-replace.
 *   - `retire`        stop and remove every other container of the app the
 *                     host runs: the release that served before, a stale
 *                     one another checkout or a killed run left, a dead one.
 *
 * A rollback runs the same steps for the reconciled previous release, from
 * its own manifest and its own secrets file: no `secrets-file` and no
 * `manifest` step (both exist and never change), the image by the digest and
 * the web container and command the manifest records.
 *
 * A plan holds no secret value: `config.env` is reduced to names, the
 * secrets file's bytes are drawn from the resolved env by the executor, and
 * the manifest records only the names and the file's SHA-256. A dry run
 * plans from a read-only observation with {@link DIGEST_PLACEHOLDER} for the
 * digest the push has not produced yet; such a plan is a preview, which the
 * executor refuses.
 */

import { deriveNodeEnv } from 'jsails/internal';
import { defineErrors, type ErrorRegistry } from 'jsails/errors';

import {
  JamalConfigError,
  SecretRef,
  type JamalConfig,
  type JamalHealthConfig,
} from '../config/index.js';
import { splitCommandLine } from '../command-line.js';
import { containerEnvironmentOf } from '../credentials-delivery.js';
import { clearEnvFlags, type ResolvedEnv } from '../env-resolve.js';
import { planAccessories, type AccessoryStep } from './accessories.js';
import {
  cacheProxyBootArgv,
  cacheProxyHealthArgv,
  resolveVcl,
  CACHE_PROXY_CONTAINER_NAME,
  CACHE_PROXY_HOST_VCL_FILE,
  CACHE_PROXY_IMAGE_DEFAULT,
  CACHE_PROXY_PORT_DEFAULT,
  CACHE_PROXY_SIZE_DEFAULT,
  CACHE_PROXY_VCL_DIRECTORY_MODE,
  CACHE_PROXY_VCL_MODE,
} from './cache-proxy.js';
import { assertHostHome } from './host-home.js';
import {
  absoluteHostPath,
  appContainerName,
  APP_LABELS,
  hostManifestFile,
  hostStateFile,
  JAMAL_NETWORK,
  WEB_ROLE,
} from './host-layout.js';
import { encodeHostState, HOST_STATE_VERSION, type HostState } from './host-state.js';
import { isPinnedImage } from './image-ref.js';
import {
  configDigest,
  encodeManifest,
  MANIFEST_VERSION,
  type ReleaseManifest,
} from './manifest.js';
import { ensureNetworkArgv } from './network.js';
import { isRouted, type ObservedState } from './observe.js';
import { proxyDeployArgv, PROXY_CONTAINER_NAME } from './proxy.js';
import { trustedProxiesVariable } from './proxy-trust.js';
import { assertProxyValue } from './proxy-validation.js';
import { reconcile, type Reconciled, type RepairReason } from './reconcile.js';
import { isReleaseId } from './release-id.js';
import { remoteWriteFileArgv, sha256Hex } from './remote-file.js';
import { remoteOpArgv, WRITE_EXPECT_ABSENT } from './remote-op.js';
import { releaseSecretsLayout, SECRETS_DIRECTORY_MODE, SECRETS_FILE_MODE } from './secrets-file.js';
import { shellQuote } from './transport.js';

const PLAN_ERRORS = {
  invalid_release: {
    kind: 'invalid',
    message: 'the release to plan needs a release id and an image pinned by digest in config.image',
  },
  no_previous: {
    kind: 'not_found',
    message: 'the server has no previous release to roll back to',
  },
  no_web_role: {
    kind: 'invalid',
    message:
      'the previous release records no web role in its manifest, so it cannot run as it was deployed',
  },
  proxy_down: {
    kind: 'unavailable',
    message:
      'kamal-proxy is not running on the server, so a release of the app could not be switched in',
    suggestion: 'start the kamal-proxy container on the server, then run again',
  },
  secrets_missing: {
    kind: 'not_found',
    message:
      'the previous release has no secrets file on the server any more, so it cannot run as it was deployed',
  },
  unpinned_proxy: {
    kind: 'invalid',
    message:
      'kamal-proxy runs an image no registry digest names, so the release could not record what it is served through',
    suggestion:
      'run kamal-proxy from an image pulled by its digest (basecamp/kamal-proxy@sha256:…)',
  },
} as const;

/** `jamal_plan.*`: a release that cannot be planned against the observed host. */
export const PlanErrors: ErrorRegistry<'jamal_plan', typeof PLAN_ERRORS> = defineErrors(
  'jamal_plan',
  PLAN_ERRORS,
);

/** What a preview plan shows for the digest the push has not produced yet. */
export const DIGEST_PLACEHOLDER = '<digest>';

/** The port the app listens on inside its container (`JSAILS_PORT`). */
export const PRODUCTION_APP_PORT = 3000;

/** The mode of a release manifest: nobody writes it again. */
export const MANIFEST_MODE = 0o444;

/** The mode of a release directory: only the ssh user reaches its files. */
export const RELEASE_DIRECTORY_MODE = 0o700;

/** The mode of `state.json` and of the app directory holding it. */
export const STATE_MODE = 0o600;
export const APP_DIRECTORY_MODE = 0o700;

/** Health path used when `config.health` is absent (matches the app's `/up` default). */
const DEFAULT_HEALTH_PATH = '/up';

/** Per-probe timeout default when `config.health` is absent. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Poll interval default when `config.health` is absent. */
const DEFAULT_INTERVAL_MS = 30000;

/**
 * The deploy check run inside the release image: the CLI the generated
 * Dockerfile's `CMD` starts (`node node_modules/.bin/jsails serve`, from the
 * image's working directory), with `check --deploy`.
 */
const DEPLOY_CHECK_COMMAND: readonly string[] = Object.freeze([
  'node',
  'node_modules/.bin/jsails',
  'check',
  '--deploy',
]);

/** One ordered step of a release. */
export type ProductionStepKind =
  | 'repair-state'
  | 'network'
  | 'accessory'
  | 'pull'
  | 'secrets-file'
  | 'check'
  | 'manifest'
  | 'run'
  | 'health'
  | 'cache-proxy:write-vcl'
  | 'cache-proxy:boot'
  | 'cache-proxy:health'
  | 'switch'
  | 'state'
  | 'retire';

/** A single step: its kind, a human description, and what it runs or writes. */
export interface ProductionStep {
  readonly kind: ProductionStepKind;
  readonly description: string;
  /** `['ssh', server, ...remote argv]` as data (never shell-interpolated); absent for a file step. */
  readonly argv?: readonly string[];
  /** Structured metadata for an accessory step; absent for app steps. */
  readonly accessory?: AccessoryStep;
  /** The file a file step writes through `writeRemoteFile`. */
  readonly file?: PlannedFileWrite;
  /**
   * When this step fails, remove the new container (it never received
   * traffic). Set on the steps after `run` whose failure leaves the previous
   * release serving.
   */
  readonly cleanupOnFailure?: boolean;
}

/** A remote file a step writes through `writeRemoteFile`. */
export interface PlannedFileWrite {
  /** The destination, relative to the ssh user's home. */
  readonly path: string;
  readonly mode: number;
  /** The mode its directory is set to. */
  readonly directoryMode: number;
  /**
   * Where the bytes come from: `secrets` means the executor writes the
   * resolved env's secrets file, so no secret value is ever stored in the
   * plan; `text` means {@link contents} is the whole file.
   */
  readonly source: 'secrets' | 'text';
  /** The file's text when {@link source} is `text`. */
  readonly contents?: string;
  /** The precondition: `absent` (create only), or the SHA-256 of the bytes it replaces. */
  readonly expect?: string;
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

/** Who plans, when, and under which lock acquisition. */
export interface PlanContext {
  /** The ssh user's home on the server, absolute, as `readHostHome` read it. */
  readonly hostHome: string;
  /** The deploy lock's sequence number; a preview plans with 0. */
  readonly seq: number;
  /** The planning time, ISO 8601, recorded in the manifest and `state.json`. */
  readonly now: string;
  /** `user@host`, recorded in the manifest and `state.json`. */
  readonly by: string;
  /**
   * The resolved env split: `clear` entries become `-e` flags, `secret`
   * entries the release's secrets file. Absent, every `config.env` entry is a
   * name-only reference (a preview).
   */
  readonly env?: ResolvedEnv;
}

/** The release a deploy runs: built, pushed, and pinned before the plan. */
export interface PlannedRelease {
  /** `YYYYMMDDHHMMSS-<sha12>` (`release-id.ts`). */
  readonly id: string;
  /** `config.image@sha256:…`, or `config.image@<digest>` for a preview. */
  readonly image: string;
  readonly git: { readonly sha: string; readonly dirty: boolean };
  /** The SHA-256 of the secrets file the release is written with. */
  readonly secretsSha256: string;
  /** The names the secrets file holds, sorted. */
  readonly secretNames: readonly string[];
  /** The jsails version that planned it. */
  readonly jsailsVersion: string;
}

/** The deterministic, value-free release plan. */
export interface ProductionPlan {
  /** `deploy` starts a new release; `rollback` runs the previous one again. */
  readonly kind: 'deploy' | 'rollback';
  /** A preview (a dry run): planned without a pushed digest or a lock, never executed. */
  readonly preview: boolean;
  /** The release this plan makes live. */
  readonly releaseId: string;
  /** The image it runs, pinned by digest. */
  readonly imageRef: string;
  /** The web container it starts. */
  readonly containerName: string;
  /** The live and previous releases once the plan has run. */
  readonly live: string;
  readonly previous: string | null;
  /** What the host was reconciled to before the plan. */
  readonly reconciled: Reconciled;
  /**
   * The public URL of the health path. Only an injected `HealthCheck` probes
   * it; the default health step probes the new container from inside it.
   */
  readonly healthUrl: string;
  /** The production server every remote step targets. */
  readonly server: string;
  /** The ssh user's home the bind-mount sources are built on. */
  readonly hostHome: string;
  /** `config.health.timeoutMs` (defaults applied); the per-probe health timeout. */
  readonly healthTimeoutMs: number;
  /** `config.health.intervalMs` (defaults applied); the health poll interval. */
  readonly healthIntervalMs: number;
  /** `config.health.retries` (undefined when unset); the executor applies its default. */
  readonly healthRetries: number | undefined;
  /** `config.health.retryDelayMs` (undefined when unset); the executor applies its default. */
  readonly healthRetryDelayMs: number | undefined;
  /** `config.health.readinessDelayMs` (undefined when unset); slept once before the first probe. */
  readonly healthReadinessDelayMs: number | undefined;
  /** `config.env` reduced to names plus a secret flag; never a value. */
  readonly env: readonly ProductionEnvEntry[];
  /** `config.volumes` as `{ name, containerPath }`, sorted by name. */
  readonly volumes: readonly ProductionVolumeEntry[];
  /** The ordered steps as data. */
  readonly steps: readonly ProductionStep[];
  /** Deterministic reminders (registry login, a dirty tree); never a secret. */
  readonly warnings: readonly string[];
  /** The ssh argv that removes the new container after a failed release step. */
  readonly cleanupArgv: readonly string[];
}

/** The kamal-proxy route options the app's service is deployed with. */
export interface AppProxyRoute {
  /** The cache proxy when it is enabled, else the app container, on its port. */
  readonly target: string;
  /** The path kamal-proxy health-checks the target on before it routes to it. */
  readonly healthCheckPath: string;
  /** Whether kamal-proxy keeps the incoming chain (`--forward-headers`). */
  readonly forwardHeaders: boolean;
}

/**
 * The route kamal-proxy serves the app through, for the release running in
 * `containerName`. kamal-proxy's `deploy` replaces every option of a service,
 * so each `deploy` of the app's service (the release switch, `jamal domain
 * add`) passes this whole route: one that dropped `--forward-headers` or
 * bypassed the cache proxy would put a different topology in front of the
 * app than the one its `JSAILS_TRUSTED_PROXIES` states.
 */
export function appProxyRoute(config: JamalConfig, containerName: string): AppProxyRoute {
  return {
    target:
      config.cacheProxy?.enabled === true
        ? `${CACHE_PROXY_CONTAINER_NAME}:${CACHE_PROXY_PORT_DEFAULT}`
        : `${containerName}:${PRODUCTION_APP_PORT}`,
    healthCheckPath: config.health?.path ?? DEFAULT_HEALTH_PATH,
    forwardHeaders: config.proxy.forwardHeaders,
  };
}

/**
 * The web container of the live release on the observed host, by the
 * reconciled truth, or `undefined` when nothing of the app is live.
 */
export function liveWebContainer(config: JamalConfig, observed: ObservedState): string | undefined {
  const live = reconcile(observed).live;
  if (live === null) return undefined;
  return (
    observed.manifests.get(live)?.roles[WEB_ROLE]?.container ??
    appContainerName(config.service, config.production?.destination, WEB_ROLE, live)
  );
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
 * A host volume source as the server's Docker daemon must receive it:
 * absolute. A source relative to the project locally (`./`, or `$PWD/`,
 * which Compose expands) is relative to the ssh user's `home` on the server.
 */
function productionHostSource(source: string, home: string): string {
  for (const prefix of ['$PWD/', './']) {
    if (source.startsWith(prefix)) return absoluteHostPath(home, source.slice(prefix.length));
  }
  return source;
}

/** Whether `image` is `repository` pinned by digest, or its preview placeholder. */
function isReleaseImage(image: string, repository: string, preview: boolean): boolean {
  if (preview && image === `${repository}@${DIGEST_PLACEHOLDER}`) return true;
  return isPinnedImage(image) && image.startsWith(`${repository}@`);
}

/** The pieces every release plan shares, derived from the config alone. */
interface ReleaseFrame {
  readonly server: string;
  readonly health: JamalHealthConfig;
  readonly healthUrl: string;
  readonly env: readonly ProductionEnvEntry[];
  readonly volumes: readonly ProductionVolumeEntry[];
  readonly accessorySteps: readonly ProductionStep[];
  readonly accessoryContainers: readonly string[];
  readonly accessoryEnvFlags: readonly string[];
  readonly warnings: string[];
}

function releaseFrame(config: JamalConfig): ReleaseFrame {
  const production = config.production;
  if (production === undefined) {
    throw new JamalConfigError('config.production is required to plan a production deployment');
  }
  const { server, domain, registry } = production;
  if (domain !== undefined) {
    assertProxyValue(
      domain,
      'config.production.domain',
      (message) => new JamalConfigError(message),
    );
  }
  const health: JamalHealthConfig = config.health ?? {
    path: DEFAULT_HEALTH_PATH,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    intervalMs: DEFAULT_INTERVAL_MS,
    retries: undefined,
    retryDelayMs: undefined,
    readinessDelayMs: undefined,
  };
  // A domain implies a TLS terminator, so the public URL is https; a bare
  // server has no certificate, so it is plain http.
  const healthUrl = `${domain === undefined ? 'http' : 'https'}://${domain ?? server}${health.path}`;
  const accessoryPlan = planAccessories(config);
  const env = Object.entries(config.env)
    .map(([name, entry]) => ({
      name,
      secret: entry.value instanceof SecretRef,
      alias: entry.alias,
      clear: entry.clear,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const volumes = Object.entries(config.volumes)
    .map(([name, spec]) => ({
      name,
      source: spec.source,
      containerPath: spec.containerPath,
      options: spec.options,
      host: spec.host,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const warnings: string[] = [];
  if (registry !== undefined) {
    warnings.push(`Sign in to the registry before pushing: docker login ${registry.server}.`);
  }
  return {
    server,
    health,
    healthUrl,
    env,
    volumes,
    accessorySteps: accessoryPlan.steps,
    accessoryContainers: accessoryPlan.containers,
    accessoryEnvFlags: accessoryPlan.appEnv.flatMap((entry) => [
      '-e',
      `${entry.name}=${entry.value}`,
    ]),
    warnings,
  };
}

/** What one release's container steps need. */
interface RunTarget {
  readonly releaseId: string;
  readonly image: string;
  readonly container: string;
  /** The command after the image, as the release's manifest records it. */
  readonly command: readonly string[];
}

/** The release-independent arguments of {@link planSteps}. */
interface StepInput {
  readonly config: JamalConfig;
  readonly frame: ReleaseFrame;
  readonly context: PlanContext;
  readonly observed: ObservedState;
  readonly reconciled: Reconciled;
  readonly target: RunTarget;
  /** The manifest to create, for a deploy; a rollback reuses the release's own. */
  readonly manifest: ReleaseManifest | undefined;
  readonly preview: boolean;
}

/** The reason a repair rewrites `state.json`, as the step describes it. */
const REPAIR_DESCRIPTIONS: Readonly<Record<RepairReason, string>> = {
  missing: 'it is missing',
  unreadable: 'it is not a v1 document',
  'live-mismatch': 'the proxy serves another release',
  'route-missing': 'the proxy serves nothing for the app',
  'route-unknown': 'the proxy serves a container that is no release of the app',
  'previous-missing': 'its previous release cannot be returned to',
};

/** `state` as the text a state write carries. */
function stateText(state: HostState): string {
  return Buffer.from(encodeHostState(state)).toString('utf8');
}

/**
 * The release a rollback returns to once `target` is live: the release live
 * before it, or, when nothing was live (a dead host), the last release the
 * host could return to, so a deploy over a dead release keeps a way back.
 */
function previousAfter(reconciled: Reconciled, target: string): string | null {
  if (reconciled.live === target) return reconciled.previous;
  const prior = reconciled.live ?? reconciled.previous;
  return prior === target ? null : prior;
}

/** The ordered steps that make `input.target` live. */
function planSteps(input: StepInput): { steps: ProductionStep[]; previous: string | null } {
  const { config, frame, context, observed, reconciled, target, manifest, preview } = input;
  const production = config.production!;
  const { server } = frame;
  const service = config.service;
  const destination = production.destination;
  const home = context.hostHome;
  const ssh = (argv: readonly string[]): readonly string[] => ['ssh', server, ...argv];

  const steps: ProductionStep[] = [];
  const stateFile = hostStateFile(service, destination);
  // Each state write replaces exactly the bytes the run observed or wrote.
  let stateExpect =
    observed.hostState.kind === 'absent' ? WRITE_EXPECT_ABSENT : observed.hostState.sha256;
  if (reconciled.repair !== undefined) {
    const repaired: HostState = {
      v: HOST_STATE_VERSION,
      seq: context.seq,
      live: reconciled.live,
      previous: reconciled.previous,
      updatedAt: context.now,
      by: context.by,
    };
    const text = stateText(repaired);
    steps.push({
      kind: 'repair-state',
      description: `Rewrite ${stateFile}: ${REPAIR_DESCRIPTIONS[reconciled.repair.reason]}.`,
      file: {
        path: stateFile,
        mode: STATE_MODE,
        directoryMode: APP_DIRECTORY_MODE,
        source: 'text',
        contents: text,
        expect: reconciled.repair.expect,
      },
    });
    stateExpect = sha256Hex(Buffer.from(text, 'utf8'));
  }

  steps.push({
    kind: 'network',
    description: `Ensure the ${JAMAL_NETWORK} Docker network on ${server} and attach the proxy and accessories to it.`,
    argv: ssh(ensureNetworkArgv([PROXY_CONTAINER_NAME, ...frame.accessoryContainers])),
  });
  steps.push(...frame.accessorySteps);
  steps.push({
    kind: 'pull',
    description: `Pull ${target.image} on ${server}.`,
    argv: ssh(['docker', 'pull', target.image]),
  });

  const secrets = releaseSecretsLayout(service, destination, target.releaseId, home);
  if (manifest !== undefined) {
    steps.push({
      kind: 'secrets-file',
      description: `Write the release's secrets file (${manifest.secretNames.length} entries) to ${secrets.hostFile}.`,
      file: {
        path: secrets.hostFile,
        mode: SECRETS_FILE_MODE,
        directoryMode: SECRETS_DIRECTORY_MODE,
        source: 'secrets',
        expect: WRITE_EXPECT_ABSENT,
      },
    });
  }

  // The app listens on every interface inside its container, on a fixed port
  // the proxy and the cache proxy target. JSAILS_ENV and the NODE_ENV it
  // derives are set because the image need not set them, and an unset
  // JSAILS_ENV boots the app as development. A clear `JSAILS_ENV` entry
  // chooses the environment; NODE_ENV follows it here because the app
  // refuses a NODE_ENV that disagrees. The trusted-proxy setting follows from
  // the proxies this deploy puts in front of the container.
  const containerEnvironment = containerEnvironmentOf(context.env);
  const releaseEnvFlags = [
    '-e',
    `JSAILS_ENV=${containerEnvironment}`,
    '-e',
    `NODE_ENV=${deriveNodeEnv(containerEnvironment)}`,
    '-e',
    'JSAILS_HOST=0.0.0.0',
    '-e',
    `JSAILS_PORT=${PRODUCTION_APP_PORT}`,
    '-e',
    trustedProxiesVariable(config),
    ...frame.accessoryEnvFlags,
    ...(context.env === undefined ? [] : clearEnvFlags(context.env)),
  ];
  // The deploy check sees exactly the variables the web container will and
  // needs nothing else: no volume but its secrets, and no network.
  steps.push({
    kind: 'check',
    description: `Check the app config in ${target.image} with the release environment (jsails check --deploy).`,
    argv: ssh([
      'docker',
      'run',
      '--rm',
      '--network',
      'none',
      ...releaseEnvFlags,
      ...secrets.runFlags,
      target.image,
      ...DEPLOY_CHECK_COMMAND,
    ]),
  });

  if (manifest !== undefined) {
    const manifestFile = hostManifestFile(service, destination, target.releaseId);
    steps.push({
      kind: 'manifest',
      description: `Record the release manifest at ${manifestFile}.`,
      file: {
        path: manifestFile,
        mode: MANIFEST_MODE,
        directoryMode: RELEASE_DIRECTORY_MODE,
        source: 'text',
        // A preview's image is not pinned yet, which the encoder refuses.
        contents: preview
          ? `${JSON.stringify(manifest, null, 2)}\n`
          : Buffer.from(encodeManifest(manifest)).toString('utf8'),
        expect: WRITE_EXPECT_ABSENT,
      },
    });
  }

  // Every volume becomes a -v flag on the run step. A named volume is
  // prefixed with the service, as Compose prefixes it with the project name
  // locally, so two apps on one server never share a volume by accident.
  const volumeFlags = frame.volumes.flatMap((v) => {
    if (!v.host) return ['-v', `${service}_${v.name}:${v.containerPath}`];
    const source = productionHostSource(v.source, home);
    return [
      '-v',
      v.options ? `${source}:${v.containerPath}:${v.options}` : `${source}:${v.containerPath}`,
    ];
  });
  // A rollback after a run killed before its retire finds the target's
  // container still running (and perhaps still serving): it is reused, and
  // no failure may remove it, since it is not this run's to remove.
  const reused = observed.containers.some(
    (container) => container.name === target.container && container.state === 'running',
  );
  if (!reused) {
    steps.push({
      kind: 'run',
      description: `Start ${target.container} from ${target.image} on ${server}.`,
      // No cleanup on a failed run: the run removes what it created itself,
      // and a name conflict means the container is not this release's.
      argv: ssh(
        remoteOpArgv({
          kind: 'container.run-fresh',
          name: target.container,
          run: [
            'docker',
            'run',
            '-d',
            '--name',
            target.container,
            '--network',
            JAMAL_NETWORK,
            '--restart',
            'unless-stopped',
            '--label',
            `${APP_LABELS.service}=${service}`,
            '--label',
            `${APP_LABELS.destination}=${destination ?? ''}`,
            '--label',
            `${APP_LABELS.role}=${WEB_ROLE}`,
            '--label',
            `${APP_LABELS.release}=${target.releaseId}`,
            ...releaseEnvFlags,
            ...secrets.runFlags,
            ...volumeFlags,
            ...logDriverFlags(config),
            target.image,
            ...target.command,
          ],
        }),
      ),
    });
  }
  steps.push({
    kind: 'health',
    description: `Probe ${frame.health.path} inside ${target.container} (${frame.health.timeoutMs} ms per probe) until it responds.`,
    argv: ssh([
      'docker',
      'exec',
      target.container,
      'node',
      '-e',
      healthProbeScript(frame.health.path, frame.health.timeoutMs),
    ]),
    cleanupOnFailure: !reused,
  });

  // Behind the cache proxy kamal-proxy routes to Varnish, and Varnish to the
  // app: the VCL naming the new container is loaded after the app is healthy
  // and before the switch, so Varnish serves before traffic arrives.
  const cacheProxyEnabled = config.cacheProxy?.enabled === true;
  if (cacheProxyEnabled) {
    const image = config.cacheProxy?.image ?? CACHE_PROXY_IMAGE_DEFAULT;
    const size = config.cacheProxy?.size ?? CACHE_PROXY_SIZE_DEFAULT;
    steps.push(
      {
        kind: 'cache-proxy:write-vcl',
        description: `Write the cache-proxy VCL to ${CACHE_PROXY_HOST_VCL_FILE} on ${server}.`,
        file: {
          path: CACHE_PROXY_HOST_VCL_FILE,
          mode: CACHE_PROXY_VCL_MODE,
          directoryMode: CACHE_PROXY_VCL_DIRECTORY_MODE,
          source: 'text',
          contents: resolveVcl(target.container, PRODUCTION_APP_PORT, {
            cookieAllowlist: config.cacheProxy?.cookieAllowlist,
          }),
        },
        cleanupOnFailure: !reused,
      },
      {
        kind: 'cache-proxy:boot',
        description: `Reload the cache-proxy VCL on ${server}, or boot the Varnish container (image ${image}).`,
        argv: ssh(
          remoteOpArgv({
            kind: 'cache-proxy.load',
            name: CACHE_PROXY_CONTAINER_NAME,
            image,
            boot: cacheProxyBootArgv({ home, image, size }),
          }),
        ),
      },
      {
        kind: 'cache-proxy:health',
        description: `Wait for the Varnish cache-proxy container to become healthy on ${server}.`,
        argv: ssh(cacheProxyHealthArgv()),
      },
    );
  }

  const route = appProxyRoute(config, target.container);
  const { domain, onDemandTlsUrl } = production;
  steps.push({
    kind: 'switch',
    // kamal-proxy keeps the previous target when a deploy fails its health
    // check, so the new container never served and can go.
    cleanupOnFailure: !cacheProxyEnabled && !reused,
    description: cacheProxyEnabled
      ? `Switch the proxy to route traffic to the cache-proxy container ${route.target}.`
      : `Switch the proxy to route traffic to ${route.target}.`,
    argv:
      domain !== undefined
        ? ssh(proxyDeployArgv({ service, ...route, host: domain, tls: true }))
        : onDemandTlsUrl !== undefined
          ? ssh(proxyDeployArgv({ service, ...route, onDemandTlsUrl, tls: true }))
          : undefined,
  });

  const previous = previousAfter(reconciled, target.releaseId);
  steps.push({
    kind: 'state',
    description: `Record ${target.releaseId} as live${previous === null ? '' : ` and ${previous} as previous`} in ${stateFile}.`,
    file: {
      path: stateFile,
      mode: STATE_MODE,
      directoryMode: APP_DIRECTORY_MODE,
      source: 'text',
      contents: stateText({
        v: HOST_STATE_VERSION,
        seq: context.seq,
        live: target.releaseId,
        previous,
        updatedAt: context.now,
        by: context.by,
      }),
      expect: stateExpect,
    },
  });

  // Every other container of the app goes once the new release is live and
  // recorded: the release that served before, and whatever a killed run or
  // another checkout left behind.
  for (const container of observed.containers) {
    if (container.name === target.container) continue;
    steps.push({
      kind: 'retire',
      description: `Stop and remove ${container.name} on ${server}.`,
      argv: ssh(remoteOpArgv({ kind: 'container.retire', name: container.name })),
    });
  }
  return { steps, previous };
}

/** The plan both kinds return, around their steps. */
function assemble(
  kind: 'deploy' | 'rollback',
  input: StepInput,
  planned: { steps: ProductionStep[]; previous: string | null },
): ProductionPlan {
  const { frame, target } = input;
  return {
    kind,
    preview: input.preview,
    releaseId: target.releaseId,
    imageRef: target.image,
    containerName: target.container,
    live: target.releaseId,
    previous: planned.previous,
    reconciled: input.reconciled,
    healthUrl: frame.healthUrl,
    server: frame.server,
    hostHome: input.context.hostHome,
    healthTimeoutMs: frame.health.timeoutMs,
    healthIntervalMs: frame.health.intervalMs,
    healthRetries: frame.health.retries,
    healthRetryDelayMs: frame.health.retryDelayMs,
    healthReadinessDelayMs: frame.health.readinessDelayMs,
    env: frame.env,
    volumes: frame.volumes,
    steps: planned.steps,
    warnings: frame.warnings,
    cleanupArgv: ['ssh', frame.server, 'docker', 'rm', '-f', target.container],
  };
}

/**
 * Refuse to plan for a routed app whose kamal-proxy is not running: the
 * switch would fail after the release had already been pulled, recorded, and
 * started, and a repair would judge `state.json` against a proxy that says
 * nothing.
 */
function assertProxyRunning(observed: ObservedState): void {
  if (observed.web.kind === 'proxy-down') throw new PlanErrors.Error('proxy_down');
}

/** The pinned kamal-proxy image the release is served through, refusing an unpinned one. */
function proxyImageOf(config: JamalConfig, observed: ObservedState): string | null {
  const proxy = observed.proxyImage;
  if (proxy.kind === 'pinned') return proxy.image;
  if (proxy.kind === 'unpinned' && isRouted(config)) throw new PlanErrors.Error('unpinned_proxy');
  return null;
}

/** Options for {@link planRelease}. */
export interface PlanReleaseOptions extends PlanContext {
  readonly release: PlannedRelease;
  readonly observed: ObservedState;
  /** Plan a preview: the image may carry {@link DIGEST_PLACEHOLDER}. */
  readonly preview?: boolean;
}

/** Plan a deploy of `options.release` onto the observed host. */
export function planRelease(config: JamalConfig, options: PlanReleaseOptions): ProductionPlan {
  const frame = releaseFrame(config);
  const preview = options.preview === true;
  const { release, observed } = options;
  const hostHome = assertHostHome(options.hostHome);
  if (!isReleaseId(release.id) || !isReleaseImage(release.image, config.image, preview)) {
    throw new PlanErrors.Error('invalid_release');
  }
  assertProxyRunning(observed);
  const reconciled = reconcile(observed);
  const previous = previousAfter(reconciled, release.id);
  const destination = config.production!.destination;
  const container = appContainerName(config.service, destination, WEB_ROLE, release.id);
  const command = config.command === undefined ? [] : splitCommandLine(config.command);
  const cacheProxyImage =
    config.cacheProxy?.enabled === true
      ? (config.cacheProxy.image ?? CACHE_PROXY_IMAGE_DEFAULT)
      : undefined;
  const manifest: ReleaseManifest = {
    v: MANIFEST_VERSION,
    releaseId: release.id,
    image: release.image,
    git: { sha: release.git.sha, dirty: release.git.dirty },
    roles: {
      [WEB_ROLE]: {
        container,
        command,
        replicas: 1,
      },
    },
    secretNames: [...release.secretNames],
    secretsSha256: release.secretsSha256,
    configSha256: configDigest(config),
    jsailsVersion: release.jsailsVersion,
    infra: {
      proxyImage: proxyImageOf(config, observed),
      ...(cacheProxyImage === undefined ? {} : { cacheProxyImage }),
    },
    release: { ran: false, exit: null },
    ...(previous === null ? {} : { previous }),
    createdAt: options.now,
    by: options.by,
  };
  if (release.git.dirty) {
    frame.warnings.push(
      `Deploying uncommitted changes (--allow-dirty): the release records commit ${release.git.sha.slice(0, 12)} with a dirty tree.`,
    );
  }
  const input: StepInput = {
    config,
    frame,
    context: { ...options, hostHome },
    observed,
    reconciled,
    target: { releaseId: release.id, image: release.image, container, command },
    manifest,
    preview,
  };
  return assemble('deploy', input, planSteps(input));
}

/** Options for {@link planRollback}. */
export interface PlanRollbackOptions extends PlanContext {
  readonly observed: ObservedState;
  /** Plan a preview, which the executor refuses. */
  readonly preview?: boolean;
}

/**
 * Plan a rollback to the reconciled previous release: its image by the
 * digest its manifest records, its own secrets file, and the web container
 * and command its manifest records, whatever the config says now. Throws
 * `jamal_plan.no_previous` when there is none, `jamal_plan.secrets_missing`
 * when its secrets file is gone, and `jamal_plan.no_web_role` when its
 * manifest records no web role.
 */
export function planRollback(config: JamalConfig, options: PlanRollbackOptions): ProductionPlan {
  const frame = releaseFrame(config);
  const { observed } = options;
  const hostHome = assertHostHome(options.hostHome);
  assertProxyRunning(observed);
  const reconciled = reconcile(observed);
  const target = reconciled.previous;
  const manifest = target === null ? undefined : observed.manifests.get(target);
  if (target === null || manifest === undefined) throw new PlanErrors.Error('no_previous');
  if (!observed.secrets.has(target)) throw new PlanErrors.Error('secrets_missing');
  const web = manifest.roles[WEB_ROLE];
  if (web === undefined) throw new PlanErrors.Error('no_web_role');
  frame.warnings.push(
    `Rolling back to ${target}: it runs the image, command, and secrets it was deployed with; ` +
      'a migration applied since must still be compatible with it.',
  );
  const input: StepInput = {
    config,
    frame,
    context: { ...options, hostHome },
    observed,
    reconciled,
    target: {
      releaseId: target,
      image: manifest.image,
      container: web.container,
      command: web.command,
    },
    manifest: undefined,
    preview: options.preview === true,
  };
  return assemble('rollback', input, planSteps(input));
}

/**
 * Render a {@link ProductionPlan} as a deterministic, plain-text preview for
 * `jamal deploy --dry-run` / `jamal rollback --dry-run`: the release, what
 * the host was reconciled to, then each step's kind and description with the
 * command it runs, shell-quoted exactly as the remote shell receives it. A
 * file step shows the write command; its bytes go on stdin. No secret value
 * appears, because the plan holds none.
 */
export function formatProductionPlan(plan: ProductionPlan): string {
  const reconciled = plan.reconciled;
  const lines: string[] = [
    `release: ${plan.releaseId}`,
    `image: ${plan.imageRef}`,
    `container: ${plan.containerName}`,
    `live now: ${reconciled.live ?? 'none'}`,
    `previous now: ${reconciled.previous ?? 'none'}`,
  ];
  if (plan.imageRef.endsWith(`@${DIGEST_PLACEHOLDER}`)) {
    lines.push(`${DIGEST_PLACEHOLDER} stands for the digest the registry gives the pushed image`);
  }
  lines.push('');
  for (const step of plan.steps) {
    lines.push(`${step.kind}: ${step.description}`);
    const argv =
      step.file === undefined
        ? step.argv
        : [
            'ssh',
            plan.server,
            ...remoteWriteFileArgv(step.file.path, {
              mode: step.file.mode,
              directoryMode: step.file.directoryMode,
              ...(step.file.expect === undefined ? {} : { expect: step.file.expect }),
            }),
          ];
    if (argv !== undefined) {
      lines.push(`  $ ${argv.map((token) => shellQuote(token)).join(' ')}`);
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
