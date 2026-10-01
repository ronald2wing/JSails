/**
 * Observed hosts for planner tests, built from a short description instead
 * of a server: which releases have a manifest (and a secrets file), what
 * `state.json` holds, which of the app's containers exist, and what the
 * proxy serves. Releases are numbered; release `n` was prepared from commit
 * `n` at minute `n`, so ids sort by number. The plan helpers fill the
 * context a run supplies (home, lock sequence, clock, author) with fixed
 * values, so a table can compare whole step lists.
 */

import { splitCommandLine } from '../../src/command-line.js';
import { WEB_ROLE, appContainerName } from '../../src/production/host-layout.js';
import {
  HOST_STATE_VERSION,
  encodeHostState,
  type HostState,
} from '../../src/production/host-state.js';
import {
  MANIFEST_VERSION,
  configDigest,
  type ReleaseManifest,
} from '../../src/production/manifest.js';
import type { ObservedContainer, ObservedState, WebTruth } from '../../src/production/observe.js';
import {
  planRelease,
  planRollback,
  type PlannedRelease,
  type ProductionPlan,
} from '../../src/production/plan.js';
import { PROXY_IMAGE_DEFAULT } from '../../src/production/proxy.js';
import { sha256Hex } from '../../src/production/remote-file.js';
import { releaseIdFor } from '../../src/production/release-id.js';
import type { JamalConfig } from '../../src/config/index.js';
import type { ResolvedEnv } from '../../src/env-resolve.js';

/** The ssh user's home the executor read from the server. */
export const HOME = '/home/deploy';

/** The lock sequence number a planned run holds. */
export const SEQ = 7;

/** The clock and author a planned run records. */
export const NOW = '2026-11-23T12:00:00.000Z';
export const BY = 'ana@laptop';

/** The commit release `n` was built from: 40 hex digits of `n`. */
export function commit(n: number): string {
  return n.toString(16).repeat(40).slice(0, 40);
}

/** The id of release `n`. */
export function release(n: number): string {
  return releaseIdFor(new Date(Date.UTC(2026, 10, 23, 10, n)), commit(n));
}

/** The digest-pinned image release `n` of `config` runs. */
export function imageOf(config: JamalConfig, n: number): string {
  return `${config.image}@sha256:${n.toString(16).repeat(64).slice(0, 64)}`;
}

/** The web container of release `n`. */
export function webContainer(config: JamalConfig, n: number): string {
  return appContainerName(config.service, config.production?.destination, WEB_ROLE, release(n));
}

/** The manifest a deploy of release `n` of `config` over `previous` wrote. */
export function manifestOf(config: JamalConfig, n: number, previous?: number): ReleaseManifest {
  return {
    v: MANIFEST_VERSION,
    releaseId: release(n),
    image: imageOf(config, n),
    git: { sha: commit(n), dirty: false },
    roles: {
      [WEB_ROLE]: {
        container: webContainer(config, n),
        command: config.command === undefined ? [] : splitCommandLine(config.command),
        replicas: 1,
      },
    },
    secretNames: [],
    secretsSha256: sha256Hex(Buffer.from('{"v":1,"values":{}}\n')),
    configSha256: configDigest(config),
    jsailsVersion: '1.0.0',
    infra: { proxyImage: PROXY_IMAGE_DEFAULT },
    release: { ran: false, exit: null },
    ...(previous === undefined ? {} : { previous: release(previous) }),
    createdAt: NOW,
    by: BY,
  };
}

/** A `state.json` naming releases by number. */
export function stateOf(live: number | null, previous: number | null = null): HostState {
  return {
    v: HOST_STATE_VERSION,
    seq: 3,
    live: live === null ? null : release(live),
    previous: previous === null ? null : release(previous),
    updatedAt: '2026-11-23T11:00:00.000Z',
    by: 'ben@desk',
  };
}

/** The SHA-256 of a state document's bytes, as a compare-and-replace names them. */
export function stateSha(state: HostState): string {
  return sha256Hex(encodeHostState(state));
}

/** One container of the app on the host. */
export interface ContainerSpec {
  /** The release it runs. */
  readonly n: number;
  readonly state?: string;
}

/** A host, by release number. */
export interface HostSpec {
  /** The releases with a manifest, each with the release it was deployed over. */
  readonly releases?: readonly (number | readonly [number, number])[];
  /** Releases among them whose secrets file is gone. */
  readonly secretsGone?: readonly number[];
  /** `state.json`: absent (the default), a document, or bytes that are no document. */
  readonly state?: HostState | 'unreadable';
  readonly containers?: readonly (number | ContainerSpec)[];
  /**
   * What the proxy serves: a release's web container, a container that is
   * no release (a name), or nothing (`null`). Absent (the default), jamal
   * does not route the app.
   */
  readonly serving?: number | string | null;
  /**
   * kamal-proxy is not running: `stopped` (its container exists) or
   * `missing` (none at all). Its routes cannot be read, so the host says
   * nothing about what it serves and `serving` must be absent.
   */
  readonly proxy?: 'stopped' | 'missing';
}

/** The observation of the host `spec` describes. */
export function observation(config: JamalConfig, spec: HostSpec = {}): ObservedState {
  const manifests = new Map<string, ReleaseManifest>();
  for (const entry of spec.releases ?? []) {
    const [n, previous] = typeof entry === 'number' ? [entry, undefined] : entry;
    manifests.set(release(n), manifestOf(config, n, previous));
  }
  const gone = new Set((spec.secretsGone ?? []).map(release));
  const containers: ObservedContainer[] = (spec.containers ?? [])
    .map((entry) => (typeof entry === 'number' ? { n: entry } : entry))
    .map(({ n, state }) => ({
      name: webContainer(config, n),
      state: state ?? 'running',
      image: imageOf(config, n),
      release: release(n),
      role: WEB_ROLE,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const serving = spec.serving;
  const web: WebTruth =
    spec.proxy !== undefined
      ? { kind: 'proxy-down' }
      : serving === undefined
        ? { kind: 'unrouted' }
        : serving === null
          ? { kind: 'none' }
          : {
              kind: 'container',
              container: typeof serving === 'number' ? webContainer(config, serving) : serving,
            };
  const state = spec.state;
  return {
    hostState:
      state === undefined
        ? { kind: 'absent' }
        : state === 'unreadable'
          ? { kind: 'unreadable', sha256: sha256Hex(Buffer.from('{"v":0}\n')) }
          : { kind: 'present', state, sha256: stateSha(state) },
    manifests,
    unreadableManifests: [],
    secrets: new Set([...manifests.keys()].filter((id) => !gone.has(id))),
    containers,
    web,
    proxyImage:
      spec.proxy === 'missing' || (spec.proxy === undefined && serving === undefined)
        ? { kind: 'none' }
        : { kind: 'pinned', image: PROXY_IMAGE_DEFAULT },
  };
}

/** Release `n` as a deploy plans it. */
export function plannedRelease(config: JamalConfig, n: number): PlannedRelease {
  return {
    id: release(n),
    image: imageOf(config, n),
    git: { sha: commit(n), dirty: false },
    secretsSha256: sha256Hex(Buffer.from('{"v":1,"values":{}}\n')),
    secretNames: [],
    jsailsVersion: '1.0.0',
  };
}

/** What a plan helper may vary. */
export interface PlanOverrides {
  readonly observed?: ObservedState;
  readonly release?: PlannedRelease;
  readonly env?: ResolvedEnv;
  readonly hostHome?: string;
  readonly preview?: boolean;
}

/** A deploy of release `n` (by default onto an empty host). */
export function deployPlan(
  config: JamalConfig,
  n: number,
  overrides: PlanOverrides = {},
): ProductionPlan {
  return planRelease(config, {
    hostHome: overrides.hostHome ?? HOME,
    seq: SEQ,
    now: NOW,
    by: BY,
    ...(overrides.env === undefined ? {} : { env: overrides.env }),
    release: overrides.release ?? plannedRelease(config, n),
    observed: overrides.observed ?? observation(config),
    ...(overrides.preview === undefined ? {} : { preview: overrides.preview }),
  });
}

/** A rollback on the observed host. */
export function rollbackPlan(
  config: JamalConfig,
  observed: ObservedState,
  overrides: Omit<PlanOverrides, 'observed' | 'release'> = {},
): ProductionPlan {
  return planRollback(config, {
    hostHome: overrides.hostHome ?? HOME,
    seq: SEQ,
    now: NOW,
    by: BY,
    ...(overrides.env === undefined ? {} : { env: overrides.env }),
    observed,
    ...(overrides.preview === undefined ? {} : { preview: overrides.preview }),
  });
}
