/**
 * The ssh user's home directory on a production server, as the absolute path
 * jamal builds its bind-mount sources on.
 *
 * Every host path jamal writes is relative to the home (`host-layout.ts`),
 * which works for a host script and for a file the Docker CLI reads itself.
 * A `-v` source is read by the daemon instead, and only Docker 23 and later
 * CLIs turn a `./` source into an absolute path first: an older CLI passes
 * it on as a named-volume name, which the daemon refuses. So a release's
 * secrets directory, the cache proxy's VCL directory, and a config volume
 * under the home are mounted by absolute path, built on what
 * {@link readHostHome} reads from the server (`pwd -P` in the ssh session,
 * the `host.home` op), and jamal assumes nothing about which user it deploys
 * as or where that user's home is.
 *
 * The path becomes the start of a `-v <source>:<target>[:<options>]` value,
 * so a home that is not absolute, holds a control character, or holds a `:`
 * (which would split the value) is refused, value-free.
 */

import { CONTROL_CHARS } from 'jsails/support';
import { defineErrors, type ErrorRegistry } from 'jsails/errors';

import { runRemoteOp } from './remote-op.js';
import type { RemoteRunner } from './transport.js';

const HOST_HOME_ERRORS = {
  read_failed: {
    kind: 'unavailable',
    message: "reading the ssh user's home directory on the server exited with code {exitCode}",
    context: { exitCode: 'count' },
    suggestion: 'check the ssh connection to the server and run the verb again',
  },
  unusable_home: {
    kind: 'invalid',
    message:
      'the ssh user\'s home directory on the server must be one absolute path with no control character and no ":", which a Docker bind mount needs',
    suggestion:
      'deploy as a user whose home path has no ":", and whose shell startup files print nothing in a non-interactive ssh session',
  },
} as const;

/**
 * `jamal_host_home.*`: the server's home directory could not be read, or
 * cannot be mounted from.
 */
export const HostHomeErrors: ErrorRegistry<'jamal_host_home', typeof HOST_HOME_ERRORS> =
  defineErrors('jamal_host_home', HOST_HOME_ERRORS);

/**
 * `home` when it can start a bind-mount source: absolute, free of control
 * characters (a newline included, so it is one line), and free of `:`.
 * Throws `jamal_host_home.unusable_home` otherwise.
 */
export function assertHostHome(home: string): string {
  if (!home.startsWith('/') || CONTROL_CHARS.test(home) || home.includes(':')) {
    throw new HostHomeErrors.Error('unusable_home');
  }
  return home;
}

/**
 * Read the ssh user's home directory on `server`: the absolute directory an
 * ssh session starts in, with symbolic links resolved. Throws
 * `jamal_host_home.read_failed` on a non-zero exit, and `unusable_home` when
 * the output is not exactly one usable path (a shell startup file that
 * prints a banner adds lines to it).
 */
export async function readHostHome(remote: RemoteRunner, server: string): Promise<string> {
  const result = await runRemoteOp(remote, server, { kind: 'host.home' });
  if (result.exitCode !== 0) {
    throw new HostHomeErrors.Error('read_failed', { exitCode: result.exitCode });
  }
  const output = result.stdout;
  return assertHostHome(output.endsWith('\n') ? output.slice(0, -1) : output);
}
