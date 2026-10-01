/**
 * Where jamal keeps its state on a production server, and the names it gives
 * the containers and shared Docker resources there.
 *
 * Every path is relative to the ssh user's home directory: an ssh session's
 * remote command starts there, so a host script and the Docker CLI's own
 * file reads (`--env-file`, which every CLI version resolves against its
 * working directory) find a relative path without assuming the deploy user
 * is `root` and without any shell expansion (the transport quotes every
 * argument). A bind-mount source is different: the daemon, not the CLI,
 * reads it, and a CLI before Docker 23 hands a relative source to the daemon
 * as a volume name, which it refuses. Every source jamal mounts is therefore
 * {@link absoluteHostPath}: the home as the server reports it
 * (`host-home.ts`), joined with the relative path.
 *
 * The unit of state is the app: a service plus its optional destination
 * ({@link appName}, `<service>` or `<service>.<destination>`; neither part
 * may contain a `.`, so the name is unambiguous). Each app has its own lock,
 * its own `state.json`, and its own releases:
 *
 * ```
 * .jamal/                                  0700 (created by the first write)
 *   apps/<app>/
 *     lock/                                the deploy lock (`lock.ts`)
 *       token                              0600
 *       owner.json                         0600, {seq, who, host, since, for?}
 *     lock.seq                             the last lock sequence number
 *     state.json                           0600, live and previous (`host-state.ts`)
 *     releases/<release id>/               0700, the ssh user's
 *       manifest.json                      0444, written once (`manifest.ts`)
 *       secrets/                           0755, mounted read-only into the release
 *         secrets.json                     0444
 *     accessories/<name>.env               0600
 *   cache-proxy/                           0755, mounted read-only into Varnish
 *     default.vcl                          0644
 * ```
 *
 * The `apps/` level keeps every app apart from the server-wide entries
 * (`cache-proxy/`), which a service of the same name would otherwise share.
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

/** The labels every app container carries, so `observe` can find the app's containers. */
export const APP_LABELS: {
  readonly service: 'jsails.service';
  /** The destination, or the empty string for an app without one. */
  readonly destination: 'jsails.destination';
  readonly role: 'jsails.role';
  readonly release: 'jsails.release';
} = Object.freeze({
  service: 'jsails.service',
  destination: 'jsails.destination',
  role: 'jsails.role',
  release: 'jsails.release',
} as const);

/** The role of the container kamal-proxy routes to; every release runs one. */
export const WEB_ROLE = 'web';

/**
 * `relative` (a path below the ssh user's home) as an absolute path under
 * `home`, the absolute home directory the server reported.
 */
export function absoluteHostPath(home: string, relative: string): string {
  return home === '/' ? `/${relative}` : `${home}/${relative}`;
}

/** The app a service and destination name: `<service>` or `<service>.<destination>`. */
export function appName(service: string, destination: string | undefined): string {
  return destination === undefined ? service : `${service}.${destination}`;
}

/** The app's directory. */
export function hostAppDir(service: string, destination: string | undefined): string {
  return `${HOST_JAMAL_DIR}/apps/${appName(service, destination)}`;
}

/** The app's deploy lock directory. */
export function hostLockDir(service: string, destination: string | undefined): string {
  return `${hostAppDir(service, destination)}/lock`;
}

/** The app's `state.json`. */
export function hostStateFile(service: string, destination: string | undefined): string {
  return `${hostAppDir(service, destination)}/state.json`;
}

/** The directory holding the app's releases. */
export function hostReleasesDir(service: string, destination: string | undefined): string {
  return `${hostAppDir(service, destination)}/releases`;
}

/** One release's directory. */
export function hostReleaseDir(
  service: string,
  destination: string | undefined,
  release: string,
): string {
  return `${hostReleasesDir(service, destination)}/${release}`;
}

/** One release's immutable manifest. */
export function hostManifestFile(
  service: string,
  destination: string | undefined,
  release: string,
): string {
  return `${hostReleaseDir(service, destination, release)}/manifest.json`;
}

/** The directory a release's container mounts its secrets from. */
export function hostSecretsDir(
  service: string,
  destination: string | undefined,
  release: string,
): string {
  return `${hostReleaseDir(service, destination, release)}/secrets`;
}

/** The file `name` in a release's secrets directory. */
export function hostSecretsFilePath(
  service: string,
  destination: string | undefined,
  release: string,
  name: string,
): string {
  return `${hostSecretsDir(service, destination, release)}/${name}`;
}

/**
 * The container a release runs a role in: `<app>-<role>-<release id>`. A
 * release id is new to every deploy, so a redeploy of the live commit never
 * shares a name with the container that serves.
 */
export function appContainerName(
  service: string,
  destination: string | undefined,
  role: string,
  release: string,
): string {
  return `${appName(service, destination)}-${role}-${release}`;
}

/**
 * The directory the cache proxy mounts its VCL from: one per server, like the
 * cache-proxy container itself.
 */
export const HOST_CACHE_PROXY_DIR: string = `${HOST_JAMAL_DIR}/cache-proxy`;

/** The env file one accessory reads its credentials from. */
export function accessoryEnvFilePath(
  service: string,
  destination: string | undefined,
  accessory: string,
): string {
  return `${hostAppDir(service, destination)}/accessories/${accessory}.env`;
}
