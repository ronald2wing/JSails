/**
 * Production service accessories for jamal.
 *
 * A production deploy runs more than the application container: the backing
 * services a config declares (`mariadb`, `postgres`, `valkey`) must exist on
 * the target server before the app starts, or the app fails its database/Valkey
 * connection at boot. {@link planAccessories} turns those services into
 * value-free accessory steps — a data-volume creation, a credentials env file
 * (when the service has credentials), a container start, and a health poll per
 * service, using the pinned images and volume names the local Compose planner
 * also uses (`service-conventions.ts`) — and {@link runAccessories} executes
 * them over the injected {@link RemoteRunner} with reuse semantics (an
 * already-existing container is never recreated) and a bounded health retry.
 *
 * Credentials never reach a plan or a command line. The plan records only
 * which container variable reads which `config.env` entry (by its container
 * name, the alias when one is set); {@link runAccessories} looks the values up
 * in the {@link ResolvedEnv} at execution time and writes them to a mode-0600
 * env file on the server that the container reads with `--env-file`. A
 * database accessory without a `DATABASE_PASSWORD` entry is refused at plan
 * time rather than initialised with an empty or guessable password.
 *
 * Every accessory joins the shared {@link JAMAL_NETWORK} network and publishes
 * no host port: the app reaches it by its container name (the
 * `config.services` key), which is what the app-facing env refs carry.
 */

import { JsailsError } from '../../errors/jsails-error.js';
import { Async } from '../../support/index.js';
import { JamalConfigError, type JamalConfig } from '../config/index.js';
import { encodeEnvFile } from '../env-file.js';
import type { ResolvedEnv } from '../env-resolve.js';
import type { CommandResult } from './process-runner.js';
import type { ReleaseLogger } from './release.js';
import type { ProductionStep } from './plan.js';
import type { RemoteRunner } from './transport.js';
import { accessoryEnvFilePath, JAMAL_NETWORK } from './host-layout.js';
import { RemoteFileError, writeRemoteFile } from './remote-file.js';
import {
  SERVICE_CONVENTIONS,
  isAccessoryServiceType,
  type AccessoryServiceType,
  type ServiceConvention,
} from '../service-conventions.js';

/** The accessory actions per service. */
export type AccessoryAction = 'volume' | 'env-file' | 'run' | 'health';

/** Hard cap on accessory health attempts before a deploy aborts. */
export const ACCESSORY_HEALTH_MAX_ATTEMPTS = 10;

/** Delay between accessory health attempts, in milliseconds. */
export const ACCESSORY_HEALTH_RETRY_DELAY_MS = 5000;

/** Why an accessory step failed. */
export type AccessoryErrorCode =
  'invalid_step' | 'missing_runner' | 'missing_env' | 'command_failed';

/** Raised for a failed accessory step; the message is value-free. */
export class AccessoryError extends JsailsError {
  constructor(
    readonly code: AccessoryErrorCode,
    /** The action that failed, so the deploy executor can name the step. */
    readonly action: AccessoryAction,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One variable of an accessory's env file: either a fixed, non-secret value or
 * the name of the resolved `config.env` entry whose value it takes.
 */
export interface AccessoryEnvSource {
  /** The variable name inside the accessory container. */
  readonly name: string;
  /** The resolved env entry (by container name) to read the value from. */
  readonly from?: string;
  /** A fixed value; never a credential. */
  readonly value?: string;
}

/** Structured metadata carried by an accessory {@link ProductionStep}. */
export interface AccessoryStep {
  readonly action: AccessoryAction;
  readonly service: AccessoryServiceType;
  /** The container name (`config.services` key) the run/health steps address. */
  readonly name: string;
  /** For an `env-file` step: the variables to write. Names only, never values. */
  readonly envSources?: readonly AccessoryEnvSource[];
}

/** An env entry appended to the app run step: a name and its value (never a secret). */
interface AccessoryEnvEntry {
  readonly name: string;
  readonly value: string;
}

/** The accessory plan: the prepended steps plus the app run-step env refs. */
interface AccessoryPlan {
  readonly steps: readonly ProductionStep[];
  readonly appEnv: readonly AccessoryEnvEntry[];
  /** The accessory container names, so the network step can attach existing ones. */
  readonly containers: readonly string[];
}

/** Options for {@link runAccessories}. */
interface RunAccessoriesOptions {
  readonly remoteRunner: RemoteRunner;
  readonly logger?: ReleaseLogger;
  /** Delay seam for the health retry loop; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The resolved env the `env-file` steps draw credential values from. */
  readonly env?: ResolvedEnv;
}

/** Container env var names a database image consumes for its bootstrap database. */
interface DatabaseEnvVars {
  readonly database: string;
  readonly user: string;
  readonly password: string;
  /** Fixed, non-secret variables the image also needs. */
  readonly fixed: readonly AccessoryEnvSource[];
}

const DATABASE_ENV_VARS: Readonly<Record<'mariadb' | 'postgres', DatabaseEnvVars>> = {
  // The MariaDB image refuses to initialise without a root-password policy;
  // a random root password keeps root unusable from outside the container.
  mariadb: {
    database: 'MARIADB_DATABASE',
    user: 'MARIADB_USER',
    password: 'MARIADB_PASSWORD',
    fixed: [{ name: 'MARIADB_RANDOM_ROOT_PASSWORD', value: '1' }],
  },
  postgres: {
    database: 'POSTGRES_DB',
    user: 'POSTGRES_USER',
    password: 'POSTGRES_PASSWORD',
    fixed: [],
  },
};

/**
 * The Valkey server command when a password is set. The password comes from
 * the env file and reaches the server as config on stdin (`valkey-server -`),
 * so it is in no argv, neither docker's nor the server's. The command goes
 * back through the image's `docker-entrypoint.sh`, which drops root to the
 * `valkey` user only when its first argument is `valkey-server`; a bare
 * `sh -c` command would leave the server running as root. The value is
 * escaped for a double-quoted config string (backslash and `"`), and the heredoc
 * keeps `exec` in the shell's own process, so the server is the container's
 * main process and receives `docker stop`'s SIGTERM.
 */
const VALKEY_AUTH_SCRIPT = [
  `p=$(printf '%s' "$VALKEY_PASSWORD" | sed 's/[\\\\"]/\\\\&/g')`,
  'exec docker-entrypoint.sh valkey-server - --appendonly yes <<EOF',
  'requirepass "$p"',
  'EOF',
].join('\n');

const VALKEY_AUTH_COMMAND = ['sh', '-c', VALKEY_AUTH_SCRIPT];

const SILENT_LOGGER: ReleaseLogger = { info: () => {}, warn: () => {} };

/** Whether `config.env` declares a variable the container sees as `name`. */
function declaresEnv(config: JamalConfig, name: string): boolean {
  return Object.entries(config.env).some(([key, entry]) => (entry.alias ?? key) === name);
}

/**
 * The env-file variables one accessory needs, or an empty list when it needs
 * none (a Valkey without a password). Throws when a database has no password.
 */
export function accessoryEnvSources(
  config: JamalConfig,
  type: AccessoryServiceType,
): readonly AccessoryEnvSource[] {
  if (type === 'valkey') {
    return declaresEnv(config, 'VALKEY_PASSWORD')
      ? [
          { name: 'REDISCLI_AUTH', from: 'VALKEY_PASSWORD' },
          { name: 'VALKEY_PASSWORD', from: 'VALKEY_PASSWORD' },
        ]
      : [];
  }
  if (!declaresEnv(config, 'DATABASE_PASSWORD')) {
    throw new JamalConfigError(
      `config.env must declare DATABASE_PASSWORD (usually secret('DATABASE_PASSWORD')) ` +
        `for a production ${type} accessory`,
    );
  }
  const vars = DATABASE_ENV_VARS[type];
  const sources: AccessoryEnvSource[] = [...vars.fixed];
  if (declaresEnv(config, 'DATABASE_NAME')) {
    sources.push({ name: vars.database, from: 'DATABASE_NAME' });
  }
  sources.push({ name: vars.password, from: 'DATABASE_PASSWORD' });
  if (declaresEnv(config, 'DATABASE_USER')) {
    sources.push({ name: vars.user, from: 'DATABASE_USER' });
  }
  return sources;
}

/**
 * The `docker run` argv (after `ssh <server>`) that starts one accessory
 * container, shared by {@link planAccessories} and the `jamal accessory`
 * lifecycle verbs so both start identical containers. `envFilePath` is the
 * credentials file the container reads; omit it for an accessory with no
 * credentials.
 */
export function accessoryRunArgv(
  type: AccessoryServiceType,
  name: string,
  envFilePath?: string,
): string[] {
  const convention: ServiceConvention = SERVICE_CONVENTIONS[type];
  const argv = [
    'docker',
    'run',
    '-d',
    '--restart',
    'unless-stopped',
    '--name',
    name,
    '--network',
    JAMAL_NETWORK,
    '-v',
    `${convention.volume}:${convention.dataDir}`,
  ];
  if (envFilePath !== undefined) {
    argv.push('--env-file', envFilePath);
  }
  argv.push(convention.image);
  if (type === 'valkey') {
    argv.push(...(envFilePath === undefined ? ['--appendonly', 'yes'] : VALKEY_AUTH_COMMAND));
  }
  return argv;
}

/** The health-probe argv (after `ssh <server>`) that proves one accessory is up. */
function healthArgv(type: AccessoryServiceType, name: string): string[] {
  if (type === 'mariadb') {
    return ['docker', 'exec', name, 'mariadb-admin', 'ping'];
  }
  if (type === 'postgres') {
    return ['docker', 'exec', name, 'pg_isready'];
  }
  // REDISCLI_AUTH, when a password is set, is in the container's own env file.
  return ['docker', 'exec', name, 'valkey-cli', 'ping'];
}

/** The env refs the app run step needs to reach one accessory by name. */
function appEnvEntries(
  type: AccessoryServiceType,
  name: string,
  convention: ServiceConvention,
): AccessoryEnvEntry[] {
  if (type === 'valkey') {
    return [{ name: 'VALKEY_URL', value: `redis://${name}:${convention.port}` }];
  }
  // Credentials are not repeated here: the app reads DATABASE_NAME/USER/
  // PASSWORD from its own env, and a `-e` copy would override the env file.
  return [
    { name: 'DATABASE_HOST', value: name },
    { name: 'DATABASE_PORT', value: String(convention.port) },
    { name: 'DATABASE_TYPE', value: type },
  ];
}

/**
 * Plan the production accessory steps for `config`: per backing service, a
 * volume-creation step, an env-file step when it has credentials, a
 * container-start step, and a health-poll step (all `ssh`-prefixed), plus the
 * app run-step env refs. Only `mariadb`/`postgres`/`valkey` become
 * accessories; every other service type is skipped. Pure and deterministic:
 * stable key order, no timestamps, and no secret value (only entry names).
 */
export function planAccessories(config: JamalConfig): AccessoryPlan {
  const production = config.production;
  if (production === undefined) {
    throw new JamalConfigError('config.production is required to plan production accessories');
  }
  const server = production.server;

  const steps: ProductionStep[] = [];
  const appEnv: AccessoryEnvEntry[] = [];
  const containers: string[] = [];

  for (const name of Object.keys(config.services).sort()) {
    const service = config.services[name];
    if (service === undefined || !isAccessoryServiceType(service.type)) {
      // Dev tools and local-only services (search, S3) have no production accessory.
      continue;
    }
    const type = service.type;
    const convention = SERVICE_CONVENTIONS[type];
    const envSources = accessoryEnvSources(config, type);
    const envFilePath =
      envSources.length === 0
        ? undefined
        : accessoryEnvFilePath(config.service, production.destination, name);
    containers.push(name);

    // `docker volume create` is idempotent, so it runs on every deploy.
    steps.push({
      kind: 'accessory',
      description: `Create the ${convention.volume} data volume for ${name} on ${server}.`,
      argv: ['ssh', server, 'docker', 'volume', 'create', convention.volume],
      accessory: { action: 'volume', service: type, name },
    });

    if (envFilePath !== undefined) {
      steps.push({
        kind: 'accessory',
        description: `Write the ${name} credentials env file (${envSources.length} entries) to ${envFilePath}.`,
        envFilePath,
        accessory: { action: 'env-file', service: type, name, envSources },
      });
    }

    steps.push({
      kind: 'accessory',
      description: `Start the ${type} container ${name} on ${server}.`,
      argv: ['ssh', server, ...accessoryRunArgv(type, name, envFilePath)],
      accessory: { action: 'run', service: type, name },
    });

    steps.push({
      kind: 'accessory',
      description: `Wait for the ${type} container ${name} to become healthy on ${server}.`,
      argv: ['ssh', server, ...healthArgv(type, name)],
      accessory: { action: 'health', service: type, name },
    });

    appEnv.push(...appEnvEntries(type, name, convention));
  }

  return { steps, appEnv, containers };
}

/**
 * Render an accessory env file from its sources and the resolved env. Throws a
 * value-free error naming only the missing entry when a source is unresolved.
 */
export function accessoryEnvFileContents(
  sources: readonly AccessoryEnvSource[],
  env: ResolvedEnv | undefined,
): string {
  const resolved = new Map<string, string>();
  for (const entry of [...(env?.clear ?? []), ...(env?.secret ?? [])]) {
    resolved.set(entry.name, entry.value);
  }
  const values: Record<string, string> = {};
  for (const source of sources) {
    const value = source.from === undefined ? source.value : resolved.get(source.from);
    if (value === undefined) {
      throw new AccessoryError(
        'missing_env',
        'env-file',
        `the accessory env file needs ${source.from ?? source.name}, which did not resolve`,
      );
    }
    values[source.name] = value;
  }
  return encodeEnvFile(values);
}

/** Run a step's `ssh <server> ...` argv over the remote runner, or reject. */
async function runAccessoryArgv(
  step: ProductionStep,
  remote: RemoteRunner,
): Promise<CommandResult> {
  const argv = step.argv;
  if (argv === undefined || argv[0] !== 'ssh' || argv[1] === undefined) {
    throw new AccessoryError('invalid_step', 'run', 'an accessory step has a malformed ssh argv');
  }
  return remote.run(argv[1], argv.slice(2));
}

/**
 * Start an accessory container unless it already exists. Reuse is the
 * in-place-deploy semantics: an existing container (identified by `docker
 * inspect` exit 0) is left alone so its data and uptime survive a redeploy.
 */
async function runAccessoryContainer(step: ProductionStep, remote: RemoteRunner): Promise<void> {
  const name = step.accessory?.name;
  const server = step.argv?.[1];
  if (name === undefined || server === undefined) {
    throw new AccessoryError('invalid_step', 'run', 'an accessory run step has no container name');
  }
  const inspect = await remote.run(server, ['docker', 'inspect', '--type', 'container', name]);
  if (inspect.exitCode === 0) {
    return;
  }
  const result = await runAccessoryArgv(step, remote);
  if (result.exitCode !== 0) {
    throw new AccessoryError('command_failed', 'run', 'the accessory container failed to start');
  }
}

/** Write an accessory's credentials env file from the resolved env. */
async function runAccessoryEnvFile(
  step: ProductionStep,
  server: string,
  options: RunAccessoriesOptions,
): Promise<void> {
  const sources = step.accessory?.envSources;
  const path = step.envFilePath;
  if (sources === undefined || path === undefined) {
    throw new AccessoryError(
      'invalid_step',
      'env-file',
      'an accessory env-file step has no sources or destination',
    );
  }
  const contents = accessoryEnvFileContents(sources, options.env);
  try {
    await writeRemoteFile(options.remoteRunner, server, path, contents);
  } catch (error) {
    if (error instanceof RemoteFileError) {
      throw new AccessoryError(
        'command_failed',
        'env-file',
        'the accessory env file could not be written',
      );
    }
    throw error;
  }
}

/** Poll an accessory health probe, bounded, then fail value-free. */
async function runAccessoryHealth(
  step: ProductionStep,
  remote: RemoteRunner,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; attempt <= ACCESSORY_HEALTH_MAX_ATTEMPTS; attempt += 1) {
    const result = await runAccessoryArgv(step, remote);
    if (result.exitCode === 0) {
      return;
    }
    if (attempt < ACCESSORY_HEALTH_MAX_ATTEMPTS) {
      await sleep(ACCESSORY_HEALTH_RETRY_DELAY_MS);
    }
  }
  throw new AccessoryError(
    'command_failed',
    'health',
    'the accessory health check did not become healthy',
  );
}

/**
 * Execute accessory steps in order over the injected remote runner. A failed
 * step raises an {@link AccessoryError} naming the action, so the deploy
 * executor can abort before the app release with a value-free error.
 * `server` addresses the `env-file` steps, which carry no ssh argv.
 */
export async function runAccessories(
  steps: readonly ProductionStep[],
  options: RunAccessoriesOptions & { readonly server?: string },
): Promise<void> {
  const { remoteRunner } = options;
  if (remoteRunner === undefined) {
    throw new AccessoryError('missing_runner', 'run', 'runAccessories requires a remote runner');
  }
  const logger = options.logger ?? SILENT_LOGGER;
  const sleep = options.sleep ?? Async.sleep;

  for (const step of steps) {
    logger.info(step.description);
    switch (step.accessory?.action) {
      case 'volume': {
        const result = await runAccessoryArgv(step, remoteRunner);
        if (result.exitCode !== 0) {
          throw new AccessoryError(
            'command_failed',
            'volume',
            'the accessory volume could not be created',
          );
        }
        break;
      }
      case 'env-file': {
        if (options.server === undefined) {
          throw new AccessoryError(
            'invalid_step',
            'env-file',
            'an accessory env-file step needs the target server',
          );
        }
        await runAccessoryEnvFile(step, options.server, options);
        break;
      }
      case 'run':
        await runAccessoryContainer(step, remoteRunner);
        break;
      case 'health':
        await runAccessoryHealth(step, remoteRunner, sleep);
        break;
      default:
        throw new AccessoryError(
          'invalid_step',
          'run',
          'an accessory step has no recognized action',
        );
    }
  }
}
