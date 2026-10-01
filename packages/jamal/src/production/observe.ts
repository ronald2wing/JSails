/**
 * Read what an app's production server actually holds: {@link observe}.
 *
 * Four read-only commands, whatever the run holds:
 *
 * 1. `host.read-state` (`remote-op.ts`): `state.json`, every release's
 *    `manifest.json`, which releases still have a secrets file (named, never
 *    read), and, behind the cache proxy, its VCL.
 * 2. `docker ps -a` filtered by the `jsails.service` label, printed one JSON
 *    object per line by {@link APP_CONTAINERS_FORMAT} (the destination label
 *    is compared here, since an app without a destination carries an empty
 *    one).
 * 3. `kamal-proxy list`, when jamal routes the app (a production domain or an
 *    on-demand TLS URL).
 * 4. `container.image-digest` of kamal-proxy: the pinned image a release is
 *    served through.
 *
 * The result is plain data. Which container serves web traffic
 * ({@link WebTruth}) is the proxy's target, or behind the cache proxy the
 * backend its VCL names (kamal-proxy then always targets Varnish, and the
 * VCL is what changes at a cut-over); an app jamal does not route has no
 * such truth and `state.json` is its only record. A kamal-proxy that is
 * stopped or missing is reported as such (`proxy-down`), apart from a proxy
 * that routes nothing of the app: the first says nothing about which
 * release serves, the second says none does. A manifest or
 * `state.json` that does not parse is reported as unreadable with the
 * SHA-256 of its bytes, so a repair can replace exactly those bytes. Every
 * failure is a value-free `jamal_observe.*` error.
 */

import { Writable } from 'node:stream';

import { defineErrors, type ErrorRegistry } from 'jsails/errors';

import type { JamalConfig } from '../config/index.js';
import { isPlainObject, isStringArray } from '../object-shape.js';
import {
  CACHE_PROXY_CONTAINER_NAME,
  CACHE_PROXY_HOST_VCL_FILE,
  vclBackendHost,
} from './cache-proxy.js';
import {
  APP_LABELS,
  hostAppDir,
  hostManifestFile,
  hostSecretsFilePath,
  hostStateFile,
} from './host-layout.js';
import { parseHostState, type HostState } from './host-state.js';
import { imageRepository, pinnedRepoDigest } from './image-ref.js';
import { parseManifest, type ReleaseManifest } from './manifest.js';
import { proxyListArgv, PROXY_CONTAINER_NAME } from './proxy.js';
import { isReleaseId } from './release-id.js';
import { NO_SUCH_CONTAINER_EXIT, runRemoteOp, type RemoteOp } from './remote-op.js';
import { sha256Hex } from './remote-file.js';
import type { RemoteRunner } from './transport.js';

const OBSERVE_ERRORS = {
  unreachable: {
    kind: 'unavailable',
    message: 'the server could not be reached over ssh',
  },
  read_failed: {
    kind: 'unavailable',
    message: 'the {what} could not be read from the server (exit code {exitCode})',
    context: {
      what: ['host state', 'app containers', 'proxy routes', 'proxy image'],
      exitCode: 'count',
    },
    suggestion: 'check the ssh connection, Docker, and the permissions of ~/.jamal on the server',
  },
  unreadable_output: {
    kind: 'invalid',
    message: 'the server answered the {what} query with output jamal does not understand',
    context: { what: ['host state', 'app containers', 'proxy routes', 'proxy image'] },
  },
} as const;

/** `jamal_observe.*`: the server could not be read. */
export const ObserveErrors: ErrorRegistry<'jamal_observe', typeof OBSERVE_ERRORS> = defineErrors(
  'jamal_observe',
  OBSERVE_ERRORS,
);

/**
 * The `docker ps --format` template: one JSON object per container, the
 * labels read with `.Label` so a label value is never split on a comma.
 */
export const APP_CONTAINERS_FORMAT: string =
  '{"name":{{json .Names}},"state":{{json .State}},"image":{{json .Image}},' +
  `"release":{{json (.Label "${APP_LABELS.release}")}},` +
  `"role":{{json (.Label "${APP_LABELS.role}")}},` +
  `"destination":{{json (.Label "${APP_LABELS.destination}")}}}`;

/** One container of the app, as `docker ps` reports it. */
export interface ObservedContainer {
  readonly name: string;
  /** Docker's state: `running`, `exited`, `created`, `restarting`, `paused`, `dead`. */
  readonly state: string;
  readonly image: string;
  /** The `jsails.release` label. */
  readonly release: string;
  /** The `jsails.role` label. */
  readonly role: string;
}

/** `state.json` as observed. */
export type ObservedHostState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly state: HostState; readonly sha256: string }
  | { readonly kind: 'unreadable'; readonly sha256: string };

/** Which container serves the app's web traffic, as the proxy says. */
export type WebTruth =
  /** jamal does not route the app; `state.json` is its only record. */
  | { readonly kind: 'unrouted' }
  /** jamal routes the app, and kamal-proxy routes nothing of it. */
  | { readonly kind: 'none' }
  /**
   * jamal routes the app, but kamal-proxy is not running (stopped, or no
   * container at all), so which container it would route to cannot be read.
   */
  | { readonly kind: 'proxy-down' }
  /** The container web traffic reaches. */
  | { readonly kind: 'container'; readonly container: string };

/** The pinned image kamal-proxy runs, as observed. */
export type ObservedProxyImage =
  | { readonly kind: 'none' }
  | { readonly kind: 'pinned'; readonly image: string }
  /** It runs an image no registry digest names (built or tagged locally). */
  | { readonly kind: 'unpinned' };

/** Everything {@link observe} read. */
export interface ObservedState {
  readonly hostState: ObservedHostState;
  /** Every readable manifest, by release id. */
  readonly manifests: ReadonlyMap<string, ReleaseManifest>;
  /** The release ids whose manifest exists but does not parse. */
  readonly unreadableManifests: readonly string[];
  /** The release ids whose secrets file exists. */
  readonly secrets: ReadonlySet<string>;
  /** The app's containers, sorted by name. */
  readonly containers: readonly ObservedContainer[];
  readonly web: WebTruth;
  readonly proxyImage: ObservedProxyImage;
}

/** ssh's own exit status for a connection or authentication failure. */
const SSH_FAILURE_EXIT = 255;

/** What `docker exec` says when the proxy container is missing or stopped. */
const PROXY_DOWN = /no such container|is not running/i;

/** Whether jamal routes the app through kamal-proxy. */
export function isRouted(config: JamalConfig): boolean {
  const production = config.production;
  return production?.domain !== undefined || production?.onDemandTlsUrl !== undefined;
}

/** The files a `host.read-state` dump carried. */
interface StateDump {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly secrets: ReadonlySet<string>;
}

/** Read the framed `host.read-state` output, or `undefined` when it is malformed. */
export function parseStateDump(output: Buffer): StateDump | undefined {
  const files = new Map<string, Buffer>();
  const secrets = new Set<string>();
  let at = 0;
  while (at < output.length) {
    const newline = output.indexOf(0x0a, at);
    if (newline === -1) return undefined;
    const line = output.subarray(at, newline).toString('utf8');
    at = newline + 1;
    if (line.startsWith('E ')) {
      secrets.add(line.slice(2));
      continue;
    }
    const match = /^F (\d+) (.+)$/.exec(line);
    if (match === null) return undefined;
    const size = Number(match[1]);
    if (!Number.isSafeInteger(size) || at + size > output.length) return undefined;
    files.set(match[2]!, output.subarray(at, at + size));
    at += size;
  }
  return { files, secrets };
}

/** One `docker ps` line, or `undefined` when it is not the template's object. */
function parseContainerLine(
  line: string,
): (ObservedContainer & { destination: string }) | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const { name, state, image, release, role, destination } = parsed;
  if (
    typeof name !== 'string' ||
    typeof state !== 'string' ||
    typeof image !== 'string' ||
    typeof release !== 'string' ||
    typeof role !== 'string' ||
    typeof destination !== 'string'
  ) {
    return undefined;
  }
  return { name, state, image, release, role, destination };
}

/**
 * The target container kamal-proxy routes `service` to, from `kamal-proxy
 * list`: the row whose first column is the service, and in it the column
 * that is a `<container>:<port>` target. `undefined` when no row routes it.
 */
export function proxyTargetContainer(listing: string, service: string): string | undefined {
  for (const line of listing.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== service) continue;
    for (const column of columns.slice(1)) {
      const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*):\d+$/.exec(column);
      if (match !== null) return match[1];
    }
  }
  return undefined;
}

/** The release id of a file path under `releases/<id>/`, or `undefined`. */
function releaseOfPath(path: string, releasesPrefix: string, suffix: string): string | undefined {
  if (!path.startsWith(releasesPrefix) || !path.endsWith(suffix)) return undefined;
  const id = path.slice(releasesPrefix.length, path.length - suffix.length);
  return isReleaseId(id) ? id : undefined;
}

/** Fail on an ssh failure, then on any other non-zero exit, value-free. */
function checkRead(
  exitCode: number,
  what: 'host state' | 'app containers' | 'proxy routes' | 'proxy image',
): void {
  if (exitCode === SSH_FAILURE_EXIT) throw new ObserveErrors.Error('unreachable');
  if (exitCode !== 0) throw new ObserveErrors.Error('read_failed', { what, exitCode });
}

/** What a server that never saw the app holds. */
export function emptyObservation(): ObservedState {
  return {
    hostState: { kind: 'absent' },
    manifests: new Map(),
    unreadableManifests: [],
    secrets: new Set(),
    containers: [],
    web: { kind: 'unrouted' },
    proxyImage: { kind: 'none' },
  };
}

/** Read the app's host state from the server. */
export async function observe(
  remote: RemoteRunner,
  server: string,
  config: JamalConfig,
): Promise<ObservedState> {
  const service = config.service;
  const destination = config.production?.destination;
  const cacheProxy = config.cacheProxy?.enabled === true;

  const dump = await readBytes(remote, server, {
    kind: 'host.read-state',
    dir: hostAppDir(service, destination),
    extra: cacheProxy ? [CACHE_PROXY_HOST_VCL_FILE] : [],
  });
  checkRead(dump.exitCode, 'host state');
  const parsedDump = parseStateDump(dump.stdout);
  if (parsedDump === undefined) {
    throw new ObserveErrors.Error('unreadable_output', { what: 'host state' });
  }

  const stateBytes = parsedDump.files.get(hostStateFile(service, destination));
  let hostState: ObservedHostState = { kind: 'absent' };
  if (stateBytes !== undefined) {
    try {
      hostState = {
        kind: 'present',
        state: parseHostState(stateBytes),
        sha256: sha256Hex(stateBytes),
      };
    } catch {
      hostState = { kind: 'unreadable', sha256: sha256Hex(stateBytes) };
    }
  }

  const releasesPrefix = `${hostAppDir(service, destination)}/releases/`;
  const manifests = new Map<string, ReleaseManifest>();
  const unreadableManifests: string[] = [];
  for (const [path, bytes] of parsedDump.files) {
    const id = releaseOfPath(path, releasesPrefix, '/manifest.json');
    if (id === undefined || path !== hostManifestFile(service, destination, id)) continue;
    const manifest = readManifest(bytes);
    if (manifest?.releaseId === id) manifests.set(id, manifest);
    else unreadableManifests.push(id);
  }
  const secrets = new Set<string>();
  for (const path of parsedDump.secrets) {
    const id = releaseOfPath(path, releasesPrefix, '/secrets/secrets.json');
    if (
      id !== undefined &&
      path === hostSecretsFilePath(service, destination, id, 'secrets.json')
    ) {
      secrets.add(id);
    }
  }

  const listed = await remote.run(server, [
    'docker',
    'ps',
    '-a',
    '--no-trunc',
    '--filter',
    `label=${APP_LABELS.service}=${service}`,
    '--format',
    APP_CONTAINERS_FORMAT,
  ]);
  checkRead(listed.exitCode, 'app containers');
  const containers: ObservedContainer[] = [];
  for (const line of listed.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const container = parseContainerLine(line);
    if (container === undefined) {
      throw new ObserveErrors.Error('unreadable_output', { what: 'app containers' });
    }
    if (container.destination !== (destination ?? '')) continue;
    containers.push({
      name: container.name,
      state: container.state,
      image: container.image,
      release: container.release,
      role: container.role,
    });
  }
  containers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  let web: WebTruth = { kind: 'unrouted' };
  if (isRouted(config)) {
    const routes = await remote.run(server, proxyListArgv());
    if (routes.exitCode === SSH_FAILURE_EXIT) throw new ObserveErrors.Error('unreachable');
    if (routes.exitCode === 0) {
      const target = proxyTargetContainer(routes.stdout, service);
      const backend =
        target === CACHE_PROXY_CONTAINER_NAME && cacheProxy
          ? vclBackendHost(parsedDump.files.get(CACHE_PROXY_HOST_VCL_FILE)?.toString('utf8') ?? '')
          : target;
      web = backend === undefined ? { kind: 'none' } : { kind: 'container', container: backend };
    } else if (PROXY_DOWN.test(routes.stderr)) {
      web = { kind: 'proxy-down' };
    } else {
      throw new ObserveErrors.Error('read_failed', {
        what: 'proxy routes',
        exitCode: routes.exitCode,
      });
    }
  }

  const digests = await runRemoteOp(remote, server, {
    kind: 'container.image-digest',
    name: PROXY_CONTAINER_NAME,
  });
  let proxyImage: ObservedProxyImage = { kind: 'none' };
  if (digests.exitCode !== NO_SUCH_CONTAINER_EXIT) {
    checkRead(digests.exitCode, 'proxy image');
    proxyImage = proxyImageOf(digests.stdout);
  }

  return {
    hostState,
    manifests,
    unreadableManifests: unreadableManifests.sort(),
    secrets,
    containers,
    web,
    proxyImage,
  };
}

/** A manifest's bytes parsed, or `undefined` when they are not a v1 manifest. */
function readManifest(bytes: Buffer): ReleaseManifest | undefined {
  try {
    return parseManifest(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Run `op` and collect its stdout as raw bytes: the dump frames files by
 * byte count, which text decoding would not preserve for a file that is not
 * UTF-8.
 */
async function readBytes(
  remote: RemoteRunner,
  server: string,
  op: RemoteOp,
): Promise<{ readonly exitCode: number; readonly stdout: Buffer }> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const result = await runRemoteOp(remote, server, op, { stdoutTo: sink });
  return { exitCode: result.exitCode, stdout: Buffer.concat(chunks) };
}

/** The proxy image from `container.image-digest` output (`["repo@sha256:…", …]`). */
function proxyImageOf(output: string): ObservedProxyImage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim() === '' ? 'null' : output);
  } catch {
    throw new ObserveErrors.Error('unreadable_output', { what: 'proxy image' });
  }
  if (parsed === null) return { kind: 'unpinned' };
  if (!isStringArray(parsed)) {
    throw new ObserveErrors.Error('unreadable_output', { what: 'proxy image' });
  }
  const entries = parsed;
  const repositories = [...new Set(entries.map((entry) => imageRepository(entry)))].sort();
  for (const repository of repositories) {
    const image = pinnedRepoDigest(entries, repository);
    if (image !== undefined) return { kind: 'pinned', image };
  }
  return { kind: 'unpinned' };
}
