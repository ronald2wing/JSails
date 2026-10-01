/**
 * Remote deploy lock for jamal production deploys.
 *
 * A deploy lock is a directory on the target server that at most one release
 * may hold at a time. {@link acquireLock} creates it atomically with `mkdir`
 * over ssh and writes an `owner` file (who, from which machine, since when)
 * and a random `token` file inside it. The remote script exits 1 only when the directory already exists,
 * so contention ({@link LockContentionError}) is told apart from an ssh
 * failure (exit 255: authentication, host key, DNS, refused connection) and
 * any other remote error, which raise a {@link LockError} with their own
 * codes. No message names the server or the lock directory.
 *
 * The handle's `release()` removes the lock only while its `token` file still
 * holds the token this handle wrote; it is idempotent. Without that check, a
 * deploy whose lock was force-released (and then taken by a second deploy)
 * would delete the second deploy's lock when it finished, letting a third run
 * concurrently. A deploy killed before it can release leaves the lock behind,
 * so {@link lockStatus} reports whether it is held and by whom, and
 * {@link forceReleaseLock} clears it whoever holds it; `jamal lock
 * status|release` expose both.
 *
 * The directory lives under `.jamal/locks/` relative to the ssh user's home,
 * not in world-writable `/tmp`, so another local user on the server cannot
 * create it to block deploys. Every command runs through the injected
 * {@link RemoteRunner}, which quotes each argv element for the remote shell;
 * the scripts read the directory and owner only as positional parameters.
 */

import { randomBytes } from 'node:crypto';

import { JsailsError, CONTROL_CHARS } from 'jsails/support';
import type { RemoteRunner } from './transport.js';

/** Why the deploy lock could not be taken or released. */
export type LockErrorCode =
  'invalid_directory' | 'contended' | 'io_failed' | 'unreachable' | 'not_owner';

/** Raised for any lock failure. Value-free: never names the server or directory. */
export class LockError extends JsailsError {
  constructor(
    readonly code: LockErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Raised when the deploy lock is already held. Value-free. */
export class LockContentionError extends LockError {
  constructor(message: string) {
    super('contended', message);
  }
}

/** Options naming the ssh target and the lock directory. */
interface LockOptions {
  readonly server: string;
  readonly lockDir: string;
}

/** Options for {@link acquireLock}: the target plus the owner line to record. */
interface AcquireLockOptions extends LockOptions {
  /** One line recorded in the lock (`user@host since <iso time>`); never a secret. */
  readonly owner?: string;
}

/** A held lock; {@link release} removes it (idempotently). */
export interface LockHandle {
  release(): Promise<void>;
}

/** What {@link lockStatus} reports. */
export interface LockStatus {
  readonly held: boolean;
  /** The recorded owner line, when the lock is held and has one. */
  readonly owner?: string;
}

/** ssh's own exit status for a connection or authentication failure. */
const SSH_FAILURE_EXIT = 255;

/** The exit status the acquire script reserves for "the directory already exists". */
const CONTENDED_EXIT = 1;

/**
 * Create the parent, then the lock directory itself; only the second `mkdir`
 * may report contention (exit 1). A failure to record the owner or token
 * removes the directory again, since a lock without this caller's token could
 * never be released by it; any other failure exits 3.
 */
const ACQUIRE_SCRIPT =
  'mkdir -p -- "$(dirname -- "$1")" || exit 3; ' +
  'mkdir -- "$1" 2>/dev/null || exit 1; ' +
  '{ printf "%s\\n" "$2" > "$1/owner" && printf "%s\\n" "$3" > "$1/token"; } || ' +
  '{ rm -f -- "$1/owner" "$1/token"; rmdir -- "$1"; exit 3; }';

/** Remove the lock whoever holds it; a missing lock is not an error. */
const FORCE_RELEASE_SCRIPT =
  '[ -d "$1" ] || exit 0; rm -f -- "$1/owner" "$1/token" && rmdir -- "$1"';

/** The exit status the owned-release script reserves for "held under another token". */
const NOT_OWNER_EXIT = 4;

/**
 * Remove the lock only while it still carries the caller's token (`$2`); a
 * missing lock is not an error, and a lock under another token exits 4.
 */
const OWNED_RELEASE_SCRIPT =
  '[ -d "$1" ] || exit 0; ' +
  '[ "$(cat -- "$1/token" 2>/dev/null)" = "$2" ] || exit 4; ' +
  'rm -f -- "$1/owner" "$1/token" && rmdir -- "$1"';

/** The exit status the status script reserves for "the lock is not held". */
const NOT_HELD_EXIT = 1;

/** Exit 0 and print the owner line when held, exit 1 when not held. */
const STATUS_SCRIPT = '[ -d "$1" ] || exit 1; cat -- "$1/owner" 2>/dev/null; exit 0';

/** Every control character, for replacing them in the recorded owner line. */
const CONTROL_CHARS_GLOBAL = new RegExp(CONTROL_CHARS.source, 'g');

/** Reject a lock directory that cannot be a safe path argument, value-free. */
function assertLockDir(lockDir: string): void {
  if (typeof lockDir !== 'string' || lockDir.length === 0) {
    throw new LockError('invalid_directory', 'the lock directory must be a non-empty string');
  }
  if (/\s/.test(lockDir) || CONTROL_CHARS.test(lockDir)) {
    throw new LockError(
      'invalid_directory',
      'the lock directory must not contain whitespace or control characters',
    );
  }
  if (lockDir.startsWith('-')) {
    throw new LockError('invalid_directory', 'the lock directory must not start with "-"');
  }
}

/** The remote argv that prints the owner line and exits 0 when the lock is held. */
export function lockStatusArgv(lockDir: string): readonly string[] {
  assertLockDir(lockDir);
  return ['sh', '-c', STATUS_SCRIPT, 'sh', lockDir];
}

/** The remote argv that removes the lock whoever holds it (a missing lock is not an error). */
export function lockReleaseArgv(lockDir: string): readonly string[] {
  assertLockDir(lockDir);
  return ['sh', '-c', FORCE_RELEASE_SCRIPT, 'sh', lockDir];
}

/** Map an ssh-level failure to a value-free error. */
function unreachable(): LockError {
  return new LockError('unreachable', 'the server could not be reached over ssh');
}

/**
 * Acquire the deploy lock on `server` by creating `lockDir`. A zero exit means
 * this caller holds the lock; exit 1 is contention, exit 255 an ssh failure,
 * and anything else a remote I/O error. The returned handle's `release()`
 * removes the lock and is idempotent.
 */
export async function acquireLock(
  remote: RemoteRunner,
  options: AcquireLockOptions,
): Promise<LockHandle> {
  const { server, lockDir } = options;
  assertLockDir(lockDir);
  const owner = (options.owner ?? 'jamal').replace(CONTROL_CHARS_GLOBAL, ' ');
  const token = randomBytes(16).toString('hex');
  const result = await remote.run(server, [
    'sh',
    '-c',
    ACQUIRE_SCRIPT,
    'sh',
    lockDir,
    owner,
    token,
  ]);
  if (result.exitCode === CONTENDED_EXIT) {
    throw new LockContentionError(
      'the deploy lock is already held; run "jamal lock status" to see who holds it, ' +
        'and "jamal lock release" if that deploy is no longer running',
    );
  }
  if (result.exitCode === SSH_FAILURE_EXIT) {
    throw unreachable();
  }
  if (result.exitCode !== 0) {
    throw new LockError('io_failed', 'the deploy lock could not be created');
  }
  return createHandle(remote, server, lockDir, token);
}

/** Report whether the deploy lock is held and, when recorded, by whom. */
export async function lockStatus(remote: RemoteRunner, options: LockOptions): Promise<LockStatus> {
  const { server, lockDir } = options;
  const result = await remote.run(server, lockStatusArgv(lockDir));
  if (result.exitCode === SSH_FAILURE_EXIT) {
    throw unreachable();
  }
  // Only the script's own "not held" status means free: a remote shell that
  // could not run the script (126/127, an unreadable home) must not be read
  // as permission to release or deploy over a live lock.
  if (result.exitCode === NOT_HELD_EXIT) {
    return { held: false };
  }
  if (result.exitCode !== 0) {
    throw new LockError('io_failed', 'the deploy lock status could not be read');
  }
  const owner = result.stdout.trim();
  return owner === '' ? { held: true } : { held: true, owner };
}

/**
 * Remove the deploy lock whoever holds it: the recovery path after a deploy
 * was killed before it could release. Removing a lock that is not held is a
 * no-op.
 */
export async function forceReleaseLock(remote: RemoteRunner, options: LockOptions): Promise<void> {
  const { server, lockDir } = options;
  await runRelease(remote, server, lockReleaseArgv(lockDir));
}

/** Run a release script and map its failures. */
async function runRelease(
  remote: RemoteRunner,
  server: string,
  argv: readonly string[],
): Promise<void> {
  const result = await remote.run(server, argv);
  if (result.exitCode === SSH_FAILURE_EXIT) {
    throw unreachable();
  }
  if (result.exitCode === NOT_OWNER_EXIT) {
    throw new LockError(
      'not_owner',
      'the deploy lock was released by someone else and is now held by another deploy; ' +
        'it was left in place',
    );
  }
  if (result.exitCode !== 0) {
    throw new LockError('io_failed', 'the deploy lock could not be released');
  }
}

/** Build a {@link LockHandle} that removes its own lock exactly once. */
function createHandle(
  remote: RemoteRunner,
  server: string,
  lockDir: string,
  token: string,
): LockHandle {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await runRelease(remote, server, ['sh', '-c', OWNED_RELEASE_SCRIPT, 'sh', lockDir, token]);
    },
  };
}
