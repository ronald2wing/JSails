/**
 * Decide which release of an app is live from what `observe` read:
 * {@link reconcile}, pure.
 *
 * The proxy is the truth. When jamal routes the app, the live release is
 * the one whose container web traffic reaches ({@link WebTruth}); a target
 * that is no release of the app (a container without a manifest, or none of
 * the app's), or no target at all, means nothing of the app is live.
 * `state.json` only records that truth, so a run killed between the proxy
 * switch and the state write leaves it one release behind, and the next run
 * finds the proxy ahead of it. For an app jamal does not route, the state's
 * live release is kept while its manifest exists, and so it is while
 * kamal-proxy is not running: a stopped or missing proxy cannot say which
 * release it would route to, so nothing contradicts the record, and a
 * temporary outage must not read as a host with nothing live.
 *
 * The previous release is the release a rollback returns to. When the
 * state agrees with the proxy it is the state's own previous; when the proxy
 * moved past the state, the state's live release is the one that served
 * before the switch; with no usable state, the live release's manifest says
 * which release it was deployed over. A previous release whose
 * manifest is gone (or that is the live one) cannot be returned to and is
 * dropped.
 *
 * When the result differs from the state on the host, {@link Reconciled}
 * carries the repair: why, and the SHA-256 of the bytes the host holds, so
 * the rewrite is a compare-and-replace of exactly what was observed.
 */

import type { HostState } from './host-state.js';
import type { ObservedState } from './observe.js';

/** Why `state.json` must be rewritten before anything else. */
export type RepairReason =
  /** There is no `state.json`, but the host serves or keeps a release. */
  | 'missing'
  /** `state.json` is not a v1 document. */
  | 'unreadable'
  /** The proxy serves another release than `state.json` names. */
  | 'live-mismatch'
  /** jamal routes the app, but the proxy serves nothing for it. */
  | 'route-missing'
  /** The proxy serves a container that is no release of the app. */
  | 'route-unknown'
  /** `state.json` names a previous release that cannot be returned to. */
  | 'previous-missing';

/** A rewrite of `state.json` that the observed host needs. */
export interface StateRepair {
  readonly reason: RepairReason;
  /** What a compare-and-replace expects the file to hold: `absent`, or the observed bytes' SHA-256. */
  readonly expect: string;
}

/** The live and previous releases of an app, and the repair that records them. */
export interface Reconciled {
  readonly live: string | null;
  readonly previous: string | null;
  readonly repair: StateRepair | undefined;
}

/** What web traffic reaches: a release, nothing, or a container that is no release. */
type Routed =
  | { readonly kind: 'release'; readonly release: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unknown' };

/** The release whose container web traffic reaches. */
function routedRelease(observed: ObservedState): Routed {
  const web = observed.web;
  if (web.kind !== 'container') return { kind: 'none' };
  const container = observed.containers.find((candidate) => candidate.name === web.container);
  if (container === undefined || !observed.manifests.has(container.release)) {
    return { kind: 'unknown' };
  }
  return { kind: 'release', release: container.release };
}

/** The state as observed, when it parsed. */
function stateOf(observed: ObservedState): HostState | undefined {
  return observed.hostState.kind === 'present' ? observed.hostState.state : undefined;
}

/** Reconcile the observed host into its live and previous releases. */
export function reconcile(observed: ObservedState): Reconciled {
  const state = stateOf(observed);
  const known = (release: string | null | undefined): release is string =>
    typeof release === 'string' && observed.manifests.has(release);

  let live: string | null;
  let routeReason: RepairReason | undefined;
  if (observed.web.kind === 'unrouted' || observed.web.kind === 'proxy-down') {
    live = known(state?.live) ? state.live : null;
  } else {
    const routed = routedRelease(observed);
    live = routed.kind === 'release' ? routed.release : null;
    if (routed.kind === 'unknown') routeReason = 'route-unknown';
    if (routed.kind === 'none') routeReason = 'route-missing';
  }

  let previous: string | null;
  if (state !== undefined && state.live === live) {
    previous = state.previous;
  } else if (state !== undefined && state.live !== null) {
    previous = state.live;
  } else {
    previous = live === null ? null : (observed.manifests.get(live)?.previous ?? null);
  }
  if (!known(previous) || previous === live) previous = null;

  const expect = observed.hostState.kind === 'absent' ? 'absent' : observed.hostState.sha256;
  const result = (reason: RepairReason | undefined): Reconciled => ({
    live,
    previous,
    repair: reason === undefined ? undefined : { reason, expect },
  });

  switch (observed.hostState.kind) {
    case 'absent':
      return result(live === null && previous === null ? undefined : 'missing');
    case 'unreadable':
      return result('unreadable');
    case 'present':
      break;
  }
  if (state === undefined || (state.live === live && state.previous === previous)) {
    return result(undefined);
  }
  if (state.live !== live) {
    return result(live === null ? (routeReason ?? 'live-mismatch') : 'live-mismatch');
  }
  return result('previous-missing');
}
