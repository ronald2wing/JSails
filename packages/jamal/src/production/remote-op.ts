/**
 * The remote operations jamal performs on a production server, as data.
 *
 * Every command the engine sends over ssh is one {@link RemoteOp}: a host
 * script (write a file, take or release the deploy lock, replace or retire a
 * container, ...) or a plain `docker` argv. {@link remoteOpArgv} is the one
 * place a host script's text lives and turns an op into the argv the
 * transport quotes for the remote shell; each script reads its inputs only as
 * positional parameters, so no value is ever spliced into shell text. The exit
 * statuses a script reserves for the failures it recognizes are part of its
 * op and are exported beside it.
 *
 * {@link decodeRemoteOp} is the exact inverse over everything
 * {@link remoteOpArgv} produces: it recognizes a host script by its full text
 * and reads the parameters back, and it returns `undefined` for an argv that
 * is neither a known script nor a `docker` command. A model of the server
 * (`testing/fake-host.ts`) implements each op from that decoding instead of
 * interpreting shell, so a script added outside this module is refused by the
 * model rather than silently accepted.
 *
 * An op of kind `fenced` wraps any other op so it runs only while the deploy
 * lock still holds the caller's token: the token arrives on the first line
 * of stdin (off the remote `ps`), and a lost lock ends the command before
 * the inner op starts, with {@link FENCE_LOST_EXIT} and the
 * {@link FENCE_LOST_MARKER} line on stderr.
 */

import { JAMAL_NETWORK } from './host-layout.js';
import type { CommandResult } from './process-runner.js';
import type { RemoteRunOptions, RemoteRunner } from './transport.js';

/** One operation on the production server. */
export type RemoteOp =
  /**
   * Write stdin (an integrity header line, then the payload) to `path` by
   * rename, as `mode`, after setting its directory to `directoryMode` when
   * given and, when `lockDir` is given, only while that lock still holds the
   * token the header carries. `expect` is a precondition on what the
   * destination holds now: `absent` (create only) or the SHA-256 hex of its
   * current bytes (compare and replace).
   */
  | {
      readonly kind: 'file.write';
      readonly path: string;
      readonly mode: number;
      readonly directoryMode: number | undefined;
      readonly lockDir: string | undefined;
      readonly expect: string | undefined;
    }
  /**
   * Create the lock directory `dir`, hand it the next sequence number from
   * the {@link LOCK_SEQ_FILE} beside it, and record `token` and the owner
   * document (`{"seq":<n>,` followed by `owner`, the rest of a JSON object)
   * in it. Prints the sequence number.
   */
  | {
      readonly kind: 'lock.acquire';
      readonly dir: string;
      readonly owner: string;
      readonly token: string;
    }
  /** Remove the lock directory while it still carries `token`. */
  | { readonly kind: 'lock.release'; readonly dir: string; readonly token: string }
  /** Remove the lock directory whoever holds it. */
  | { readonly kind: 'lock.force-release'; readonly dir: string }
  /** Report whether the lock directory exists, printing its owner document. */
  | { readonly kind: 'lock.status'; readonly dir: string }
  /**
   * Run `op` only while the lock directory `lockDir` holds the token on the
   * first line of stdin; the rest of stdin is the inner op's.
   */
  | { readonly kind: 'fenced'; readonly lockDir: string; readonly op: RemoteOp }
  /**
   * Print, framed, the files an app's host state is made of below `dir`
   * (`state.json`, each release's `manifest.json`) and each file of `extra`,
   * and name each release whose secrets file exists without printing it.
   */
  | { readonly kind: 'host.read-state'; readonly dir: string; readonly extra: readonly string[] }
  /** Print the repository digests of the image the container `name` runs. */
  | { readonly kind: 'container.image-digest'; readonly name: string }
  /**
   * Print the ssh session's working directory, the ssh user's home, as an
   * absolute path with every symbolic link resolved.
   */
  | { readonly kind: 'host.home' }
  /** Create the shared network when missing and attach each existing `connect` container. */
  | { readonly kind: 'network.ensure'; readonly connect: readonly string[] }
  /** Remove a stopped container named `name`, then run `run` (a `docker run` argv). */
  | {
      readonly kind: 'container.run-fresh';
      readonly name: string;
      readonly run: readonly string[];
    }
  /** Stop and remove the container `name` when it exists. */
  | { readonly kind: 'container.retire'; readonly name: string }
  /**
   * Reload the VCL in the running cache proxy `name` on `image`, or replace
   * the container with `boot` (a `docker run` argv).
   */
  | {
      readonly kind: 'cache-proxy.load';
      readonly name: string;
      readonly image: string;
      readonly boot: readonly string[];
    }
  /**
   * Stop the Valkey accessory `container`, run `swap` in a throwaway `image`
   * container with `mount`, and start the accessory again.
   */
  | {
      readonly kind: 'valkey.replace';
      readonly container: string;
      readonly mount: string;
      readonly image: string;
      readonly swap: string;
    }
  /** A plain `docker` argv (`argv[0]` is `docker`). */
  | { readonly kind: 'docker'; readonly argv: readonly string[] };

/** The kind of a {@link RemoteOp}. */
export type RemoteOpKind = RemoteOp['kind'];

/** The {@link RemoteOp} of one kind. */
export type RemoteOpOf<K extends RemoteOpKind> = Extract<RemoteOp, { readonly kind: K }>;

/** `file.write`: the received payload does not match its header's size and SHA-256. */
export const WRITE_CHECKSUM_MISMATCH_EXIT = 4;

/** `file.write`: the lock it was fenced by no longer holds the header's token. */
export const WRITE_LOCK_LOST_EXIT = 5;

/** `file.write`: the server has none of `sha256sum`, `shasum` and `openssl`. */
export const WRITE_NO_HASHER_EXIT = 6;

/** `file.write`: any other failure (a directory, the temporary file, the rename). */
export const WRITE_FAILED_EXIT = 3;

/** `file.write`: the destination does not hold what the write's `expect` says. */
export const WRITE_PRECONDITION_EXIT = 7;

/** The `expect` of a `file.write` that only creates its destination. */
export const WRITE_EXPECT_ABSENT = 'absent';

/** `fenced`: the lock no longer holds the caller's token; the inner op did not run. */
export const FENCE_LOST_EXIT = 5;

/**
 * The one line `fenced` writes to stderr with {@link FENCE_LOST_EXIT}, so an
 * inner op that happens to exit 5 is never taken for a lost lock.
 */
export const FENCE_LOST_MARKER = 'jamal: fence: the deploy lock no longer holds this token';

/** `container.image-digest`: no container of that name exists. */
export const NO_SUCH_CONTAINER_EXIT = 1;

/** The prefix of the temporary file `file.write` creates beside its destination. */
export const WRITE_TEMPORARY_PREFIX = '.jamal-write.';

/** `lock.acquire`: the lock directory already exists. */
export const LOCK_CONTENDED_EXIT = 1;

/** `lock.acquire`: any other failure; a lock directory it created is gone again. */
export const LOCK_ACQUIRE_FAILED_EXIT = 3;

/** The file beside a lock directory that keeps the last sequence number handed out. */
export const LOCK_SEQ_FILE = 'lock.seq';

/** The owner document inside a lock directory. */
export const LOCK_OWNER_FILE = 'owner.json';

/** The token file inside a lock directory. */
export const LOCK_TOKEN_FILE = 'token';

/** `lock.release`: the lock is held under another token. */
export const LOCK_NOT_OWNER_EXIT = 4;

/** `lock.status`: the lock is not held. */
export const LOCK_NOT_HELD_EXIT = 1;

/** The exit statuses of `valkey.replace`. */
export interface ValkeyReplaceExitStatuses {
  /** The accessory could not be stopped; nothing was replaced. */
  readonly stopFailed: number;
  /** The swap failed; the accessory was started on its previous data. */
  readonly swapFailed: number;
  /** The data was replaced, but the accessory could not be started. */
  readonly startFailed: number;
  /** The swap failed, and the accessory could not be started either. */
  readonly nothingStarted: number;
}

/**
 * The statuses themselves, after the in-container backup scripts' own
 * (`BACKUP_EXIT` in `backup.ts`, 70 to 75) and below ssh's 255.
 */
export const BACKUP_EXIT_VALKEY: ValkeyReplaceExitStatuses = Object.freeze({
  stopFailed: 76,
  swapFailed: 77,
  startFailed: 78,
  nothingStarted: 79,
});

/**
 * The one remote write. `$1` is the destination, `$2` its mode, `$3` the mode
 * of its directory (empty: leave it), `$4` a lock directory (empty: no
 * fence), `$5` a precondition on the destination (empty: none; `absent`: it
 * must not exist; otherwise the SHA-256 hex its current bytes must have).
 * Stdin starts with the header line `<size> <sha256> [<token>]`; POSIX
 * `read` consumes only that line, so `cat` receives exactly the payload. The
 * digest and the token travel there rather than in the argv: the remote `ps`
 * shows every argv, a digest of a short secret is enough to recover it by
 * guessing, and the token is what the fence checks.
 *
 * Under `umask 077` the directories it creates are 0700 and the temporary
 * file 0600 from its first byte. The temporary file is unique (`mktemp`) in
 * the destination's own directory, so the final `mv` is a rename on one file
 * system, and an EXIT trap removes it on every path that does not rename it,
 * a hangup or termination included. It is checked against the header's size
 * and digest with whichever hasher the host has, then against the fence,
 * then against the precondition, then given its mode and flushed to disk
 * (`sync <file>`, or a global `sync` where `sync` takes no operand) before
 * the rename, and the directory is flushed after it, so a successful write
 * survives a power loss with the whole payload in place, and after any
 * failure the destination holds what it held before. Under the deploy lock
 * the precondition makes the rename a compare-and-replace: nothing else
 * writes the file between the check and the rename.
 */
const FILE_WRITE_SCRIPT = [
  'umask 077',
  `IFS=' ' read -r size sum token || exit ${WRITE_CHECKSUM_MISMATCH_EXIT}`,
  'digest() {',
  '  if command -v sha256sum >/dev/null 2>&1; then sha256sum',
  '  elif command -v shasum >/dev/null 2>&1; then shasum -a 256',
  '  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 -r',
  `  else return ${WRITE_NO_HASHER_EXIT}; fi`,
  '}',
  'd=$(dirname -- "$1")',
  `mkdir -p -- "$d" || exit ${WRITE_FAILED_EXIT}`,
  `[ -z "$3" ] || chmod "$3" "$d" || exit ${WRITE_FAILED_EXIT}`,
  `t=$(mktemp "$d/${WRITE_TEMPORARY_PREFIX}XXXXXX") || exit ${WRITE_FAILED_EXIT}`,
  `trap 'rm -f -- "$t"' EXIT`,
  `trap 'exit ${WRITE_FAILED_EXIT}' HUP INT TERM`,
  `cat > "$t" || exit ${WRITE_FAILED_EXIT}`,
  `h=$(digest < "$t") || exit ${WRITE_NO_HASHER_EXIT}`,
  'n=$(wc -c < "$t" | tr -d " ")',
  `[ "$n" = "$size" ] && [ "\${h%% *}" = "$sum" ] || exit ${WRITE_CHECKSUM_MISMATCH_EXIT}`,
  `[ -z "$4" ] || { [ -n "$token" ] && [ "$(cat -- "$4/${LOCK_TOKEN_FILE}" 2>/dev/null)" = "$token" ]; } || exit ${WRITE_LOCK_LOST_EXIT}`,
  'case $5 in',
  "  '') ;;",
  `  ${WRITE_EXPECT_ABSENT}) [ ! -e "$1" ] || exit ${WRITE_PRECONDITION_EXIT} ;;`,
  `  *) { [ -f "$1" ] && c=$(digest < "$1") && [ "\${c%% *}" = "$5" ]; } || exit ${WRITE_PRECONDITION_EXIT} ;;`,
  'esac',
  `chmod "$2" "$t" || exit ${WRITE_FAILED_EXIT}`,
  'sync -- "$t" 2>/dev/null || sync',
  `mv -f -- "$t" "$1" || exit ${WRITE_FAILED_EXIT}`,
  'sync -- "$d" 2>/dev/null || sync',
].join('\n');

/**
 * Take the lock: create the parent, then the lock directory itself, under
 * `umask 077` so the token is the ssh user's alone; only the second `mkdir`
 * may report contention. Holding the directory, read the last sequence
 * number from {@link LOCK_SEQ_FILE} beside it (absent: 0; anything but a
 * number without leading zeros is a failure), write the next one by rename,
 * then the token, then the owner document: `$2` is the rest of a JSON object
 * the client serialized, so the shell splices in only the number and never
 * parses or quotes a value. Any failure after the `mkdir` removes the
 * directory again, since a lock without this caller's token could never be
 * released by it.
 */
const LOCK_ACQUIRE_SCRIPT = [
  'umask 077',
  `mkdir -p -- "$(dirname -- "$1")" || exit ${LOCK_ACQUIRE_FAILED_EXIT}`,
  `mkdir -- "$1" 2>/dev/null || exit ${LOCK_CONTENDED_EXIT}`,
  `fail() { rm -f -- "$1/${LOCK_TOKEN_FILE}" "$1/${LOCK_OWNER_FILE}" "$1/.seq"; rmdir -- "$1"; exit ${LOCK_ACQUIRE_FAILED_EXIT}; }`,
  `f="$(dirname -- "$1")/${LOCK_SEQ_FILE}"`,
  'if [ -e "$f" ]; then n=$(cat -- "$f") || fail "$1"; else n=0; fi',
  'case $n in \'\' | 0?* | *[!0-9]*) fail "$1" ;; esac',
  'n=$((n + 1))',
  `{ printf '%s\\n' "$n" > "$1/.seq" && mv -f -- "$1/.seq" "$f"; } || fail "$1"`,
  `printf '%s\\n' "$3" > "$1/${LOCK_TOKEN_FILE}" || fail "$1"`,
  `printf '{"seq":%s,%s\\n' "$n" "$2" > "$1/${LOCK_OWNER_FILE}" || fail "$1"`,
  `printf '%s\\n' "$n"`,
].join('\n');

/** Remove the lock only while it still carries the caller's token (`$2`). */
const LOCK_RELEASE_SCRIPT =
  '[ -d "$1" ] || exit 0; ' +
  `[ "$(cat -- "$1/${LOCK_TOKEN_FILE}" 2>/dev/null)" = "$2" ] || exit ${LOCK_NOT_OWNER_EXIT}; ` +
  `rm -f -- "$1/${LOCK_OWNER_FILE}" "$1/${LOCK_TOKEN_FILE}" && rmdir -- "$1"`;

/** Remove the lock whoever holds it; a missing lock is not an error. */
const LOCK_FORCE_RELEASE_SCRIPT = `[ -d "$1" ] || exit 0; rm -f -- "$1/${LOCK_OWNER_FILE}" "$1/${LOCK_TOKEN_FILE}" && rmdir -- "$1"`;

/** Exit 0 and print the owner document when held, exit 1 when not held. */
const LOCK_STATUS_SCRIPT = `[ -d "$1" ] || exit ${LOCK_NOT_HELD_EXIT}; cat -- "$1/${LOCK_OWNER_FILE}" 2>/dev/null; exit 0`;

/**
 * Run the inner op only while the lock directory `$1` holds the token on the
 * first line of stdin. `read` consumes only that line, so the inner op reads
 * the rest of stdin as its own; `exec` hands it the process, so its exit
 * status and output are the command's. A lost lock prints the marker and
 * exits before anything else runs.
 */
const FENCED_SCRIPT = [
  'IFS= read -r t || t=',
  `{ [ -n "$t" ] && [ "$(cat -- "$1/${LOCK_TOKEN_FILE}" 2>/dev/null)" = "$t" ]; } || { printf '%s\\n' '${FENCE_LOST_MARKER}' >&2; exit ${FENCE_LOST_EXIT}; }`,
  'shift',
  'exec "$@"',
].join('\n');

/**
 * Print the files of an app's host state, each framed as `F <size> <path>`
 * on its own line followed by its bytes: `$1/state.json`, every
 * `$1/releases/<id>/manifest.json`, then each further parameter (the cache
 * proxy's VCL). A release whose secrets file exists is named as `E <path>`
 * without its bytes. A missing file prints nothing, so a host that never saw
 * the app prints nothing.
 */
const HOST_READ_STATE_SCRIPT = [
  'd=$1',
  'shift',
  'emit() {',
  '  [ -f "$1" ] || return 0',
  `  n=$(wc -c < "$1" | tr -d ' ') || exit 3`,
  `  printf 'F %s %s\\n' "$n" "$1"`,
  '  cat -- "$1" || exit 3',
  '}',
  'emit "$d/state.json"',
  'for f in "$d"/releases/*/manifest.json; do emit "$f"; done',
  `for f in "$d"/releases/*/secrets/secrets.json; do [ ! -f "$f" ] || printf 'E %s\\n' "$f"; done`,
  'for f in "$@"; do emit "$f"; done',
  'exit 0',
].join('\n');

/**
 * The repository digests (`["repo@sha256:…"]`) of the image the container
 * `$1` was created from, read through the image id so a tag that moved since
 * does not matter. Exits 1 when no such container exists.
 */
const CONTAINER_IMAGE_DIGEST_SCRIPT =
  `i=$(docker inspect --type container -f '{{.Image}}' "$1" 2>/dev/null) || exit ${NO_SUCH_CONTAINER_EXIT}; ` +
  `docker image inspect -f '{{json .RepoDigests}}' "$i"`;

/**
 * The directory every relative path jamal sends is resolved against: an ssh
 * session's remote command starts in the ssh user's home. `pwd -P` is POSIX
 * and prints it with symbolic links resolved, so a bind-mount source built
 * on it names the directory itself.
 */
const HOST_HOME_SCRIPT = 'pwd -P';

/**
 * Create the network when missing and connect each named container that
 * exists but is not on it yet. Every inspect is `--type container`: an
 * accessory is named after its service key (`mariadb`, `valkey`), and a plain
 * inspect would also match an image or volume of that name.
 */
const NETWORK_ENSURE_SCRIPT = [
  `docker network inspect ${JAMAL_NETWORK} >/dev/null 2>&1 || docker network create ${JAMAL_NETWORK} >/dev/null || exit 1`,
  'for c in "$@"; do',
  '  docker inspect --type container "$c" >/dev/null 2>&1 || continue',
  `  [ "$(docker inspect --type container -f '{{if index .NetworkSettings.Networks "${JAMAL_NETWORK}"}}yes{{end}}' "$c")" = yes ] && continue`,
  `  docker network connect ${JAMAL_NETWORK} "$c" || exit 1`,
  'done',
].join('\n');

/**
 * Remove a stopped leftover of the name first, and a container `docker run`
 * created but could not start after. Both removals are without `-f`: a
 * RUNNING container of that name may be serving traffic, so the run fails on
 * the name conflict rather than kill it.
 */
const CONTAINER_RUN_FRESH_SCRIPT =
  'n=$1; shift; docker rm "$n" >/dev/null 2>&1; "$@" && exit 0; ' +
  's=$?; docker rm "$n" >/dev/null 2>&1; exit $s';

/** Stop and remove a container when it exists; a missing one is not an error. */
const CONTAINER_RETIRE_SCRIPT =
  'docker inspect --type container "$1" >/dev/null 2>&1 || exit 0; ' +
  'docker stop "$1" >/dev/null && docker rm "$1" >/dev/null';

/**
 * A running Varnish on the configured image reloads in place
 * (`varnishreload`); a missing or stopped container, a changed image, or a
 * failed reload falls back to replacing the container.
 */
const CACHE_PROXY_LOAD_SCRIPT =
  'n=$1; img=$2; shift 2; ' +
  `state=$(docker inspect --type container -f '{{.State.Running}} {{.Config.Image}}' "$n" 2>/dev/null); ` +
  '[ "$state" = "true $img" ] && docker exec "$n" varnishreload >/dev/null && exit 0; ' +
  'docker rm -f "$n" >/dev/null 2>&1; exec "$@"';

/**
 * Stop the Valkey accessory, swap its files in a throwaway container, and
 * start it again, as one script on the host: `$1` is the container, `$2` the
 * volume mount, `$3` the image, `$4` the swap script. Run as one remote
 * command, the sequence finishes even when the ssh connection drops or the
 * operator interrupts jamal midway (no pty, so the host sends no hangup; a
 * broken pipe is ignored and docker's output goes to a file, not the closed
 * connection), so an interrupted restore never leaves the accessory stopped.
 * A failed swap still starts the accessory, on its previous data.
 */
const VALKEY_REPLACE_SCRIPT = [
  "trap '' HUP PIPE",
  'e=$(mktemp) || exit 1',
  'fail() { cat -- "$e" >&2; rm -f -- "$e"; exit "$1"; }',
  `docker stop -- "$1" >/dev/null 2>>"$e" || fail ${BACKUP_EXIT_VALKEY.stopFailed}`,
  's=0',
  'docker run --rm --network none -v "$2" --entrypoint sh "$3" -c "$4" >/dev/null 2>>"$e" || s=1',
  'if ! docker start -- "$1" >/dev/null 2>>"$e"; then',
  `  [ "$s" = 0 ] && fail ${BACKUP_EXIT_VALKEY.startFailed}`,
  `  fail ${BACKUP_EXIT_VALKEY.nothingStarted}`,
  'fi',
  `[ "$s" = 0 ] || fail ${BACKUP_EXIT_VALKEY.swapFailed}`,
  'rm -f -- "$e"',
].join('\n');

/** The largest permission mode a write sets: no setuid, setgid or sticky bit. */
const MAX_MODE = 0o777;

/** Whether `mode` is a permission mode {@link remoteOpArgv} can pass. */
export function isFileMode(mode: number): boolean {
  return Number.isInteger(mode) && mode >= 0 && mode <= MAX_MODE;
}

/** `mode` as the octal operand `chmod` takes. */
function octalMode(mode: number): string {
  return mode.toString(8).padStart(3, '0');
}

/** The mode an octal `chmod` operand names, or `undefined` when it is not one. */
function parseOctalMode(text: string): number | undefined {
  if (!/^[0-7]{3}$/.test(text)) return undefined;
  return Number.parseInt(text, 8);
}

/** A host script run as `sh -c <script> sh <parameters...>`. */
function hostScript(script: string, parameters: readonly string[]): readonly string[] {
  return ['sh', '-c', script, 'sh', ...parameters];
}

/** The argv that performs `op` on the server, for the ssh transport to quote. */
export function remoteOpArgv(op: RemoteOp): readonly string[] {
  switch (op.kind) {
    case 'file.write':
      return hostScript(FILE_WRITE_SCRIPT, [
        op.path,
        octalMode(op.mode),
        op.directoryMode === undefined ? '' : octalMode(op.directoryMode),
        op.lockDir ?? '',
        op.expect ?? '',
      ]);
    case 'lock.acquire':
      return hostScript(LOCK_ACQUIRE_SCRIPT, [op.dir, op.owner, op.token]);
    case 'lock.release':
      return hostScript(LOCK_RELEASE_SCRIPT, [op.dir, op.token]);
    case 'lock.force-release':
      return hostScript(LOCK_FORCE_RELEASE_SCRIPT, [op.dir]);
    case 'lock.status':
      return hostScript(LOCK_STATUS_SCRIPT, [op.dir]);
    case 'fenced':
      return hostScript(FENCED_SCRIPT, [op.lockDir, ...remoteOpArgv(op.op)]);
    case 'host.read-state':
      return hostScript(HOST_READ_STATE_SCRIPT, [op.dir, ...op.extra]);
    case 'container.image-digest':
      return hostScript(CONTAINER_IMAGE_DIGEST_SCRIPT, [op.name]);
    case 'host.home':
      return hostScript(HOST_HOME_SCRIPT, []);
    case 'network.ensure':
      return hostScript(NETWORK_ENSURE_SCRIPT, op.connect);
    case 'container.run-fresh':
      return hostScript(CONTAINER_RUN_FRESH_SCRIPT, [op.name, ...op.run]);
    case 'container.retire':
      return hostScript(CONTAINER_RETIRE_SCRIPT, [op.name]);
    case 'cache-proxy.load':
      return hostScript(CACHE_PROXY_LOAD_SCRIPT, [op.name, op.image, ...op.boot]);
    case 'valkey.replace':
      return hostScript(VALKEY_REPLACE_SCRIPT, [op.container, op.mount, op.image, op.swap]);
    case 'docker':
      return op.argv;
  }
}

/** Run `op` on `server` through the remote runner. */
export function runRemoteOp(
  remote: RemoteRunner,
  server: string,
  op: RemoteOp,
  options?: RemoteRunOptions,
): Promise<CommandResult> {
  return options === undefined
    ? remote.run(server, remoteOpArgv(op))
    : remote.run(server, remoteOpArgv(op), options);
}

/**
 * Read a host script's parameters back into its op, or `undefined` when they
 * do not have the shape {@link remoteOpArgv} gives that script.
 */
type ScriptDecoder = (parameters: readonly string[]) => RemoteOp | undefined;

/** Exactly `count` parameters, or `undefined`. */
function fixed(parameters: readonly string[], count: number): readonly string[] | undefined {
  return parameters.length === count ? parameters : undefined;
}

const SCRIPT_DECODERS: ReadonlyMap<string, ScriptDecoder> = new Map<string, ScriptDecoder>([
  [
    FILE_WRITE_SCRIPT,
    (p) => {
      const [path, mode, directoryMode, lockDir, expect] = fixed(p, 5) ?? [];
      if (path === undefined || mode === undefined || directoryMode === undefined) return undefined;
      const fileMode = parseOctalMode(mode);
      const dirMode = directoryMode === '' ? undefined : parseOctalMode(directoryMode);
      if (fileMode === undefined || (directoryMode !== '' && dirMode === undefined)) {
        return undefined;
      }
      if (expect !== '' && expect !== WRITE_EXPECT_ABSENT && !/^[0-9a-f]{64}$/.test(expect ?? '')) {
        return undefined;
      }
      return {
        kind: 'file.write',
        path,
        mode: fileMode,
        directoryMode: dirMode,
        lockDir: lockDir === '' ? undefined : lockDir,
        expect: expect === '' || expect === undefined ? undefined : expect,
      };
    },
  ],
  [
    LOCK_ACQUIRE_SCRIPT,
    (p) => {
      const [dir, owner, token] = fixed(p, 3) ?? [];
      return dir === undefined || owner === undefined || token === undefined
        ? undefined
        : { kind: 'lock.acquire', dir, owner, token };
    },
  ],
  [
    LOCK_RELEASE_SCRIPT,
    (p) => {
      const [dir, token] = fixed(p, 2) ?? [];
      return dir === undefined || token === undefined
        ? undefined
        : { kind: 'lock.release', dir, token };
    },
  ],
  [
    LOCK_FORCE_RELEASE_SCRIPT,
    (p) => {
      const [dir] = fixed(p, 1) ?? [];
      return dir === undefined ? undefined : { kind: 'lock.force-release', dir };
    },
  ],
  [
    LOCK_STATUS_SCRIPT,
    (p) => {
      const [dir] = fixed(p, 1) ?? [];
      return dir === undefined ? undefined : { kind: 'lock.status', dir };
    },
  ],
  [
    FENCED_SCRIPT,
    (p) => {
      const [lockDir, ...inner] = p;
      const op = lockDir === undefined ? undefined : decodeRemoteOp(inner);
      // A fence inside a fence is nothing remoteOpArgv is asked to produce.
      return lockDir === undefined || op === undefined || op.kind === 'fenced'
        ? undefined
        : { kind: 'fenced', lockDir, op };
    },
  ],
  [
    HOST_READ_STATE_SCRIPT,
    (p) => {
      const [dir, ...extra] = p;
      return dir === undefined ? undefined : { kind: 'host.read-state', dir, extra };
    },
  ],
  [
    CONTAINER_IMAGE_DIGEST_SCRIPT,
    (p) => {
      const [name] = fixed(p, 1) ?? [];
      return name === undefined ? undefined : { kind: 'container.image-digest', name };
    },
  ],
  [HOST_HOME_SCRIPT, (p) => (p.length === 0 ? { kind: 'host.home' } : undefined)],
  [NETWORK_ENSURE_SCRIPT, (p) => ({ kind: 'network.ensure', connect: [...p] })],
  [
    CONTAINER_RUN_FRESH_SCRIPT,
    (p) => {
      const [name, ...run] = p;
      return name === undefined || run[0] !== 'docker'
        ? undefined
        : { kind: 'container.run-fresh', name, run };
    },
  ],
  [
    CONTAINER_RETIRE_SCRIPT,
    (p) => {
      const [name] = fixed(p, 1) ?? [];
      return name === undefined ? undefined : { kind: 'container.retire', name };
    },
  ],
  [
    CACHE_PROXY_LOAD_SCRIPT,
    (p) => {
      const [name, image, ...boot] = p;
      return name === undefined || image === undefined || boot[0] !== 'docker'
        ? undefined
        : { kind: 'cache-proxy.load', name, image, boot };
    },
  ],
  [
    VALKEY_REPLACE_SCRIPT,
    (p) => {
      const [container, mount, image, swap] = fixed(p, 4) ?? [];
      return container === undefined ||
        mount === undefined ||
        image === undefined ||
        swap === undefined
        ? undefined
        : { kind: 'valkey.replace', container, mount, image, swap };
    },
  ],
]);

/**
 * The op `argv` performs, or `undefined` when it is neither a host script
 * {@link remoteOpArgv} produces nor a `docker` command.
 */
export function decodeRemoteOp(argv: readonly string[]): RemoteOp | undefined {
  if (argv[0] === 'docker') {
    return { kind: 'docker', argv: [...argv] };
  }
  const [shell, flag, script, name, ...parameters] = argv;
  if (shell !== 'sh' || flag !== '-c' || script === undefined || name !== 'sh') {
    return undefined;
  }
  return SCRIPT_DECODERS.get(script)?.(parameters);
}
