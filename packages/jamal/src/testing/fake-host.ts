/**
 * A production server as a test model: {@link FakeHost} is a
 * {@link RemoteRunner} that answers the engine's ssh commands from state
 * instead of a shell.
 *
 * Every argv it receives is decoded into a {@link RemoteOp}
 * (`production/remote-op.ts`), and each op is implemented here the way its
 * script behaves on a real server: the same exit statuses, the same files
 * left behind, the same modes. An argv that is not an op is answered with
 * exit 127 and recorded in {@link FakeHost.unmodelled}, so a scenario can
 * insist the engine sent only commands the model understands. The state is a
 * {@link FakeFileSystem} rooted at the ssh user's home, a {@link FakeDocker}
 * engine (images, containers, volumes, networks, the kamal-proxy routes), and
 * the digest tools the server has (`file.write` finds `sha256sum`, `shasum`,
 * or `openssl`, in that order, or exits as the script does without one).
 *
 * Several jamal processes can talk to one host: {@link FakeHost.connect}
 * hands each its own runner, which the scenario can {@link FakeClient.kill}
 * (the process ended: nothing it sends arrives any more). Failures are
 * injected with {@link FakeHost.crashAfter}: the connection drops after a
 * number of commands, or partway through a command's stdin. The command that
 * crashes still runs on the server (sshd closes its stdin; nothing hangs it
 * up), its result never reaches the client (ssh exits 255), and every later
 * command from that client fails the same way until {@link FakeHost.restoreLink}.
 * {@link FakeHost.onCommand} runs a listener before each command, which is
 * where a scenario interleaves a second deploy or delivers a signal.
 *
 * A `fenced` op is unwrapped as its script does it: the first stdin line is
 * the caller's token, and the inner op runs on the rest of stdin only while
 * the lock directory still holds that token. The log and the listeners see
 * the inner op with `fenced` set; a command the fence refused is logged as
 * not executed, since nothing of it ran.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { JsailsError } from 'jsails/errors';

import { JAMAL_NETWORK } from '../production/host-layout.js';
import type { CommandResult } from '../production/process-runner.js';
import {
  BACKUP_EXIT_VALKEY,
  FENCE_LOST_EXIT,
  FENCE_LOST_MARKER,
  LOCK_ACQUIRE_FAILED_EXIT,
  LOCK_CONTENDED_EXIT,
  LOCK_NOT_HELD_EXIT,
  LOCK_NOT_OWNER_EXIT,
  LOCK_OWNER_FILE,
  LOCK_SEQ_FILE,
  LOCK_TOKEN_FILE,
  NO_SUCH_CONTAINER_EXIT,
  WRITE_CHECKSUM_MISMATCH_EXIT,
  WRITE_EXPECT_ABSENT,
  WRITE_FAILED_EXIT,
  WRITE_LOCK_LOST_EXIT,
  WRITE_NO_HASHER_EXIT,
  WRITE_PRECONDITION_EXIT,
  WRITE_TEMPORARY_PREFIX,
  decodeRemoteOp,
  remoteOpArgv,
  type RemoteOp,
  type RemoteOpOf,
} from '../production/remote-op.js';
import type { RemoteRunOptions, RemoteRunner } from '../production/transport.js';
import { FakeDocker, type FakeOutput } from './fake-docker.js';
import { FakeFileSystem } from './fake-file-system.js';
import type { FakeRegistry } from './fake-registry.js';

/** A digest tool a server may have. */
export type FakeHasher = 'sha256sum' | 'shasum' | 'openssl';

/** ssh's exit status when the connection fails or drops. */
export const SSH_DROPPED_EXIT = 255;

/** The same under the `umask 077` of the file writer. */
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

/** A lock token on the header line: what `remote-file.ts` accepts. */
const HEADER_TOKEN = /^[A-Za-z0-9]+$/;

/** Options for {@link FakeHost}. */
export interface FakeHostOptions {
  /** Where `docker pull` and `docker run` fetch app images from. */
  readonly registry: FakeRegistry;
  /** The ssh user; owns everything the engine creates. Defaults to `deploy`. */
  readonly user?: string;
  /** The ssh user's home, absolute, as `pwd -P` prints it. Defaults to `/home/<user>`. */
  readonly home?: string;
  /** The digest tools on the server's `PATH`. Defaults to all three. */
  readonly hashers?: readonly FakeHasher[];
}

/** One command as the host saw it. */
export interface FakeCommand {
  /** Order of arrival on this host, from 1. */
  readonly seq: number;
  /** The connection's name ({@link FakeHost.connect}). */
  readonly client: string;
  readonly argv: readonly string[];
  /** The decoded op, a `fenced` one's inner op; absent for an unmodelled argv. */
  readonly op: RemoteOp | undefined;
  /** Whether it arrived wrapped in a `fenced` op. */
  readonly fenced: boolean;
  /**
   * False when the link was already down and the command never arrived, or
   * when the fence refused it, so its op never ran.
   */
  readonly executed: boolean;
  /** The status the server-side command ended with, when it ran. */
  readonly exitCode: number | undefined;
}

/** What {@link FakeHost.onCommand} listeners receive before a command runs. */
export interface FakeCommandEvent {
  readonly seq: number;
  readonly client: string;
  /** The decoded op, a `fenced` one's inner op. */
  readonly op: RemoteOp | undefined;
  readonly fenced: boolean;
}

/** When {@link FakeHost.crashAfter} drops a client's connection. */
export type FakeCrash =
  /** After the `commands`-th command from now has run. */
  | { readonly commands: number }
  /** During the next command whose stdin is longer than `stdinBytes`, after that many bytes. */
  | { readonly stdinBytes: number };

/** One jamal process's connection to the host. */
export interface FakeClient extends RemoteRunner {
  readonly name: string;
  /** End the process: every later command from it rejects without reaching the host. */
  kill(): void;
}

/** Raised to a killed client's caller; the process it stands for no longer exists. */
export class FakeClientEndedError extends JsailsError {
  readonly code = 'client_ended';
}

/** Whether `op` changes the server (anything but a read or a health probe). */
export function isMutatingOp(op: RemoteOp): boolean {
  switch (op.kind) {
    case 'lock.status':
    case 'host.home':
    case 'host.read-state':
    case 'container.image-digest':
      return false;
    case 'fenced':
      return isMutatingOp(op.op);
    case 'docker': {
      const [, verb, ...rest] = op.argv;
      if (verb === 'inspect' || verb === 'ps' || verb === 'logs') return false;
      if ((verb === 'container' || verb === 'image') && rest[0] === 'inspect') return false;
      if (verb !== 'exec') return true;
      const command = rest[0] === '-i' ? rest.slice(2) : rest.slice(1);
      const probe =
        (command[0] === 'node' && command[1] === '-e') ||
        command[0] === 'mariadb-admin' ||
        command[0] === 'pg_isready' ||
        (command[0] === 'valkey-cli' && command[1] === 'ping') ||
        command[0] === 'varnishlog' ||
        (command[0] === 'kamal-proxy' && command[1] === 'list');
      return !probe;
    }
    default:
      return true;
  }
}

interface ArmedCrash {
  readonly client: string | undefined;
  readonly trigger: FakeCrash;
  remaining: number;
}

/** A modelled production server. */
export class FakeHost implements RemoteRunner {
  readonly fs: FakeFileSystem;
  readonly docker: FakeDocker;
  readonly hashers: Set<FakeHasher>;
  readonly #log: FakeCommand[] = [];
  readonly #unmodelled: (readonly string[])[] = [];
  readonly #listeners: ((event: FakeCommandEvent) => void | Promise<void>)[] = [];
  readonly #downLinks = new Set<string>();
  readonly #killed = new Set<string>();
  readonly #defaultClient: FakeClient;
  #crash: ArmedCrash | undefined;
  #seq = 0;

  constructor(options: FakeHostOptions) {
    const user = options.user ?? 'deploy';
    this.fs = new FakeFileSystem(user, options.home ?? `/home/${user}`);
    this.docker = new FakeDocker(this.fs, options.registry, (argv) => {
      this.#unmodelled.push([...argv]);
    });
    this.hashers = new Set(options.hashers ?? ['sha256sum', 'shasum', 'openssl']);
    this.#defaultClient = this.connect('default');
  }

  /** Every command that reached (or tried to reach) the host, in order. */
  get log(): readonly FakeCommand[] {
    return this.#log;
  }

  /** The argvs (or inner `docker` argvs) the model did not understand. */
  get unmodelled(): readonly (readonly string[])[] {
    return this.#unmodelled;
  }

  /** Run `argv` as the default client. */
  run(
    server: string,
    remoteArgv: readonly string[],
    options?: string | RemoteRunOptions,
  ): Promise<CommandResult> {
    return this.#defaultClient.run(server, remoteArgv, options);
  }

  /** A runner for the jamal process `name`. */
  connect(name: string): FakeClient {
    return {
      name,
      run: (_server, remoteArgv, options) => this.#receive(name, remoteArgv, options),
      kill: () => {
        this.#killed.add(name);
      },
    };
  }

  /** Drop a connection as {@link FakeCrash} says; `client` limits it to one process. */
  crashAfter(trigger: FakeCrash, client?: string): void {
    const remaining = 'commands' in trigger ? trigger.commands : trigger.stdinBytes;
    this.#crash = { client, trigger, remaining };
  }

  /** Bring a dropped client's connection back. */
  restoreLink(client: string): void {
    this.#downLinks.delete(client);
  }

  /** Run `listener` before every later command; returns its removal. */
  onCommand(listener: (event: FakeCommandEvent) => void | Promise<void>): () => void {
    this.#listeners.push(listener);
    return () => {
      const at = this.#listeners.indexOf(listener);
      if (at !== -1) this.#listeners.splice(at, 1);
    };
  }

  async #receive(
    client: string,
    argv: readonly string[],
    options: string | RemoteRunOptions | undefined,
  ): Promise<CommandResult> {
    if (this.#killed.has(client)) {
      throw new FakeClientEndedError('the jamal process this client stands for has ended');
    }
    const call: RemoteRunOptions =
      typeof options === 'string' ? { stdin: options } : (options ?? {});
    const decoded = decodeRemoteOp(argv);
    const fence = decoded?.kind === 'fenced' ? decoded : undefined;
    const op = fence === undefined ? decoded : fence.op;
    const fenced = fence !== undefined;
    this.#seq += 1;
    const seq = this.#seq;
    for (const listener of [...this.#listeners]) {
      await listener({ seq, client, op, fenced });
    }
    // A listener may have ended the process before it sent this command.
    if (this.#killed.has(client)) {
      throw new FakeClientEndedError('the jamal process this client stands for has ended');
    }
    const entry = { seq, client, argv: [...argv], op, fenced };
    if (this.#downLinks.has(client)) {
      this.#log.push({ ...entry, executed: false, exitCode: undefined });
      return dropped();
    }

    let stdin = await readStdin(call);
    let drops = false;
    const crash = this.#crash;
    if (crash !== undefined && (crash.client === undefined || crash.client === client)) {
      if ('commands' in crash.trigger) {
        crash.remaining -= 1;
        drops = crash.remaining <= 0;
      } else if (stdin !== undefined && stdin.length > crash.remaining) {
        stdin = stdin.subarray(0, crash.remaining);
        drops = true;
      }
      if (drops) this.#crash = undefined;
    }

    let payload = stdin ?? Buffer.alloc(0);
    let refused = false;
    if (fence !== undefined) {
      // `read -r` takes the first line; without a newline it reads no token.
      const newline = payload.indexOf(0x0a);
      const token = newline === -1 ? '' : payload.subarray(0, newline).toString('utf8');
      payload = newline === -1 ? Buffer.alloc(0) : payload.subarray(newline + 1);
      refused = token === '' || this.#heldToken(fence.lockDir) !== token;
    }
    const output: FakeOutput = refused
      ? { exitCode: FENCE_LOST_EXIT, stdout: Buffer.alloc(0), stderr: `${FENCE_LOST_MARKER}\n` }
      : op === undefined
        ? this.#unmodelledCommand(argv)
        : this.#execute(op, payload);
    this.#log.push({ ...entry, executed: !refused, exitCode: output.exitCode });
    if (drops) {
      this.#downLinks.add(client);
      return dropped();
    }
    return deliver(output, call.stdoutTo);
  }

  #unmodelledCommand(argv: readonly string[]): FakeOutput {
    this.#unmodelled.push([...argv]);
    return { exitCode: 127, stdout: Buffer.alloc(0), stderr: 'not modelled by the fake host' };
  }

  /** The token a lock directory holds, as `$(cat …)` reads it (trailing newlines dropped). */
  #heldToken(lockDir: string): string | undefined {
    return this.fs.file(`${lockDir}/${LOCK_TOKEN_FILE}`)?.data.toString('utf8').replace(/\n+$/, '');
  }

  #execute(op: RemoteOp, stdin: Buffer): FakeOutput {
    switch (op.kind) {
      case 'fenced':
        // A fence inside a fence never decodes (`decodeRemoteOp`).
        return this.#unmodelledCommand(remoteOpArgv(op));
      case 'host.read-state':
        return this.#readState(op);
      case 'container.image-digest':
        return this.#imageDigest(op);
      case 'file.write':
        return this.#writeFile(op, stdin);
      case 'lock.acquire':
        return this.#acquireLock(op);
      case 'lock.release':
        return this.#releaseLock(op.dir, op.token);
      case 'lock.force-release':
        return this.#releaseLock(op.dir, undefined);
      case 'lock.status':
        return this.#lockStatus(op);
      case 'host.home':
        return { exitCode: 0, stdout: Buffer.from(`${this.fs.home}\n`), stderr: '' };
      case 'network.ensure':
        return this.#ensureNetwork(op);
      case 'container.run-fresh':
        return this.#runFresh(op);
      case 'container.retire':
        return this.#retire(op);
      case 'cache-proxy.load':
        return this.#loadCacheProxy(op);
      case 'valkey.replace':
        return this.#replaceValkey(op);
      case 'docker':
        return this.docker.exec(op.argv, stdin);
    }
  }

  /**
   * `file.write`: read the header line, create the directory (0700) and set
   * its mode, write the payload to a unique temporary file (0600) beside the
   * destination, verify size and digest, check the fence, set the mode, and
   * rename. Every failure removes the temporary file and leaves the
   * destination as it was.
   */
  #writeFile(op: RemoteOpOf<'file.write'>, stdin: Buffer): FakeOutput {
    const newline = stdin.indexOf(0x0a);
    if (newline === -1) return status(WRITE_CHECKSUM_MISMATCH_EXIT);
    const [size, sum, token] = stdin.subarray(0, newline).toString('utf8').split(' ');
    const directory = parentOf(op.path);
    if (!this.fs.mkdirp(directory, PRIVATE_DIRECTORY_MODE)) return status(WRITE_FAILED_EXIT);
    if (op.directoryMode !== undefined && !this.fs.chmod(directory, op.directoryMode)) {
      return status(WRITE_FAILED_EXIT);
    }
    const temporary = `${directory}/${WRITE_TEMPORARY_PREFIX}${randomBytes(3).toString('hex')}`;
    const payload = stdin.subarray(newline + 1);
    if (!this.fs.write(temporary, payload, PRIVATE_FILE_MODE)) return status(WRITE_FAILED_EXIT);
    const fail = (exitCode: number): FakeOutput => {
      this.fs.removeFile(temporary);
      return status(exitCode);
    };
    if (this.hashers.size === 0) return fail(WRITE_NO_HASHER_EXIT);
    const digest = createHash('sha256').update(payload).digest('hex');
    if (String(payload.length) !== size || digest !== sum) {
      return fail(WRITE_CHECKSUM_MISMATCH_EXIT);
    }
    if (op.lockDir !== undefined) {
      const held = this.#heldToken(op.lockDir);
      if (token === undefined || !HEADER_TOKEN.test(token) || held !== token) {
        return fail(WRITE_LOCK_LOST_EXIT);
      }
    }
    if (op.expect === WRITE_EXPECT_ABSENT) {
      if (this.fs.exists(op.path)) return fail(WRITE_PRECONDITION_EXIT);
    } else if (op.expect !== undefined) {
      const current = this.fs.file(op.path);
      const sum = current === undefined ? undefined : createHash('sha256').update(current.data);
      if (sum?.digest('hex') !== op.expect) return fail(WRITE_PRECONDITION_EXIT);
    }
    if (!this.fs.chmod(temporary, op.mode)) return fail(WRITE_FAILED_EXIT);
    return this.fs.rename(temporary, op.path) ? status(0) : fail(WRITE_FAILED_EXIT);
  }

  /**
   * `lock.acquire` under `umask 077`: `mkdir` is the atomic test-and-set;
   * holding it, hand out the next sequence number from the file beside it,
   * then write the token and the owner document. A failure after the
   * `mkdir` removes the directory again.
   */
  #acquireLock(op: RemoteOpOf<'lock.acquire'>): FakeOutput {
    const parent = parentOf(op.dir);
    if (!this.fs.mkdirp(parent, PRIVATE_DIRECTORY_MODE)) return status(LOCK_ACQUIRE_FAILED_EXIT);
    if (!this.fs.mkdir(op.dir, PRIVATE_DIRECTORY_MODE)) return status(LOCK_CONTENDED_EXIT);
    const seqFile = `${parent}/${LOCK_SEQ_FILE}`;
    const last = this.fs.exists(seqFile)
      ? this.fs.file(seqFile)?.data.toString('utf8').replace(/\n+$/, '')
      : '0';
    if (last === undefined || !/^(?:0|[1-9][0-9]*)$/.test(last)) {
      this.fs.removeDirectory(op.dir);
      return status(LOCK_ACQUIRE_FAILED_EXIT);
    }
    const seq = Number(last) + 1;
    this.fs.write(seqFile, Buffer.from(`${seq}\n`), PRIVATE_FILE_MODE);
    this.fs.write(`${op.dir}/${LOCK_TOKEN_FILE}`, Buffer.from(`${op.token}\n`), PRIVATE_FILE_MODE);
    this.fs.write(
      `${op.dir}/${LOCK_OWNER_FILE}`,
      Buffer.from(`{"seq":${seq},${op.owner}\n`),
      PRIVATE_FILE_MODE,
    );
    return { exitCode: 0, stdout: Buffer.from(`${seq}\n`), stderr: '' };
  }

  /** `lock.release` with a token, `lock.force-release` without one. */
  #releaseLock(dir: string, token: string | undefined): FakeOutput {
    if (this.fs.directory(dir) === undefined) return status(0);
    if (token !== undefined && this.#heldToken(dir) !== token) {
      return status(LOCK_NOT_OWNER_EXIT);
    }
    this.fs.removeFile(`${dir}/${LOCK_OWNER_FILE}`);
    this.fs.removeFile(`${dir}/${LOCK_TOKEN_FILE}`);
    return status(this.fs.removeDirectory(dir) ? 0 : 1);
  }

  /** `lock.status`: print the owner document of a held lock. */
  #lockStatus(op: RemoteOpOf<'lock.status'>): FakeOutput {
    if (this.fs.directory(op.dir) === undefined) return status(LOCK_NOT_HELD_EXIT);
    const owner = this.fs.file(`${op.dir}/${LOCK_OWNER_FILE}`)?.data ?? Buffer.alloc(0);
    return { exitCode: 0, stdout: owner, stderr: '' };
  }

  /**
   * `host.read-state`: frame `state.json`, each release manifest (in the
   * shell glob's order), a secrets-file marker per release that has one,
   * then each extra file; a missing file prints nothing.
   */
  #readState(op: RemoteOpOf<'host.read-state'>): FakeOutput {
    const chunks: Buffer[] = [];
    const emit = (path: string): void => {
      const file = this.fs.file(path);
      if (file === undefined) return;
      chunks.push(Buffer.from(`F ${file.data.length} ${path}\n`), file.data);
    };
    const releases = Object.keys(this.fs.snapshot(`${op.dir}/releases`).directories)
      .filter((name) => !name.includes('/'))
      .sort();
    emit(`${op.dir}/state.json`);
    for (const release of releases) emit(`${op.dir}/releases/${release}/manifest.json`);
    for (const release of releases) {
      const secrets = `${op.dir}/releases/${release}/secrets/secrets.json`;
      if (this.fs.file(secrets) !== undefined) chunks.push(Buffer.from(`E ${secrets}\n`));
    }
    for (const path of op.extra) emit(path);
    return { exitCode: 0, stdout: Buffer.concat(chunks), stderr: '' };
  }

  /** `container.image-digest`: the container's image id, then that image's repository digests. */
  #imageDigest(op: RemoteOpOf<'container.image-digest'>): FakeOutput {
    const id = this.docker.exec([
      'docker',
      'inspect',
      '--type',
      'container',
      '-f',
      '{{.Image}}',
      op.name,
    ]);
    if (id.exitCode !== 0) return status(NO_SUCH_CONTAINER_EXIT);
    return this.docker.exec([
      'docker',
      'image',
      'inspect',
      '-f',
      '{{json .RepoDigests}}',
      id.stdout.toString('utf8').trim(),
    ]);
  }

  /** `network.ensure`: create the network, attach each existing container not on it. */
  #ensureNetwork(op: RemoteOpOf<'network.ensure'>): FakeOutput {
    this.docker.createNetwork(JAMAL_NETWORK);
    for (const name of op.connect) {
      const container = this.docker.container(name);
      if (container !== undefined && !container.networks.has(JAMAL_NETWORK)) {
        this.docker.connect(JAMAL_NETWORK, name);
      }
    }
    return status(0);
  }

  /** `container.run-fresh`: remove a stopped namesake, run, and clean up a failed run. */
  #runFresh(op: RemoteOpOf<'container.run-fresh'>): FakeOutput {
    this.docker.remove(op.name, false);
    const run = this.docker.exec(op.run);
    if (run.exitCode === 0) return run;
    this.docker.remove(op.name, false);
    return run;
  }

  /** `container.retire`: stop and remove when it exists. */
  #retire(op: RemoteOpOf<'container.retire'>): FakeOutput {
    if (this.docker.container(op.name) === undefined) return status(0);
    this.docker.stop(op.name);
    return status(this.docker.remove(op.name, false) ? 0 : 1);
  }

  /** `cache-proxy.load`: reload a running Varnish on the same image, else replace it. */
  #loadCacheProxy(op: RemoteOpOf<'cache-proxy.load'>): FakeOutput {
    const running = this.docker.container(op.name);
    if (running?.state === 'running' && running.image === op.image) return status(0);
    this.docker.remove(op.name, true);
    return this.docker.exec(op.boot);
  }

  /** `valkey.replace`: stop, swap the staged dump in, start, report the worst step. */
  #replaceValkey(op: RemoteOpOf<'valkey.replace'>): FakeOutput {
    if (!this.docker.stop(op.container)) return status(BACKUP_EXIT_VALKEY.stopFailed);
    const swapped = this.docker.swapValkeyStage(op.mount);
    if (!this.docker.start(op.container)) {
      return status(swapped ? BACKUP_EXIT_VALKEY.startFailed : BACKUP_EXIT_VALKEY.nothingStarted);
    }
    return status(swapped ? 0 : BACKUP_EXIT_VALKEY.swapFailed);
  }
}

/** The parent directory of a path the engine sends. */
function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  if (slash === -1) return '.';
  return slash === 0 ? '/' : path.slice(0, slash);
}

function status(exitCode: number): FakeOutput {
  return { exitCode, stdout: Buffer.alloc(0), stderr: '' };
}

function dropped(): CommandResult {
  return { exitCode: SSH_DROPPED_EXIT, stdout: '', stderr: 'Connection closed by remote host' };
}

/** The command's stdin as bytes: the payload, or everything the stream yields. */
async function readStdin(call: RemoteRunOptions): Promise<Buffer | undefined> {
  if (typeof call.stdin === 'string') return Buffer.from(call.stdin, 'utf8');
  if (call.stdin !== undefined) return Buffer.from(call.stdin);
  if (call.stdinFrom === undefined) return undefined;
  return readAll(call.stdinFrom);
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

/**
 * Hand the output to the caller the way the process runner does: into
 * `stdoutTo` (ended, and awaited until it finished) or as captured text.
 */
async function deliver(output: FakeOutput, stdoutTo: Writable | undefined): Promise<CommandResult> {
  if (stdoutTo === undefined) {
    return {
      exitCode: output.exitCode,
      stdout: output.stdout.toString('utf8'),
      stderr: output.stderr,
    };
  }
  stdoutTo.end(output.stdout);
  await finished(stdoutTo);
  return { exitCode: output.exitCode, stdout: '', stderr: output.stderr };
}
