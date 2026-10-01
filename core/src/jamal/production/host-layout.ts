/**
 * Where jamal keeps its state on a production server, and the names it gives
 * the shared Docker resources there.
 *
 * Every path is relative to the ssh user's home directory: an ssh session's
 * remote command starts in `$HOME`, and the Docker CLI resolves a relative
 * `--env-file` against its working directory, so one relative path works for
 * the write and the read without assuming the deploy user is `root` and
 * without any shell expansion (the transport quotes every argument).
 */

/** The per-user jamal directory on the server, relative to the ssh user's home. */
export const HOST_JAMAL_DIR = '.jamal';

/**
 * The user-defined Docker network every production container joins. Docker's
 * default bridge has no name resolution, so the proxy, the cache proxy, the
 * accessories, and the app reach each other by container name only on a
 * network like this one.
 */
export const JAMAL_NETWORK = 'jamal';

/** The label every app container carries, so jamal can find a service's containers. */
export const SERVICE_LABEL = 'jamal.service';

/**
 * The per-app directory, mirroring Kamal's `.kamal/apps/<service>-<destination>`.
 * The destination segment is omitted when no destination is set.
 */
export function hostAppDir(service: string, destination: string | undefined): string {
  const app = destination === undefined ? service : `${service}-${destination}`;
  return `${HOST_JAMAL_DIR}/apps/${app}`;
}

/** The app's secret env file. */
export function hostEnvFilePath(service: string, destination: string | undefined): string {
  return `${hostAppDir(service, destination)}/env`;
}

/** The env file one accessory reads its credentials from. */
export function accessoryEnvFilePath(
  service: string,
  destination: string | undefined,
  accessory: string,
): string {
  return `${hostAppDir(service, destination)}/accessories/${accessory}.env`;
}

/** The deploy lock directory for a service. */
export function hostLockDir(service: string): string {
  return `${HOST_JAMAL_DIR}/locks/${service}.deploy.lock`;
}
