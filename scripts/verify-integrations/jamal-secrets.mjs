/**
 * The `jamal-secrets` stage of `scripts/verify-integrations.mjs`: a release's
 * secrets file, written the way `jamal deploy` writes it, read back from
 * inside a real container running as the image's runtime uid.
 *
 * The stage drives the built `@jsails/jamal` modules, not a copy of their
 * logic. A temporary directory stands in for the ssh user's home on the
 * server, and a local `/bin/sh` for the ssh session (the remote command line
 * is the one the transport would send). It then asserts:
 *
 *  - `encodeSecretsFile` and `writeRemoteFile` put the file at the release's
 *    host path with the stated modes: the release directory `0700` (no other
 *    host user reaches the file), `secrets/` `0755`, the file `0444`, and no
 *    temporary file left beside it;
 *  - `readHostHome` reads the home through the `host.home` op as the
 *    absolute directory the session starts in, with links resolved;
 *  - a container started with the release's own mount flags
 *    (`releaseSecretsLayout(...).runFlags`, an absolute bind source under
 *    that home, run from another working directory so nothing rests on the
 *    Docker CLI resolving a relative source, which only 23 and later do), as
 *    uid 10001 (`RUNTIME_UID`, the uid the JSails Dockerfile runs the app as)
 *    with no network, reads the exact bytes written, cannot write the
 *    read-only mount, and the JSails environment resolver reading those bytes
 *    as `JSAILS_SECRETS_FILE` yields every original value byte for byte: a
 *    PEM block, a backslash, `$`, quotes, non-ASCII, an emoji, an empty value,
 *    and a value longer than a Docker env-file line can hold;
 *  - a file rewritten through `writeRemoteFile` (a rename, so a new inode)
 *    reaches a running container through the directory mount the cache proxy
 *    uses for its VCL (`cacheProxyBootArgv`), which a single-file bind mount
 *    would not.
 *
 * Isolation: every container is named `<prefix>-<pid>-<random>-<role>`,
 * where the prefix is `JSAILS_TEST_DOCKER_PREFIX` or `jsails-verify-secrets`,
 * runs with `--rm`, and is removed by name in the `finally` block; the
 * long-running one also exits on its own after `SLEEPER_SECONDS`. Nothing
 * else on the daemon is listed, changed, or removed. The image is
 * `alpine:3`, pulled when missing and never removed.
 *
 * The stage is enabled by `JSAILS_TEST_DOCKER=1`, as the `jamal` stage is,
 * and runs only on a POSIX host: the server side of a deploy is a POSIX
 * shell, and jamal's server verbs refuse on Windows.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DOCKER_ENV, DOCKER_PREFIX_ENV } from './jamal.mjs';
import { repoRoot } from '../workspaces.mjs';

/** The stage's name, as `--require` and `--only` take it. */
export const SECRETS_STAGE = 'jamal-secrets';

const DEFAULT_PREFIX = 'jsails-verify-secrets';

/** The uid the JSails Dockerfile runs an app as; the file must be readable by it. */
export const RUNTIME_UID = '10001';

const IMAGE = 'alpine:3';

/** Image pulls on a cold runner dominate; every other command is quick. */
const RUN_TIMEOUT_MS = 300_000;
const DOCKER_TIMEOUT_MS = 60_000;
/** How long the container that watches a rewrite lives if nothing removes it. */
const SLEEPER_SECONDS = 120;

/**
 * The secrets the stage carries: every value a Docker env file could not, and
 * the plain ones it could. The names are what the report prints on a
 * mismatch; the values never are.
 */
export const STAGE_SECRETS = Object.freeze({
  BACKSLASH: 'C:\\path\\to\\n and \\\\ twice',
  DOLLAR: '$HOME ${PATH} $(id) `id`',
  EMOJI: 'deploy 🚀 done ✓',
  EMPTY: '',
  LONG: 'x'.repeat(70_000),
  NON_ASCII: 'pässwörd ünïcødé 日本語',
  PEM: '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7\r\nAgEAAkEA\n-----END PRIVATE KEY-----\n',
  QUOTES: `"double" 'single' "unbalanced`,
});

/** A container name prefix no other run uses. */
export function containerPrefix(env, pid = process.pid, suffix = randomBytes(4).toString('hex')) {
  const base =
    env[DOCKER_PREFIX_ENV] === undefined || env[DOCKER_PREFIX_ENV] === ''
      ? DEFAULT_PREFIX
      : env[DOCKER_PREFIX_ENV];
  if (!/^[a-z0-9][a-z0-9_.-]{0,40}$/.test(base)) {
    throw new Error(
      `${DOCKER_PREFIX_ENV} must be 1 to 41 lowercase letters, digits, ".", "_" or "-"`,
    );
  }
  return `${base}-${pid}-${suffix}`;
}

/**
 * The names of the values in `expected` that `actual` lacks or holds
 * differently, and of the names `actual` has that `expected` does not.
 */
export function mismatchedNames(expected, actual) {
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  return [...names].filter((name) => expected[name] !== actual[name]).sort();
}

/** Run a command and collect its output as bytes, so a split UTF-8 sequence is never mangled. */
function runBytes(command, args, { cwd, env, input, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (code, note = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout),
        stderr: `${Buffer.concat(stderr).toString('utf8')}${note}`,
      });
    };
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, `\n(timed out after ${timeoutMs} ms)`);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.stdin.on('error', () => {
      // The child exiting before it read its stdin is reported by its exit code.
    });
    child.on('error', (error) => finish(null, `\n(could not start: ${error.code ?? error.name})`));
    child.on('close', (code) => finish(code));
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}

/**
 * A `RemoteRunner` whose server is a local `/bin/sh` in `home`: the command
 * line is the one the ssh transport sends, quoted by the transport itself.
 */
function localServer(home, env, remoteCommandLine) {
  return {
    async run(_server, remoteArgv, options) {
      const given = typeof options === 'string' ? options : options?.stdin;
      const input =
        typeof given === 'string' ? Buffer.from(given, 'utf8') : Buffer.from(given ?? []);
      const result = await runBytes('/bin/sh', ['-c', remoteCommandLine(remoteArgv)], {
        cwd: home,
        env,
        input,
        timeoutMs: DOCKER_TIMEOUT_MS,
      });
      return {
        exitCode: result.code ?? 1,
        stdout: result.stdout.toString('utf8'),
        stderr: result.stderr,
      };
    },
  };
}

/** The `-v` value of a `docker run` argv; the stage mounts exactly what jamal mounts. */
function volumeOf(argv) {
  const at = argv.indexOf('-v');
  if (at === -1 || argv[at + 1] === undefined) throw new Error('the argv mounts no volume');
  return argv[at + 1];
}

function mode(path) {
  return (statSync(path).mode & 0o777).toString(8).padStart(3, '0');
}

async function importBuilt(relativePath) {
  return import(pathToFileURL(join(repoRoot, relativePath)).href);
}

/** The modules the stage drives, from the build; `null` when a build is missing. */
async function loadModules() {
  try {
    const [secretsFile, remoteFile, transport, cacheProxy, hostHome, resolve, names] =
      await Promise.all([
        importBuilt('packages/jamal/dist/src/production/secrets-file.js'),
        importBuilt('packages/jamal/dist/src/production/remote-file.js'),
        importBuilt('packages/jamal/dist/src/production/transport.js'),
        importBuilt('packages/jamal/dist/src/production/cache-proxy.js'),
        importBuilt('packages/jamal/dist/src/production/host-home.js'),
        importBuilt('core/dist/src/environment/resolve.js'),
        importBuilt('core/dist/src/environment/names.js'),
      ]);
    return { secretsFile, remoteFile, transport, cacheProxy, hostHome, resolve, names };
  } catch {
    return null;
  }
}

/**
 * Run the stage. Skips unless `JSAILS_TEST_DOCKER=1`, and on Windows; once
 * enabled, a missing build, an unavailable Docker, or a failed assertion
 * fails it.
 */
export async function runJamalSecretsStage(env, { log = () => {} } = {}) {
  const result = (status, detail) => ({ stage: SECRETS_STAGE, status, detail });
  if (env[DOCKER_ENV] !== '1') return result('skipped', `${DOCKER_ENV} is not "1"`);
  if (process.platform === 'win32') {
    return result('skipped', 'the server side of a deploy is a POSIX shell');
  }
  let prefix;
  try {
    prefix = containerPrefix(env);
  } catch (error) {
    return result('failed', error.message);
  }
  const docker = (args, options = {}) =>
    runBytes('docker', args, { env, timeoutMs: DOCKER_TIMEOUT_MS, ...options });
  if ((await docker(['info', '--format', '{{.ServerVersion}}'], { cwd: tmpdir() })).code !== 0) {
    return result('failed', 'the docker daemon is unavailable');
  }
  const modules = await loadModules();
  if (modules === null) {
    return result('failed', 'the jamal or core build is missing (run "npm run build" first)');
  }

  const home = mkdtempSync(join(tmpdir(), 'jsails-verify-secrets-'));
  const names = { reader: `${prefix}-reader`, watcher: `${prefix}-watcher` };
  try {
    const failure = await verify({ modules, home, names, docker, env, log });
    return failure === null
      ? result(
          'ok',
          `secrets file read back as uid ${RUNTIME_UID}; a rewrite reached a directory mount`,
        )
      : result('failed', failure);
  } catch (error) {
    // An error of the jamal modules is value-free by contract; a harness
    // error names no secret either.
    return result(
      'failed',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  } finally {
    for (const name of Object.values(names)) {
      await docker(['rm', '-f', name], { cwd: tmpdir() });
    }
    rmSync(home, { recursive: true, force: true });
  }
}

/** The stage's assertions, in order; the first that fails is returned as its detail. */
async function verify({ modules, home, names, docker, env, log }) {
  const {
    secretsFile,
    remoteFile,
    transport,
    cacheProxy,
    hostHome,
    resolve,
    names: envNames,
  } = modules;
  const server = localServer(home, env, transport.remoteCommandLine);
  const release = 'verify-web-0001';

  log("reading the ssh user's home through the host.home op");
  const serverHome = await hostHome.readHostHome(server, 'server');
  if (serverHome !== realpathSync(home)) {
    return 'readHostHome did not return the absolute home the session starts in';
  }
  const layout = secretsFile.releaseSecretsLayout('verify', undefined, release, serverHome);
  if (!volumeOf(layout.runFlags).startsWith(`${serverHome}/`)) {
    return "the release's secrets bind source is not absolute under the home";
  }
  const bytes = Buffer.from(secretsFile.encodeSecretsFile(STAGE_SECRETS));

  log(`writing the release's secrets file (${bytes.length} bytes)`);
  await remoteFile.writeRemoteFile(server, 'server', layout.hostFile, bytes, {
    mode: secretsFile.SECRETS_FILE_MODE,
    directoryMode: secretsFile.SECRETS_DIRECTORY_MODE,
  });
  const hostFile = join(home, layout.hostFile);
  const secretsDir = join(hostFile, '..');
  const releaseDir = join(secretsDir, '..');
  const modes = [mode(releaseDir), mode(secretsDir), mode(hostFile)];
  if (modes.join(' ') !== '700 755 444') {
    return `the release, secrets directory and file modes are ${modes.join(' ')}, not 700 755 444`;
  }
  if (readdirSync(secretsDir).length !== 1) return 'the write left a temporary file behind';

  log(`reading it back in a container as uid ${RUNTIME_UID}`);
  const probe = [
    `[ "$(id -u)" = ${RUNTIME_UID} ] || exit 10`,
    `( : > ${secretsFile.CONTAINER_SECRETS_DIR}/probe ) 2>/dev/null && exit 11`,
    'exec cat "$JSAILS_SECRETS_FILE"',
  ].join('\n');
  const read = await docker(
    [
      'run',
      '--rm',
      '--name',
      names.reader,
      '--user',
      `${RUNTIME_UID}:${RUNTIME_UID}`,
      '--network',
      'none',
      '--read-only',
      ...layout.runFlags,
      IMAGE,
      'sh',
      '-c',
      probe,
    ],
    // Not the home: an absolute source must need no working directory.
    { cwd: tmpdir(), timeoutMs: RUN_TIMEOUT_MS },
  );
  if (read.code === 10) return `the reader container did not run as uid ${RUNTIME_UID}`;
  if (read.code === 11) return 'the container could write its read-only secrets mount';
  if (read.code !== 0)
    return `the reader container exited with ${read.code}: ${read.stderr.trim()}`;
  if (!read.stdout.equals(bytes))
    return 'the bytes read in the container differ from those written';

  const readBack = join(home, 'read-back.json');
  writeFileSync(readBack, read.stdout);
  const resolved = resolve.resolveEnvironment({
    rootDir: home,
    env: { [envNames.SECRETS_FILE_ENV]: readBack },
    name: 'production',
    secrets: 'unused',
  });
  const values = {};
  for (const [name, source] of Object.entries(resolved.sources)) {
    if (source === 'secrets-file') values[name] = resolved.values[name];
  }
  const differing = mismatchedNames(STAGE_SECRETS, values);
  if (differing.length > 0)
    return `the resolver read back different values for ${differing.join(', ')}`;

  log('rewriting a file under a running container’s directory mount');
  const vclMount = volumeOf(cacheProxy.cacheProxyBootArgv({ home: serverHome }));
  const vclWrite = (text) =>
    remoteFile.writeRemoteFile(
      server,
      'server',
      cacheProxy.CACHE_PROXY_HOST_VCL_FILE,
      Buffer.from(text),
      {
        mode: cacheProxy.CACHE_PROXY_VCL_MODE,
        directoryMode: cacheProxy.CACHE_PROXY_VCL_DIRECTORY_MODE,
      },
    );
  await vclWrite('vcl 4.1; # first\n');
  const started = await docker(
    [
      'run',
      '-d',
      '--rm',
      '--name',
      names.watcher,
      '--user',
      `${RUNTIME_UID}:${RUNTIME_UID}`,
      '--network',
      'none',
      '-v',
      vclMount,
      IMAGE,
      'sleep',
      String(SLEEPER_SECONDS),
    ],
    { cwd: tmpdir(), timeoutMs: RUN_TIMEOUT_MS },
  );
  if (started.code !== 0) return `the watcher container did not start: ${started.stderr.trim()}`;
  const second = 'vcl 4.1; # second\n';
  await vclWrite(second);
  const containerVcl = `${cacheProxy.CACHE_PROXY_CONTAINER_VCL_DIR}/default.vcl`;
  const seen = await docker(['exec', names.watcher, 'cat', containerVcl], { cwd: tmpdir() });
  if (seen.code !== 0) return `the watcher could not read the VCL: ${seen.stderr.trim()}`;
  if (seen.stdout.toString('utf8') !== second) {
    return 'a running container still saw the replaced file through its directory mount';
  }
  return null;
}
