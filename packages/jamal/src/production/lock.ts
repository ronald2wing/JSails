/**
 * The deploy lock of one app on its production server, and the fence every
 * command of the lock holder passes through.
 *
 * The lock is a directory (`host-layout.ts` {@link hostLockDir}) that at most
 * one run holds. {@link acquireLock} creates it atomically with `mkdir` over
 * ssh; inside it the `lock.acquire` script hands the run the next sequence
 * number (kept in `lock.seq` beside the directory, so it grows across
 * acquisitions) and records a random `token` and an `owner.json` document
 * (`{ seq, who, host, since, for? }`). Contention, an ssh failure (exit 255:
 * authentication, host key, DNS, refused connection), and any other remote
 * error are told apart, each a value-free `jamal_lock.*` error that names
 * neither the server nor the directory.
 *
 * The returned {@link LockHandle} carries:
 *
 * - `remote`: the fenced runner. Every command sent through it runs only
 *   while the lock still holds this run's token (`fenced` in
 *   `remote-op.ts`), and a lost lock throws `jamal_lock.lock_lost` before the
 *   command starts. A run whose lock was force-released and taken by another
 *   therefore cannot start one more command on the host; a command already
 *   running when the lock was taken finishes.
 * - `fence`: the directory and token a `writeRemoteFile` checks right before
 *   its rename, which is later than the fenced runner could.
 * - `release()`: removes the lock only while its token is this handle's, so a
 *   run that lost its lock never removes the next holder's; idempotent.
 *
 * A run killed before it releases leaves the lock behind: {@link lockStatus}
 * reports whether it is held and by whom, and {@link forceReleaseLock}
 * clears it whoever holds it (`jamal lock status|release`).
 */

import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import { CONTROL_CHARS } from 'jsails/support';
import { defineErrors, type ErrorRegistry } from 'jsails/errors';

import { isPlainObject } from '../object-shape.js';
import type { CommandResult } from './process-runner.js';
import {
  FENCE_LOST_EXIT,
  FENCE_LOST_MARKER,
  LOCK_CONTENDED_EXIT,
  LOCK_NOT_HELD_EXIT,
  LOCK_NOT_OWNER_EXIT,
  decodeRemoteOp,
  remoteOpArgv,
  runRemoteOp,
} from './remote-op.js';
import type { RemoteWriteFence } from './remote-file.js';
import type { RemoteRunOptions, RemoteRunner } from './transport.js';

const LOCK_ERRORS = {
  invalid_directory: {
    kind: 'invalid',
    message:
      'the lock directory must be a non-empty path without whitespace or control characters, not starting with "-"',
  },
  contended: {
    kind: 'conflict',
    message: 'the deploy lock is already held',
    suggestion:
      'run "jamal lock status" to see who holds it, and "jamal lock release" if that run is no longer running',
  },
  unreachable: {
    kind: 'unavailable',
    message: 'the server could not be reached over ssh',
  },
  io_failed: {
    kind: 'unavailable',
    message: 'the deploy lock could not be {operation}',
    context: { operation: ['created', 'read', 'released'] },
    suggestion: 'check the ssh connection, the disk, and the permissions of ~/.jamal on the server',
  },
  not_owner: {
    kind: 'conflict',
    message:
      'the deploy lock was released by someone else and is now held by another run; it was left in place',
  },
  unfenced_command: {
    kind: 'internal',
    message: 'a command that is no remote op was sent under the deploy lock, so it was not run',
  },
  lock_lost: {
    kind: 'conflict',
    message:
      'the deploy lock no longer holds the token this run wrote, so nothing more was run on the server',
    suggestion:
      'another run took the lock after it was force-released; let it finish, then run the verb again',
  },
} as const;

/**
 * `jamal_lock.*`: the deploy lock could not be taken, read, or released, or
 * the run holding it lost it.
 */
export const LockErrors: ErrorRegistry<'jamal_lock', typeof LOCK_ERRORS> = defineErrors(
  'jamal_lock',
  LOCK_ERRORS,
);

/** Who takes the lock, as `owner.json` records it beside the sequence number. */
export interface LockOwner {
  /** The local user name. */
  readonly who: string;
  /** The local machine's host name. */
  readonly host: string;
  /** When the run started, as an ISO 8601 time. */
  readonly since: string;
  /** What the run is doing when it is not a release (`backup db`). */
  readonly for?: string;
}

/** An owner document as read back from the server. */
export interface LockOwnerRecord extends LockOwner {
  readonly seq: number;
}

/** Options naming the ssh target and the lock directory. */
interface LockOptions {
  readonly server: string;
  readonly lockDir: string;
}

/** Options for {@link acquireLock}: the target plus the owner to record. */
interface AcquireLockOptions extends LockOptions {
  readonly owner: LockOwner;
}

/** A held lock. */
export interface LockHandle {
  /** The sequence number this acquisition was handed; it grows with every acquisition. */
  readonly seq: number;
  /** The lock directory and the token this handle wrote there, for a fenced file write. */
  readonly fence: RemoteWriteFence;
  /** A runner whose every command runs only while the lock still holds this handle's token. */
  readonly remote: RemoteRunner;
  /** Remove the lock while it is still this handle's; idempotent. */
  release(): Promise<void>;
}

/** What {@link lockStatus} reports. */
export interface LockStatus {
  readonly held: boolean;
  /** The recorded owner, when the lock is held and its document could be read. */
  readonly owner?: LockOwnerRecord;
}

/** ssh's own exit status for a connection or authentication failure. */
const SSH_FAILURE_EXIT = 255;

/** Every control character, for replacing them in a recorded owner field. */
const CONTROL_CHARS_GLOBAL = new RegExp(CONTROL_CHARS.source, 'g');

/** Reject a lock directory that cannot be a safe path argument, value-free. */
function assertLockDir(lockDir: string): void {
  if (
    typeof lockDir !== 'string' ||
    lockDir.length === 0 ||
    /\s/.test(lockDir) ||
    CONTROL_CHARS.test(lockDir) ||
    lockDir.startsWith('-')
  ) {
    throw new LockErrors.Error('invalid_directory');
  }
}

/** The remote argv that prints the owner document and exits 0 when the lock is held. */
export function lockStatusArgv(lockDir: string): readonly string[] {
  assertLockDir(lockDir);
  return remoteOpArgv({ kind: 'lock.status', dir: lockDir });
}

/** The remote argv that removes the lock whoever holds it (a missing lock is not an error). */
export function lockReleaseArgv(lockDir: string): readonly string[] {
  assertLockDir(lockDir);
  return remoteOpArgv({ kind: 'lock.force-release', dir: lockDir });
}

/**
 * The owner document after its sequence number, as the acquire script
 * splices it in: every field a string free of control characters.
 */
function ownerTail(owner: LockOwner): string {
  const clean = (value: string): string => value.replace(CONTROL_CHARS_GLOBAL, ' ');
  const body = JSON.stringify({
    who: clean(owner.who),
    host: clean(owner.host),
    since: clean(owner.since),
    ...(owner.for === undefined ? {} : { for: clean(owner.for) }),
  });
  return body.slice(1);
}

/**
 * Acquire the deploy lock on `server` by creating `lockDir`. Resolves with
 * the handle; throws `jamal_lock.contended` when another run holds it,
 * `unreachable` for an ssh failure, and `io_failed` otherwise.
 */
export async function acquireLock(
  remote: RemoteRunner,
  options: AcquireLockOptions,
): Promise<LockHandle> {
  const { server, lockDir } = options;
  assertLockDir(lockDir);
  const token = randomBytes(16).toString('hex');
  const result = await runRemoteOp(remote, server, {
    kind: 'lock.acquire',
    dir: lockDir,
    owner: ownerTail(options.owner),
    token,
  });
  if (result.exitCode === LOCK_CONTENDED_EXIT) throw new LockErrors.Error('contended');
  if (result.exitCode === SSH_FAILURE_EXIT) throw new LockErrors.Error('unreachable');
  const seq = Number(result.stdout.trim());
  if (result.exitCode !== 0 || !Number.isSafeInteger(seq) || seq < 1) {
    throw new LockErrors.Error('io_failed', { operation: 'created' });
  }
  return createHandle(remote, server, lockDir, token, seq);
}

/** Read an owner document back; anything that is not one is `undefined`. */
export function parseLockOwner(text: string): LockOwnerRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const { seq, who, host, since } = parsed;
  const activity = parsed.for;
  if (
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    typeof who !== 'string' ||
    typeof host !== 'string' ||
    typeof since !== 'string' ||
    (activity !== undefined && typeof activity !== 'string')
  ) {
    return undefined;
  }
  return activity === undefined
    ? { seq, who, host, since }
    : { seq, who, host, since, for: activity };
}

/** Report whether the deploy lock is held and, when recorded, by whom. */
export async function lockStatus(remote: RemoteRunner, options: LockOptions): Promise<LockStatus> {
  const { server, lockDir } = options;
  const result = await remote.run(server, lockStatusArgv(lockDir));
  if (result.exitCode === SSH_FAILURE_EXIT) throw new LockErrors.Error('unreachable');
  // Only the script's own "not held" status means free: a remote shell that
  // could not run the script (126/127, an unreadable home) must not be read
  // as permission to release or deploy over a live lock.
  if (result.exitCode === LOCK_NOT_HELD_EXIT) return { held: false };
  if (result.exitCode !== 0) throw new LockErrors.Error('io_failed', { operation: 'read' });
  const owner = parseLockOwner(result.stdout);
  return owner === undefined ? { held: true } : { held: true, owner };
}

/** One line describing a lock owner, as `jamal lock status` prints it. */
export function formatLockOwner(owner: LockOwnerRecord): string {
  const activity = owner.for === undefined ? '' : `, ${owner.for}`;
  return `${owner.who}@${owner.host} since ${owner.since} (seq ${owner.seq}${activity})`;
}

/**
 * Remove the deploy lock whoever holds it: the recovery path after a run was
 * killed before it could release. Removing a lock that is not held is a
 * no-op.
 */
export async function forceReleaseLock(remote: RemoteRunner, options: LockOptions): Promise<void> {
  await runRelease(remote, options.server, lockReleaseArgv(options.lockDir));
}

/** Run a release script and map its failures. */
async function runRelease(
  remote: RemoteRunner,
  server: string,
  argv: readonly string[],
): Promise<void> {
  const result = await remote.run(server, argv);
  if (result.exitCode === SSH_FAILURE_EXIT) throw new LockErrors.Error('unreachable');
  if (result.exitCode === LOCK_NOT_OWNER_EXIT) throw new LockErrors.Error('not_owner');
  if (result.exitCode !== 0) throw new LockErrors.Error('io_failed', { operation: 'released' });
}

/** Whether a command's result is the fence's own report of a lost lock. */
function isFenceLoss(result: CommandResult): boolean {
  return result.exitCode === FENCE_LOST_EXIT && result.stderr.trim() === FENCE_LOST_MARKER;
}

/** `head`, then every chunk of `rest`, as bytes. */
async function* prefixed(head: Buffer, rest: Readable): AsyncGenerator<Buffer> {
  yield head;
  for await (const chunk of rest) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  }
}

/**
 * The stdin a fenced command receives: the token line, then the inner
 * command's own stdin (text, bytes, or a stream).
 */
function fencedOptions(token: string, options: RemoteRunOptions): RemoteRunOptions {
  const line = Buffer.from(`${token}\n`, 'ascii');
  const { stdin, stdinFrom, ...rest } = options;
  if (stdinFrom !== undefined) {
    return { ...rest, stdinFrom: Readable.from(prefixed(line, stdinFrom)) };
  }
  const payload =
    stdin === undefined
      ? Buffer.alloc(0)
      : typeof stdin === 'string'
        ? Buffer.from(stdin, 'utf8')
        : stdin;
  return { ...rest, stdin: Buffer.concat([line, payload]) };
}

/**
 * The runner of a lock holder: every command is wrapped in the `fenced` op,
 * except a file write fenced by this same lock (it checks the token itself,
 * right before its rename) and the lock's own ops.
 */
function fencedRunner(remote: RemoteRunner, lockDir: string, token: string): RemoteRunner {
  return {
    async run(server, remoteArgv, options) {
      const call: RemoteRunOptions =
        typeof options === 'string' ? { stdin: options } : (options ?? {});
      const op = decodeRemoteOp(remoteArgv);
      // The fence can only wrap an op it can spell again.
      if (op === undefined || op.kind === 'fenced') {
        throw new LockErrors.Error('unfenced_command');
      }
      const ownFence =
        (op.kind === 'file.write' && op.lockDir === lockDir) || op.kind.startsWith('lock.');
      if (ownFence) return remote.run(server, remoteArgv, call);
      const result = await remote.run(
        server,
        remoteOpArgv({ kind: 'fenced', lockDir, op }),
        fencedOptions(token, call),
      );

      if (isFenceLoss(result)) throw new LockErrors.Error('lock_lost');
      return result;
    },
  };
}

/** Build a {@link LockHandle} that removes its own lock exactly once. */
function createHandle(
  remote: RemoteRunner,
  server: string,
  lockDir: string,
  token: string,
  seq: number,
): LockHandle {
  let released = false;
  return {
    seq,
    fence: Object.freeze({ dir: lockDir, token }),
    remote: fencedRunner(remote, lockDir, token),
    async release() {
      if (released) return;
      released = true;
      await runRelease(remote, server, remoteOpArgv({ kind: 'lock.release', dir: lockDir, token }));
    },
  };
}
