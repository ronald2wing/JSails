/**
 * The `jamal` stage of `scripts/verify-integrations.mjs`: `@jsails/jamal`
 * driving real Docker containers from freshly generated apps.
 *
 * The stage packs the framework and the plugins the `--admin` preset installs
 * (verify:starter's `packWorkspaces`), scaffolds a throwaway `--admin` app with
 * the real `jsails create --install` against those tarballs, and a second
 * `--admin` app with that app's packed CLI under another name, sharing the
 * first one's install, plus a third app created under the first one's name
 * in another directory. Each follows the documented first run: `.env` is
 * copied from the committed `.env.auth.example` with the blank database values
 * filled in. It then asserts:
 *
 *  - `jsails create` wrote each app's name as its Jamal service, so the two
 *    apps have different Compose projects;
 *  - the package's own bin (`npx jamal`), not only the `jsails jamal`
 *    forwarder, loads the project's environment as the framework does: the
 *    first app's MariaDB starts only when Compose interpolated its `.env`
 *    credentials, and the database it created is the one `.env.local` names
 *    over a decoy in `.env`, a layering Compose itself never applies;
 *  - both apps' services are running and healthy, `jamal ps` lists them, and
 *    the published loopback ports answer from the host (Valkey `+PONG`, the
 *    MariaDB protocol-10 greeting);
 *  - each project owns its own named volumes, and a row written in one app's
 *    database is absent from the other's;
 *  - the third app, sharing the first one's Compose project, has its `up` and
 *    `down --volumes --yes` refused with `project_in_use` while the first
 *    app's containers hold the project, and the first app keeps running with
 *    its volumes and data;
 *  - `jamal logs db` shows the server ready;
 *  - `jamal down` removes the project's containers and network and keeps its
 *    named data volumes, and a second `jamal up` finds the row written before
 *    it;
 *  - `jamal down --volumes --yes` on the second app removes exactly its
 *    volumes, reporting each by name, while the first app keeps running with
 *    its data; the final `down --volumes` on the first app leaves nothing;
 *  - after the teardown nothing labelled with either Compose project remains:
 *    no container, network, or volume.
 *
 * Isolation: the apps are named `<prefix>-<pid>-<random>-a`/`-b`, where the
 * prefix is `JSAILS_TEST_DOCKER_PREFIX` or `jsails-verify-jamal`, so the
 * projects create derives from them are unique to the run, and their
 * `local.ports` are retargeted to free loopback ports, so the run can neither
 * collide with nor touch any other container, and runs beside services that
 * already hold 3306 and 6379 (the CI job's own MariaDB and Valkey). Every
 * Docker query and removal filters on a run project's
 * `com.docker.compose.project` label. Teardown runs after the steps and on
 * SIGINT/SIGTERM, so a failed or interrupted run still removes what it
 * created. Each `jamal` verb runs in its own process group (POSIX), and a
 * timeout or a signal kills the whole group before teardown: killing only the
 * Node process would leave its `docker compose` child running, free to create
 * containers after the teardown has listed them. The child processes run
 * without `NODE_ENV`, `COMPOSE_*`, and every variable the apps' `.env` sets
 * (the harness's own `DATABASE_*` and `VALKEY_URL` among them), because a real
 * environment variable wins over `.env` and would point the apps at other
 * services.
 *
 * The generated database passwords are random per run and redacted from every
 * failure detail.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The package the stage exercises. */
export const JAMAL_PACKAGE = '@jsails/jamal';

/** The variable that enables the stage. */
export const DOCKER_ENV = 'JSAILS_TEST_DOCKER';

/**
 * The variable that overrides the name prefix of everything the Docker stages
 * create, so a run can be confined to names its operator assigned.
 */
export const DOCKER_PREFIX_ENV = 'JSAILS_TEST_DOCKER_PREFIX';

const DEFAULT_PREFIX = 'jsails-verify-jamal';

const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
/** The services the `--admin` preset's `jamal.config.ts` declares. */
const SERVICES = Object.freeze(['db', 'valkey']);
/** The named volumes Jamal's conventions give those services. */
const VOLUMES = Object.freeze(['mariadb-data', 'valkey-data']);

/** Image pulls on a cold runner dominate `up`; the other verbs are quick. */
const UP_TIMEOUT_MS = 300_000;
const VERB_TIMEOUT_MS = 120_000;
const DOCKER_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;

/** The row the stage writes before `jamal down` and reads after the next `up`. */
const MARKER = '424242';
const WRITE_SQL = `CREATE TABLE verify_jamal (v INT NOT NULL); INSERT INTO verify_jamal VALUES (${MARKER}); SELECT v FROM verify_jamal`;
const READ_SQL = 'SELECT v FROM verify_jamal';
/**
 * Runs the SQL passed as `$0` with the credentials the MariaDB image was
 * started with, so the check proves the `.env` values reached the container.
 * The password travels in `MYSQL_PWD`, which the client reads, so it appears
 * on no command line, the container's own process list included.
 */
const MARIADB_SHELL =
  'MYSQL_PWD="$MARIADB_PASSWORD" exec mariadb --user="$MARIADB_USER" --database="$MARIADB_DATABASE" --batch --skip-column-names --execute="$0"';

/**
 * A name prefix no other run, app, or developer stack uses, from `env`'s
 * {@link DOCKER_PREFIX_ENV} or the stage's default. The stage's two apps are
 * named `<prefix>-a` and `<prefix>-b` at create time, and `jsails create`
 * derives each app's Compose project from its name, so the prefix takes only
 * what a Compose project name allows.
 */
export function composeProjectName(
  env = {},
  pid = process.pid,
  suffix = randomBytes(4).toString('hex'),
) {
  const base =
    env[DOCKER_PREFIX_ENV] === undefined || env[DOCKER_PREFIX_ENV] === ''
      ? DEFAULT_PREFIX
      : env[DOCKER_PREFIX_ENV];
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(base)) {
    throw new Error(`${DOCKER_PREFIX_ENV} must be 1 to 41 lowercase letters, digits, "_" or "-"`);
  }
  return `${base}-${pid}-${suffix}`;
}

/** Replace the one line `pattern` matches, or throw: the template drifted from what the stage drives. */
function replaceOnce(text, pattern, replacement, what) {
  const matches = text.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
  if (matches.length !== 1) {
    throw new Error(`the generated ${what} no longer has exactly one line the stage retargets`);
  }
  return text.replace(pattern, replacement);
}

/** The `service` a generated `jamal.config.ts` names, or `undefined` when it has not exactly one. */
export function jamalService(text) {
  const matches = [...text.matchAll(/^ {2}service: '([^']*)',$/gm)];
  return matches.length === 1 ? matches[0][1] : undefined;
}

/**
 * The generated `jamal.config.ts` with its published ports replaced by free
 * ones, so `jamal up` runs beside services that already hold 3306 and 6379.
 * The Compose project stays the one `jsails create` wrote: that is what the
 * stage checks. Every other line stays as generated.
 */
export function retargetJamalPorts(text, ports) {
  return replaceOnce(
    text,
    /^ {4}ports: \{ db: \d+, valkey: \d+ \},$/m,
    `    ports: { db: ${ports.db}, valkey: ${ports.valkey} },`,
    'jamal.config.ts local.ports',
  );
}

/**
 * The app's `.env`, made the way its guide says: the committed example with
 * each named variable set. A variable the example lists, blank or commented
 * out, is set in place; one it does not list is appended.
 */
export function fillDotenv(example, values) {
  let text = example.endsWith('\n') ? example : `${example}\n`;
  for (const [key, value] of Object.entries(values)) {
    const line = new RegExp(`^#?${key}=.*$`, 'm');
    text = line.test(text)
      ? replaceOnce(text, new RegExp(`^#?${key}=.*$`, 'm'), `${key}=${value}`, `.env ${key}`)
      : `${text}${key}=${value}\n`;
  }
  return text;
}

/** The variable names a dotenv text assigns, commented-out lines excluded. */
export function dotenvKeys(text) {
  return [...text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1]);
}

/**
 * The environment the app's commands run with: the caller's, without
 * `NODE_ENV` (so `jsails` loads `.env` as a developer's shell would), without
 * `COMPOSE_*` (so only the managed file decides the project), and without any
 * variable the app's `.env` sets, because a real variable wins over `.env`.
 */
export function appEnvironment(env, dotenvKeys) {
  const drop = new Set(dotenvKeys);
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || drop.has(key) || key === 'NODE_ENV' || key.startsWith('COMPOSE_')) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Parse `docker inspect` lines of `<service> <state> <health>` into a map, and
 * return the problems that keep it from being exactly `services`, each
 * running and healthy.
 */
export function serviceHealthProblems(lines, services = SERVICES) {
  const seen = new Map();
  for (const line of lines) {
    const [service = '', state = '', health = ''] = line.trim().split(/\s+/);
    if (service !== '') seen.set(service, { state, health });
  }
  const problems = [];
  for (const service of services) {
    const status = seen.get(service);
    if (status === undefined) problems.push(`${service}: no container`);
    else if (status.state !== 'running' || status.health !== 'healthy') {
      problems.push(
        `${service}: ${status.state || 'unknown'}/${status.health || 'no healthcheck'}`,
      );
    }
  }
  for (const service of seen.keys()) {
    if (!services.includes(service)) problems.push(`${service}: unexpected container`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/** Value-free failure of one step; its detail has passed through the run's redaction. */
class StageStepError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StageStepError';
  }
}

const tail = (text, max = 1500) => (text.length > max ? `...${text.slice(-max)}` : text);

/** Process groups exist on POSIX only; on Windows a kill reaches the direct child. */
const OWN_GROUP = process.platform !== 'win32';

/** Children `capture` started that have not closed yet. */
const running = new Set();

/** SIGKILL `child` and, where it leads its own group, every process in that group. */
function killTree(child) {
  try {
    if (OWN_GROUP && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (error) {
    // ESRCH: the group already exited between the close event and this kill.
    if (error.code !== 'ESRCH') throw error;
  }
}

/** Kill every child still running, for a signal handler about to tear down. */
function killRunning() {
  for (const child of running) killTree(child);
  running.clear();
}

/**
 * Run `cmd` with captured output and resolve `{ code, stdout, stderr }`. A
 * process that cannot start resolves `code: null` with the reason in
 * `stderr`; one that outlives `timeoutMs` is killed with its whole process
 * group and resolves `code: null`.
 */
export function capture(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(child);
      resolvePromise({ code, stdout, stderr: `${stderr}${extra}` });
    };
    const child = spawn(cmd, args, {
      cwd,
      env,
      detached: OWN_GROUP,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.add(child);
    const timer = setTimeout(() => {
      killTree(child);
      finish(null, `\n(timed out after ${timeoutMs} ms)`);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(null, `\n(could not start: ${error.code ?? error.name})`));
    child.on('close', (code) => finish(code));
  });
}

/** Synchronous `docker` call for teardown, which also runs inside a signal handler. */
function dockerSync(args, { cwd, env }) {
  const result = spawnSync('docker', args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: DOCKER_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: result.status, stdout: result.stdout ?? '' };
}

/** Ids of the run's objects of one kind (`container`, `network`, `volume`). */
function labelled(kind, project, options) {
  const list =
    kind === 'container'
      ? ['ps', '--all', '--quiet', '--filter', `label=${PROJECT_LABEL}=${project}`]
      : [kind, 'ls', '--quiet', '--filter', `label=${PROJECT_LABEL}=${project}`];
  const { code, stdout } = dockerSync(list, options);
  if (code !== 0) return null;
  return stdout.split('\n').filter((line) => line.trim() !== '');
}

/** The run's leftovers by kind; `null` where Docker could not be asked. */
function leftovers(project, options) {
  return {
    containers: labelled('container', project, options),
    networks: labelled('network', project, options),
    volumes: labelled('volume', project, options),
  };
}

/**
 * Remove everything the run created: Compose's own `down --volumes` against
 * the managed file when it exists, then any container, network, or volume
 * still labelled with the project. Returns what is left.
 */
function teardown(project, appDir, env) {
  const options = { cwd: appDir !== undefined && existsSync(appDir) ? appDir : tmpdir(), env };
  // Without the managed file Compose would look for one in the working
  // directory; the label sweep below removes the project's objects either way.
  if (appDir !== undefined && existsSync(join(appDir, '.jamal', 'compose.yml'))) {
    dockerSync(
      [
        'compose',
        '-f',
        '.jamal/compose.yml',
        '-p',
        project,
        'down',
        '--volumes',
        '--remove-orphans',
        '--timeout',
        '5',
      ],
      options,
    );
  }
  const removals = [
    ['container', (ids) => ['rm', '--force', '--volumes', ...ids]],
    ['network', (ids) => ['network', 'rm', ...ids]],
    ['volume', (ids) => ['volume', 'rm', '--force', ...ids]],
  ];
  for (const [kind, command] of removals) {
    const ids = labelled(kind, project, options);
    if (ids !== null && ids.length > 0) dockerSync(command(ids), options);
  }
  return leftovers(project, options);
}

/** Describe what `leftovers` found, or `null` when nothing remains. */
export function describeLeftovers({ containers, networks, volumes }) {
  const parts = [];
  for (const [kind, ids] of [
    ['containers', containers],
    ['networks', networks],
    ['volumes', volumes],
  ]) {
    if (ids === null) parts.push(`${kind}: docker did not answer`);
    else if (ids.length > 0) parts.push(`${ids.length} ${kind}`);
  }
  return parts.length === 0 ? null : parts.join(', ');
}

// ---------------------------------------------------------------------------
// Host-side probes of the published ports
// ---------------------------------------------------------------------------

/** Connect to `127.0.0.1:port`, optionally write `send`, and resolve once `accept(data)` holds. */
function probePort(port, { send, accept, label }) {
  return new Promise((resolvePromise, reject) => {
    let data = Buffer.alloc(0);
    const socket = connect({ host: '127.0.0.1', port });
    const fail = (reason) => {
      socket.destroy();
      reject(new StageStepError(`${label}: ${reason}`));
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => fail('no answer'));
    socket.once('error', (error) => fail(error.code ?? error.name));
    socket.once('connect', () => {
      if (send !== undefined) socket.write(send);
    });
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (accept(data)) {
        socket.destroy();
        resolvePromise();
      }
    });
    socket.once('end', () => fail('closed before answering'));
  });
}

/** Valkey on its published port answers an inline PING. */
function probeValkey(port) {
  return probePort(port, {
    send: 'PING\r\n',
    accept: (data) => data.toString('latin1').startsWith('+PONG\r\n'),
    label: 'valkey published port',
  });
}

/** MariaDB on its published port sends a protocol-10 handshake: 3-byte length, sequence 0, then 0x0a. */
function probeMariadb(port) {
  return probePort(port, {
    accept: (data) => data.length >= 5 && data[3] === 0 && data[4] === 0x0a,
    label: 'mariadb published port',
  });
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/** The absolute path of the `jamal` bin the app installed. */
function installedJamalBin(appDir) {
  const manifestPath = join(appDir, 'node_modules', ...JAMAL_PACKAGE.split('/'), 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.bin?.jamal !== 'string') {
    throw new StageStepError(`the installed ${JAMAL_PACKAGE} declares no jamal bin`);
  }
  return resolve(dirname(manifestPath), manifest.bin.jamal);
}

/** `count` distinct free loopback ports. */
async function freePorts(findFreePort, count) {
  const ports = new Set();
  for (let attempt = 0; attempt < count * 5 && ports.size < count; attempt += 1) {
    ports.add(await findFreePort());
  }
  if (ports.size < count) {
    throw new StageStepError(`could not reserve ${count} distinct loopback ports`);
  }
  return [...ports];
}

/** The volume names `jamal down --volumes` reported removing, sorted. */
export function reportedRemovals(stdout) {
  return [...stdout.matchAll(/^jamal: removed volume (\S+)$/gm)].map((match) => match[1]).sort();
}

/** Docker and its Compose plugin answer. */
async function dockerAvailable(env) {
  const options = { cwd: tmpdir(), env, timeoutMs: DOCKER_TIMEOUT_MS };
  const info = await capture('docker', ['info', '--format', '{{.ServerVersion}}'], options);
  if (info.code !== 0) return 'the docker daemon is unavailable';
  const compose = await capture('docker', ['compose', 'version', '--short'], options);
  if (compose.code !== 0) return 'the docker compose plugin is unavailable';
  return null;
}

/**
 * Run the stage. Skips unless `JSAILS_TEST_DOCKER=1`; once enabled, an
 * unavailable Docker, a failing verb, a failed assertion, or anything the
 * teardown leaves behind fails it.
 */
export async function runJamalStage(env, { log = () => {} } = {}) {
  if (env[DOCKER_ENV] !== '1') {
    return { stage: 'jamal', status: 'skipped', detail: `${DOCKER_ENV} is not "1"` };
  }
  const unavailable = await dockerAvailable(env);
  if (unavailable !== null) {
    return { stage: 'jamal', status: 'failed', detail: unavailable };
  }

  const prefix = composeProjectName(env);
  const root = mkdtempSync(join(tmpdir(), 'jsails-verify-jamal-'));
  /** The stage's two apps; each one's Compose project is the name create gives it. */
  const apps = ['a', 'b'].map((id) => ({
    id,
    project: `${prefix}-${id}`,
    dir: join(root, id),
    database: `verify_jamal_${id}`,
    password: randomBytes(18).toString('hex'),
    rootPassword: randomBytes(18).toString('hex'),
  }));
  const [first, second] = apps;
  /**
   * A third app created under the first one's name in another directory: the
   * same Compose project, which Jamal must refuse to drive while the first
   * app's containers hold it. It never starts a container of its own.
   */
  const twin = { id: 'twin', project: first.project, dir: join(root, 'twin') };
  const secrets = apps.flatMap((app) => [app.password, app.rootPassword]);
  const redactSecrets = (text) =>
    secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
  let childEnv = appEnvironment(env, []);
  let starter;

  let left;
  const cleanUp = () => {
    if (left === undefined) {
      const remains = apps.map((app) =>
        teardown(app.project, existsSync(app.dir) ? app.dir : undefined, childEnv),
      );
      left = {
        containers: remains.some((r) => r.containers === null)
          ? null
          : remains.flatMap((r) => r.containers),
        networks: remains.some((r) => r.networks === null)
          ? null
          : remains.flatMap((r) => r.networks),
        volumes: remains.some((r) => r.volumes === null) ? null : remains.flatMap((r) => r.volumes),
      };
      rmSync(root, { recursive: true, force: true });
      starter?.removeTempRoot();
    }
    return left;
  };
  // Stays installed through the final teardown: without a listener a signal
  // there would end the process at once, mid-sweep.
  const onSignal = (signal) => {
    killRunning();
    cleanUp();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let failure;
  try {
    starter = await import('../verify-starter/fixtures.mjs');
    const { findFreePort } = await import('../verify-starter/processes.mjs');

    log('jamal: packing the framework and the --admin plugins');
    const tarballs = await starter.packWorkspaces();
    log('jamal: generating and installing a throwaway --admin app');
    await starter.createFixture(
      {
        stage: 'jamal',
        preset: '--admin',
        dir: first.dir,
        name: first.project,
        plugins: starter.ADMIN_FIXTURE.plugins,
      },
      tarballs,
    );
    const cli = starter.installedCli(first.dir);
    // The second app comes from the packed CLI itself, named differently and
    // sharing the first one's install: what is under test is the name create
    // writes, not a second identical npm install.
    log('jamal: generating a second --admin app');
    const created = await capture(
      process.execPath,
      [cli, 'create', second.dir, '--admin', '--name', second.project, '--no-git'],
      { cwd: root, env: childEnv, timeoutMs: VERB_TIMEOUT_MS },
    );
    if (created.code !== 0) {
      throw new StageStepError(`jsails create (second app) exited ${created.code ?? 'abnormally'}`);
    }
    log("jamal: generating a third --admin app under the first one's name");
    const twinCreated = await capture(
      process.execPath,
      [cli, 'create', twin.dir, '--admin', '--name', first.project, '--no-git'],
      { cwd: root, env: childEnv, timeoutMs: VERB_TIMEOUT_MS },
    );
    if (twinCreated.code !== 0) {
      throw new StageStepError(
        `jsails create (third app) exited ${twinCreated.code ?? 'abnormally'}`,
      );
    }
    for (const app of [second, twin]) {
      symlinkSync(
        join(first.dir, 'node_modules'),
        join(app.dir, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }

    const ports = await freePorts(findFreePort, 2 * apps.length);
    let dotenvText = '';
    for (const [index, app] of apps.entries()) {
      app.ports = { db: ports[2 * index], valkey: ports[2 * index + 1] };
      const configPath = join(app.dir, 'jamal.config.ts');
      const generated = readFileSync(configPath, 'utf8');
      const service = jamalService(generated);
      if (service !== app.project) {
        throw new StageStepError(
          `jsails create --name ${app.project} wrote the jamal service ${JSON.stringify(service)}`,
        );
      }
      writeFileSync(configPath, retargetJamalPorts(generated, app.ports));
      // The first app takes its database name from `.env.local`, over a
      // decoy in `.env`: only the framework's layering applies that file
      // (Compose reads neither), so the name the database answers with
      // proves the package's own bin loaded the project's environment.
      const layered = app === first;
      dotenvText = fillDotenv(readFileSync(join(app.dir, '.env.auth.example'), 'utf8'), {
        DATABASE_HOST: '127.0.0.1',
        DATABASE_PORT: String(app.ports.db),
        DATABASE_USER: 'verify',
        DATABASE_PASSWORD: app.password,
        DATABASE_NAME: layered ? 'verify_jamal_decoy' : app.database,
        DATABASE_ROOT_PASSWORD: app.rootPassword,
        VALKEY_URL: `redis://127.0.0.1:${app.ports.valkey}`,
      });
      writeFileSync(join(app.dir, '.env'), dotenvText);
      if (layered) writeFileSync(join(app.dir, '.env.local'), `DATABASE_NAME=${app.database}\n`);
    }
    // The twin is configured as the first app is; its verbs must be refused
    // before Compose runs, so its ports and values are never used.
    const twinConfig = readFileSync(join(twin.dir, 'jamal.config.ts'), 'utf8');
    if (jamalService(twinConfig) !== first.project) {
      throw new StageStepError('two apps created with one name got different Compose projects');
    }
    writeFileSync(join(twin.dir, 'jamal.config.ts'), retargetJamalPorts(twinConfig, first.ports));
    writeFileSync(join(twin.dir, '.env'), readFileSync(join(first.dir, '.env'), 'utf8'));
    if (first.project === second.project) {
      throw new StageStepError('two apps created with different names share one Compose project');
    }
    childEnv = appEnvironment(env, dotenvKeys(dotenvText));

    /** `jsails jamal <args>` (loads `.env`, forwards) or, `direct`, the package's own bin. */
    const verb = async (app, label, args, { direct = false, timeoutMs = VERB_TIMEOUT_MS } = {}) => {
      log(`jamal: ${app.id}: ${label}`);
      const argv = direct
        ? [installedJamalBin(app.dir), ...args]
        : [starter.installedCli(app.dir), 'jamal', ...args];
      const result = await capture(process.execPath, argv, {
        cwd: app.dir,
        env: childEnv,
        timeoutMs,
      });
      if (result.code !== 0) {
        throw new StageStepError(
          `${app.id}: ${label} exited ${result.code ?? 'abnormally'}: ${tail(`${result.stdout}\n${result.stderr}`.trim())}`,
        );
      }
      return result;
    };
    /** Run the package's bin in `app` and require the `project_in_use` refusal. */
    const refused = async (app, label, args) => {
      log(`jamal: ${app.id}: ${label} (must be refused)`);
      const result = await capture(process.execPath, [installedJamalBin(first.dir), ...args], {
        cwd: app.dir,
        env: childEnv,
        timeoutMs: VERB_TIMEOUT_MS,
      });
      if (
        result.code !== 1 ||
        !/another directory's containers already use this app's Compose project/.test(result.stderr)
      ) {
        throw new StageStepError(
          `${app.id}: ${label} was not refused (exit ${result.code ?? 'abnormal'}): ${tail(`${result.stdout}\n${result.stderr}`.trim())}`,
        );
      }
    };
    const options = (app) => ({ cwd: app.dir, env: childEnv });
    const healthy = (app) => {
      const ids = labelled('container', app.project, options(app)) ?? [];
      const format = `{{index .Config.Labels "${SERVICE_LABEL}"}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}`;
      const inspected =
        ids.length === 0
          ? { stdout: '' }
          : dockerSync(['inspect', '--format', format, ...ids], options(app));
      const problems = serviceHealthProblems(inspected.stdout.split('\n'));
      if (problems.length > 0) {
        throw new StageStepError(`${app.id}: services after jamal up: ${problems.join('; ')}`);
      }
    };
    /** The names of `app`'s volumes, as Docker lists them by its project label. */
    const volumesOf = (app) =>
      (labelled('volume', app.project, options(app)) ?? []).map((id) => id.trim()).sort();
    const expectedVolumes = (app) => VOLUMES.map((volume) => `${app.project}_${volume}`).sort();
    const sql = async (app, label, statement, expected, { direct = false } = {}) => {
      const { stdout } = await verb(
        app,
        label,
        ['exec', 'db', '--', 'sh', '-c', MARIADB_SHELL, statement],
        { direct },
      );
      if (stdout.trim() !== expected) {
        throw new StageStepError(
          `${app.id}: ${label} printed ${JSON.stringify(tail(stdout.trim(), 200))}, not ${JSON.stringify(expected)}`,
        );
      }
    };

    // The first app runs through the package's own bin, as `npx jamal` does:
    // MariaDB starts only when Compose interpolated the `.env` credentials,
    // and the database it created is the one `.env` names.
    await verb(first, 'jamal up (package bin)', ['up'], { direct: true, timeoutMs: UP_TIMEOUT_MS });
    healthy(first);
    await verb(second, 'jsails jamal up', ['up'], { timeoutMs: UP_TIMEOUT_MS });
    healthy(second);
    await sql(first, 'jamal exec db (package bin)', 'SELECT DATABASE()', first.database, {
      direct: true,
    });
    await sql(second, 'jsails jamal exec db', 'SELECT DATABASE()', second.database);

    const ps = await verb(first, 'jamal ps (package bin)', ['ps'], { direct: true });
    for (const service of SERVICES) {
      if (!new RegExp(`\\b${first.project}-${service}-1\\b.*\\(healthy\\)`).test(ps.stdout)) {
        throw new StageStepError(`jamal ps does not list ${service} as healthy`);
      }
    }
    for (const app of apps) {
      await probeValkey(app.ports.valkey);
      await probeMariadb(app.ports.db);
    }

    // Two apps, two sets of data: each project owns its own volumes, and a
    // row written in one database is not in the other.
    for (const app of apps) {
      const volumes = volumesOf(app);
      if (volumes.join(' ') !== expectedVolumes(app).join(' ')) {
        throw new StageStepError(`${app.id}: project volumes are ${volumes.join(', ') || 'none'}`);
      }
    }
    await sql(first, 'jsails jamal exec db (write)', WRITE_SQL, MARKER);
    await sql(second, 'jsails jamal exec db (other app)', "SHOW TABLES LIKE 'verify_jamal'", '');

    // An app that shares the first one's name, in another directory, can
    // neither take over its running containers nor delete its data.
    await refused(twin, 'jamal up', ['up']);
    // The twin's own managed file, as an earlier `jamal up` of it would have
    // left: `down` drives that file, and is refused all the same.
    mkdirSync(join(twin.dir, '.jamal'), { recursive: true });
    copyFileSync(join(first.dir, '.jamal', 'compose.yml'), join(twin.dir, '.jamal', 'compose.yml'));
    await refused(twin, 'jamal down --volumes --yes', ['down', '--volumes', '--yes']);
    healthy(first);
    if (volumesOf(first).join(' ') !== expectedVolumes(first).join(' ')) {
      throw new StageStepError("the twin app's refused verbs changed the first app's volumes");
    }
    await sql(first, 'jsails jamal exec db (read after the twin was refused)', READ_SQL, MARKER);
    const logs = await verb(first, 'jsails jamal logs db', ['logs', 'db']);
    if (!/ready for connections/.test(`${logs.stdout}${logs.stderr}`)) {
      throw new StageStepError('jamal logs db does not show the server ready for connections');
    }

    // `down` keeps the data: the containers and network go, the volumes stay,
    // and the next `up` finds the row.
    await verb(first, 'jamal down (package bin)', ['down'], { direct: true });
    const afterDown = leftovers(first.project, options(first));
    if (afterDown.containers?.length !== 0 || afterDown.networks?.length !== 0) {
      throw new StageStepError(
        `jamal down left ${describeLeftovers({ ...afterDown, volumes: [] }) ?? 'nothing it could list'}`,
      );
    }
    if (volumesOf(first).join(' ') !== expectedVolumes(first).join(' ')) {
      throw new StageStepError('jamal down removed data volumes');
    }
    await verb(first, 'jsails jamal up (again)', ['up'], { timeoutMs: UP_TIMEOUT_MS });
    healthy(first);
    await sql(first, 'jsails jamal exec db (read after down/up)', READ_SQL, MARKER);

    // `down --volumes --yes` deletes exactly the second app's volumes, names
    // each one, and leaves the first app running with its data.
    const removed = await verb(second, 'jsails jamal down --volumes --yes', [
      'down',
      '--volumes',
      '--yes',
    ]);
    const reported = reportedRemovals(removed.stdout);
    if (reported.join(' ') !== expectedVolumes(second).join(' ')) {
      throw new StageStepError(
        `down --volumes reported removing ${reported.join(', ') || 'nothing'}`,
      );
    }
    const secondLeft = describeLeftovers(leftovers(second.project, options(second)));
    if (secondLeft !== null) {
      throw new StageStepError(`down --volumes left ${secondLeft}`);
    }
    if (volumesOf(first).join(' ') !== expectedVolumes(first).join(' ')) {
      throw new StageStepError("the second app's down --volumes touched the first app's volumes");
    }
    healthy(first);
    await sql(first, 'jsails jamal exec db (read after the other app reset)', READ_SQL, MARKER);

    await verb(
      first,
      'jamal down --volumes --yes (package bin, final)',
      ['down', '--volumes', '--yes'],
      { direct: true },
    );
    const firstLeft = describeLeftovers(leftovers(first.project, options(first)));
    if (firstLeft !== null) {
      throw new StageStepError(`the final down --volumes left ${firstLeft}`);
    }
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  log('jamal: tearing down the run projects');
  const remaining = describeLeftovers(cleanUp());
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  if (remaining !== null) {
    failure = `${failure === undefined ? '' : `${failure}; `}teardown left ${remaining}`;
  }
  if (failure !== undefined) {
    return { stage: 'jamal', status: 'failed', detail: redactSecrets(failure) };
  }
  return {
    stage: 'jamal',
    status: 'ok',
    detail:
      '--admin apps from packed tarballs: one Compose project and set of volumes each, a same-name app in another directory refused, the bin loads .env and .env.local, down keeps data, down --volumes removes only its own, nothing left behind',
  };
}
