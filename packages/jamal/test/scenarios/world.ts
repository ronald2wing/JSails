/**
 * The world the jamal scenarios run in: one {@link FakeHost} behind one
 * {@link FakeRegistry}, and any number of developer checkouts that deploy to
 * it through the real `jamal` command.
 *
 * A checkout is a real git repository in a temporary directory with its own
 * `.jamal/` (so two checkouts share no local state, exactly like two
 * machines), its own local Docker model that builds from the files in the
 * tree, and its own connection to the host. Nothing is stubbed between the
 * verb and the host: `runJamalCommand` loads the config, resolves secrets,
 * reads git, builds and pushes, and drives the remote engine, and every
 * command it sends to the server is answered by the model. The one shared
 * seam is the clock: it advances a second per reading, so two deploys of
 * one commit within a real second still get distinct release ids.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { runJamalCommand, type JamalDeps } from '../../src/command.js';
import {
  normalizeJamalConfig,
  secret,
  SecretRef,
  type JamalConfig,
  type JamalConfigInput,
} from '../../src/config/index.js';
import { resolveJamalEnv } from '../../src/env-resolve.js';
import {
  runDeployExecution,
  type InterruptSignal,
  type SignalSource,
} from '../../src/production/execute.js';
import { APP_LABELS, hostLockDir } from '../../src/production/host-layout.js';
import { proxyBootArgv } from '../../src/production/proxy.js';
import { FakeHost, type FakeClient } from '../../src/testing/fake-host.js';
import {
  createLocalDocker,
  FakeRegistry,
  imageDigest,
  type LocalDocker,
} from '../../src/testing/fake-registry.js';

/** The service every scenario deploys. */
export const SERVICE = 'myapp';

/** Its image repository. */
export const IMAGE = 'ghcr.io/acme/myapp';

/** The production server's name; the model answers whatever name is used. */
const SERVER = '203.0.113.10';

/**
 * How many releases a host keeps after a deploy: the retention default
 * JOB-13 ships (`retain: 5`).
 */
export const RETAIN = 5;

/**
 * The scenarios drive server-facing verbs, which Windows refuses with
 * `unsupported_platform` (`platform.ts`), so they run on POSIX only.
 */
export const serverVerbs = {
  skip: process.platform === 'win32' && 'jamal server verbs are refused on Windows',
};

/** Options for {@link createWorld}. */
export interface WorldOptions {
  /** Declare a MariaDB (`db`) and a Valkey (`cache`) accessory. */
  readonly accessories?: boolean;
  /** Put the Varnish cache proxy between kamal-proxy and the app. */
  readonly cacheProxy?: boolean;
  /**
   * Literal `config.env` entries each checkout adds in a `jamal.config.js` of
   * its own, which the verb loads through the real config loader rather than
   * the seam, so a config the loader refuses fails inside the verb. The
   * world's {@link World.config} is the config without them.
   */
  readonly configFileEnv?: Readonly<Record<string, string>>;
  /** The ssh user and the home `pwd -P` prints for it; defaults to `deploy` in `/home/deploy`. */
  readonly sshUser?: { readonly name: string; readonly home: string };
}

/** The outcome of one `jamal` invocation. */
export interface JamalRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** One developer machine: a git checkout, its local Docker, and its link to the host. */
export interface Checkout {
  readonly name: string;
  readonly dir: string;
  readonly client: FakeClient;
  readonly docker: LocalDocker;
  /** Write `files` into the tree and commit them. */
  commit(message: string, files: Readonly<Record<string, string>>): void;
  /** Write `files` into the tree without committing (a dirty tree). */
  edit(files: Readonly<Record<string, string>>): void;
  /** The short hash of HEAD. */
  head(): string;
  /** The digest a build of the tree as it is now produces: what a deploy of it runs. */
  builtDigest(): string;
  /** Run `jamal <args>` in this checkout. */
  jamal(args: readonly string[]): Promise<JamalRun>;
  /**
   * Run a deploy through the release engine with interrupt seams: `signals`
   * stands in for the process's SIGINT/SIGTERM, and `onInterrupted` for the
   * re-raised signal that ends it.
   */
  deployWithSignals(
    signals: SignalSource,
    onInterrupted: (signal: InterruptSignal) => void,
  ): Promise<unknown>;
}

/** The host, the registry, the shared secrets, and the checkouts deploying there. */
export interface World {
  readonly host: FakeHost;
  readonly registry: FakeRegistry;
  readonly config: JamalConfig;
  /** The deploy secrets every checkout resolves, by name; change them to rotate. */
  readonly secrets: Record<string, string>;
  checkout(name: string): Checkout;
  /** Every command the host or a checkout's local Docker did not model. */
  unmodelled(): readonly (readonly string[])[];
  /** Remove every temporary checkout. */
  dispose(): void;
  /**
   * {@link World.dispose}, then fail when the host or a local
   * Docker received a command the model does not understand. The checkouts go
   * first so a failing scenario leaves nothing behind in the temp directory.
   */
  close(): void;
}

/**
 * A signal source a scenario fires by hand. `fire` reports whether anything
 * handled the signal; an unhandled SIGINT ends a real process at once.
 */
export function signalSource(): SignalSource & { fire(signal: InterruptSignal): boolean } {
  const emitter = new EventEmitter();
  return {
    once: (signal, listener) => emitter.once(signal, listener),
    removeListener: (signal, listener) => emitter.removeListener(signal, listener),
    fire: (signal) => emitter.emit(signal),
  };
}

/** The world's config input, without {@link WorldOptions.configFileEnv}. */
function worldConfigInput(options: WorldOptions): JamalConfigInput {
  return {
    service: SERVICE,
    image: IMAGE,
    // One probe, no retry: the model's apps answer at once or never, and a
    // retry would sleep for real.
    health: { path: '/up', timeoutMs: 1000, intervalMs: 1000, retries: 0 },
    production: { server: SERVER, domain: 'myapp.example' },
    env: {
      APP_SECRET: secret('APP_SECRET'),
      LOG_LEVEL: 'info',
      ...(options.accessories === true
        ? {
            DATABASE_PASSWORD: secret('DATABASE_PASSWORD'),
            DATABASE_USER: 'app',
            DATABASE_NAME: 'app',
          }
        : {}),
    },
    ...(options.accessories === true
      ? { services: { db: { type: 'mariadb' }, cache: { type: 'valkey' } } }
      : {}),
    ...(options.cacheProxy === true ? { cacheProxy: { enabled: true } } : {}),
  };
}

/**
 * The `jamal.config.js` a checkout writes for {@link WorldOptions.configFileEnv}:
 * the world's config with the extra entries, its secret references rebuilt
 * from their names (the only part of a `SecretRef` a module can spell).
 */
function configModule(options: WorldOptions, extra: Readonly<Record<string, string>>): string {
  const input = worldConfigInput(options);
  const env = Object.entries({ ...input.env, ...extra }).map(([key, value]) => {
    if (value instanceof SecretRef) {
      return `${JSON.stringify(key)}: secret(${JSON.stringify(value.name)})`;
    }
    return `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  });
  const configModuleUrl = new URL('../../src/config/index.js', import.meta.url).href;
  return [
    `import { secret } from ${JSON.stringify(configModuleUrl)};`,
    `export default { ...${JSON.stringify({ ...input, env: undefined })}, env: { ${env.join(', ')} } };`,
    '',
  ].join('\n');
}

/** Run git in `dir` with a fixed identity and no signing, failing loudly. */
function git(dir: string, args: readonly string[]): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Scenario',
      '-c',
      'user.email=scenario@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd: dir, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** Every file of the build context (the tree without `.git` and `.jamal`), as one string. */
function buildContext(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === '.git' || entry.name === '.jamal') continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else parts.push(`${relative(dir, path)}\0${readFileSync(path, 'utf8')}`);
    }
  };
  walk(dir);
  return parts.join('\0\0');
}

/** A new world: an empty server with kamal-proxy booted from its pinned default image. */
export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const registry = new FakeRegistry();
  const host = new FakeHost({
    registry,
    ...(options.sshUser === undefined
      ? {}
      : { user: options.sshUser.name, home: options.sshUser.home }),
  });
  const boot = await host.run(SERVER, proxyBootArgv());
  if (boot.exitCode !== 0) throw new Error('the model could not boot kamal-proxy');
  const config = normalizeJamalConfig(worldConfigInput(options));
  const secrets: Record<string, string> = {
    APP_SECRET: 'first-secret',
    ...(options.accessories === true ? { DATABASE_PASSWORD: 'db-password' } : {}),
  };
  const dirs: string[] = [];
  const dockers: LocalDocker[] = [];
  let clock = Date.parse('2026-11-23T10:00:00.000Z');
  const now = (): Date => {
    clock += 1000;
    return new Date(clock);
  };

  const checkout = (name: string): Checkout => {
    const dir = mkdtempSync(join(tmpdir(), `jamal-scenario-${name}-`));
    dirs.push(dir);
    git(dir, ['init', '-q']);
    writeFileSync(join(dir, 'Dockerfile'), 'FROM node:26-slim\nCOPY . .\n');
    writeFileSync(join(dir, 'app.js'), 'export const version = 1;\n');
    if (options.configFileEnv !== undefined) {
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
      writeFileSync(join(dir, 'jamal.config.js'), configModule(options, options.configFileEnv));
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'initial']);

    const docker = createLocalDocker({
      registry,
      context: () => ({
        content: buildContext(dir),
        behaviour: { healthy: !existsSync(join(dir, 'UNHEALTHY')) },
      }),
    });
    dockers.push(docker);
    const client = host.connect(name);
    const deps = (out: string[], err: string[]): JamalDeps => ({
      cwd: dir,
      platform: 'linux',
      ...(options.configFileEnv === undefined ? { loadJamalConfig: async () => config } : {}),
      loadSecrets: () => ({ values: Object.freeze({ ...secrets }), files: [] }),
      now,
      processRunner: docker.runner,
      remoteRunner: client,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });

    const write = (files: Readonly<Record<string, string>>): void => {
      for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
    };

    return {
      name,
      dir,
      client,
      docker,
      commit(message, files) {
        write(files);
        git(dir, ['add', '-A']);
        git(dir, ['commit', '-q', '-m', message]);
      },
      edit: write,
      head: () => git(dir, ['rev-parse', '--short', 'HEAD']).trim(),
      builtDigest: () => imageDigest(buildContext(dir)),
      async jamal(args) {
        const out: string[] = [];
        const err: string[] = [];
        const code = await runJamalCommand(args, deps(out, err));
        return { code, out: out.join('\n'), err: err.join('\n') };
      },
      async deployWithSignals(signals, onInterrupted) {
        return runDeployExecution({
          config,
          commandRunner: docker.runner,
          remoteRunner: client,
          cwd: dir,
          env: resolveJamalEnv(config, { values: { ...secrets }, files: [] }),
          logger: { info: () => {}, warn: () => {} },
          now,
          signals,
          onInterrupted,
          lockOwner: { who: name, host: 'scenario', since: now().toISOString() },
        });
      },
    };
  };

  const unmodelled = (): readonly (readonly string[])[] => [
    ...host.unmodelled,
    ...dockers.flatMap((docker) => docker.unmodelled),
  ];
  const dispose = (): void => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  };

  return {
    host,
    registry,
    config,
    secrets,
    checkout,
    unmodelled,
    dispose,
    close() {
      dispose();
      assert.deepEqual(unmodelled(), [], 'the engine sent only modelled commands');
    },
  };
}

/** The app containers of the service on the host (labelled by the engine). */
export function appContainers(world: World): ReturnType<FakeHost['docker']['containers']> {
  return world.host.docker
    .containers()
    .filter((container) => container.labels[APP_LABELS.service] === SERVICE);
}

/** The release a container of the app runs (its `jsails.release` label). */
export function releaseOf(container: {
  readonly labels: Readonly<Record<string, string>>;
}): string {
  const release = container.labels[APP_LABELS.release];
  assert.ok(release !== undefined, 'every app container is labelled with its release');
  return release;
}

/** The app containers that are running. */
export function runningAppContainers(world: World): ReturnType<FakeHost['docker']['containers']> {
  return appContainers(world).filter((container) => container.state === 'running');
}

/** The local images of the app's repository on the host. */
export function appImages(world: World): ReturnType<FakeHost['docker']['images']> {
  return world.host.docker.images().filter((image) => image.repository === IMAGE);
}

/** Whether the service's deploy lock is held on the host. */
export function lockHeld(world: World): boolean {
  return world.host.fs.directory(hostLockDir(SERVICE, undefined)) !== undefined;
}

/**
 * What the app container `name` reads for the variable `key`: its real
 * environment over its release's secrets file, as the JSails resolver
 * layers them.
 */
export function appValue(world: World, name: string, key: string): string | undefined {
  const container = world.host.docker.container(name);
  return container === undefined ? undefined : world.host.docker.appEnvironment(container)[key];
}
