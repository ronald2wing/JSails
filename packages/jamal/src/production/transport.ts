/**
 * SSH transport for jamal production deploys.
 *
 * Remote steps (`pull`, `run`, `health`, `stop`, `rollback`) execute on the
 * target server through `ssh`. {@link sshArgv} assembles the local argv —
 * `ssh -o BatchMode=yes <server> <command line>` by default — and
 * {@link createRemoteRunner} wraps an injected {@link ProcessRunner} so a
 * remote command runs through the same process seam as local build/push, with
 * a bounded timeout.
 *
 * OpenSSH does not pass an argv to the server: it joins every trailing
 * argument with spaces and the remote login shell parses that string again.
 * So the remote argv is never handed to `ssh` as separate arguments;
 * {@link remoteCommandLine} POSIX-quotes each element and `ssh` receives the
 * one resulting string, which the remote shell splits back into exactly the
 * original elements. A space, `$`, `;`, `&`, backtick, or quote in a config
 * value therefore stays data on the server.
 *
 * No key material is ever read in JS: authentication, the SSH agent, and
 * host-key verification (`known_hosts`) are all delegated to the system `ssh`
 * client. Batch mode is on by default so a missing or unusable key fails the
 * command instead of blocking on an interactive password prompt.
 */

import { JsailsError, CONTROL_CHARS } from 'jsails/support';
import type { JamalSshConfig } from '../config/index.js';
import type { CommandOptions, CommandResult, ProcessRunner } from './process-runner.js';

/** A permissive subset of {@link JamalSshConfig} for {@link sshArgv}. */
type SshArgvSshConfig = Partial<JamalSshConfig> & {
  readonly keys?: readonly string[];
};

/** The remote runner's default timeout: a `docker pull` over ssh can be slow. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 300_000;

/** Why an ssh target or remote command was refused. */
export type TransportErrorCode = 'invalid_server' | 'invalid_command';

/** Raised when a server name or remote command fails validation. Value-free. */
export class TransportError extends JsailsError {
  constructor(
    message: string,
    readonly code: TransportErrorCode = 'invalid_server',
  ) {
    super(message);
  }
}

/** Characters a POSIX shell never treats specially in an unquoted word. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote one argv element for a POSIX shell. A word made only of characters the
 * shell never interprets is returned as is, so ordinary commands stay
 * readable; anything else is wrapped in single quotes, with each embedded
 * single quote written as `'\''`. Single quotes disable every expansion, so
 * the shell yields the element byte for byte.
 */
export function shellQuote(token: string): string {
  if (SHELL_SAFE.test(token)) {
    return token;
  }
  return `'${token.replaceAll("'", "'\\''")}'`;
}

/**
 * The one command-line string a remote login shell parses back into exactly
 * `remoteArgv`. This is what `ssh` sends to the server.
 */
export function remoteCommandLine(remoteArgv: readonly string[]): string {
  if (remoteArgv.length === 0) {
    throw new TransportError('a remote command must not be empty', 'invalid_command');
  }
  return remoteArgv.map((token) => shellQuote(token)).join(' ');
}

/**
 * The connection options every non-interactive remote command carries: a
 * bounded connect, and keep-alives so a dead link fails within about a minute
 * instead of hanging until the step timeout.
 */
const KEEPALIVE_OPTIONS: readonly string[] = [
  '-o',
  'ConnectTimeout=15',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=4',
];

/** Options for {@link sshArgv}. */
interface SshArgvOptions {
  /**
   * Emit `-o BatchMode=yes` (default `true`) so `ssh` never blocks on a
   * password prompt; a missing key fails the command instead.
   */
  readonly batchMode?: boolean;
  /** Emit {@link KEEPALIVE_OPTIONS} (default `false`; the remote runner sets it). */
  readonly keepAlive?: boolean;
  readonly ssh?: SshArgvSshConfig;
}

/**
 * Assemble the local `ssh` argv for one remote command. The server is
 * validated (non-empty, no whitespace or control characters, no leading `-`),
 * so a hostile or accidental value can never become an `ssh` option. A
 * non-empty remote argv becomes one trailing argument, the quoted
 * {@link remoteCommandLine}, so the remote shell reproduces it exactly; an
 * empty one opens an interactive session.
 */
export function sshArgv(
  server: string,
  remoteArgv: readonly string[],
  options: SshArgvOptions = {},
): readonly string[] {
  assertServer(server);
  const ssh = options.ssh;
  const batchMode = options.batchMode ?? true;
  const result: string[] = ['ssh'];

  if (batchMode) {
    result.push('-o', 'BatchMode=yes');
  }

  if (options.keepAlive === true) {
    result.push(...KEEPALIVE_OPTIONS);
  }

  if (ssh?.port !== undefined) {
    result.push('-p', String(ssh.port));
  }

  if (ssh?.keys !== undefined) {
    for (const key of ssh.keys) {
      result.push('-i', key);
    }
  }

  if (ssh?.config !== undefined) {
    result.push('-F', ssh.config);
  }

  if (ssh?.forwardAgent) {
    result.push('-o', 'ForwardAgent=yes');
  }

  if (ssh?.proxyCommand !== undefined) {
    result.push('-o', `ProxyCommand=${ssh.proxyCommand}`);
  }

  if (ssh?.logLevel !== undefined) {
    result.push('-o', `LogLevel=${ssh.logLevel}`);
  }

  if (ssh?.keysOnly) {
    result.push('-o', 'IdentitiesOnly=yes');
  }

  const target = ssh?.user !== undefined ? `${ssh.user}@${server}` : server;
  result.push(target);
  if (remoteArgv.length > 0) {
    result.push(remoteCommandLine(remoteArgv));
  }
  return result;
}

/** Reject a server that cannot be a safe ssh target, value-free. */
function assertServer(server: string): void {
  if (typeof server !== 'string' || server.length === 0) {
    throw new TransportError('the ssh server must be a non-empty string');
  }
  if (/\s/.test(server) || CONTROL_CHARS.test(server)) {
    throw new TransportError('the ssh server must not contain whitespace or control characters');
  }
  if (server.startsWith('-')) {
    throw new TransportError('the ssh server must not start with "-"');
  }
}

/** Per-call options for {@link RemoteRunner.run}. */
export interface RemoteRunOptions {
  /**
   * Written to the remote command's standard input, which lets a caller send a
   * payload (an env file) without placing it in the argv where `ps` shows it.
   */
  readonly stdin?: string;
  /**
   * Forward the command's output to this process's stdout/stderr as it
   * arrives instead of capturing it (`docker logs --follow`, a long pull).
   */
  readonly stream?: boolean;
  /**
   * Override the runner's timeout for this call; `null` disables it (a
   * followed log runs until the operator interrupts it).
   */
  readonly timeoutMs?: number | null;
}

/** A remote runner: execute a fixed argv array on a server over ssh. */
export interface RemoteRunner {
  /**
   * Run `remoteArgv` on `server`. The third argument is either the stdin
   * payload (the original form) or a {@link RemoteRunOptions}.
   */
  run(
    server: string,
    remoteArgv: readonly string[],
    options?: string | RemoteRunOptions,
  ): Promise<CommandResult>;
}

/** Options for {@link createRemoteRunner}. */
interface RemoteRunnerOptions {
  /** The underlying process runner (injected so tests never spawn ssh). */
  readonly processRunner: ProcessRunner;
  /** Per-command timeout; defaults to {@link DEFAULT_REMOTE_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** SSH config carried into {@link sshArgv}. */
  readonly ssh?: JamalSshConfig;
}

/**
 * Build a remote runner over an injected {@link ProcessRunner}. Every `run`
 * validates the server, assembles the `ssh` argv, and runs it with the
 * configured timeout. Non-zero exits resolve as a {@link CommandResult} (the
 * caller decides), while validation failures, spawn failures, and timeouts
 * reject.
 */
export function createRemoteRunner(options: RemoteRunnerOptions): RemoteRunner {
  const { processRunner, timeoutMs = DEFAULT_REMOTE_TIMEOUT_MS, ssh } = options;
  return {
    async run(server, remoteArgv, runOptions) {
      const call: RemoteRunOptions =
        typeof runOptions === 'string' ? { stdin: runOptions } : (runOptions ?? {});
      const effectiveTimeout = call.timeoutMs === undefined ? timeoutMs : call.timeoutMs;
      const commandOptions: CommandOptions = {
        ...(effectiveTimeout === null ? {} : { timeoutMs: effectiveTimeout }),
        ...(call.stdin === undefined ? {} : { stdin: call.stdin }),
        ...(call.stream === true ? { stream: true } : {}),
      };
      return processRunner(sshArgv(server, remoteArgv, { ssh, keepAlive: true }), commandOptions);
    },
  };
}
