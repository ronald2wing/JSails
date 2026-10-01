/**
 * The observation recorder of the conformance app.
 *
 * Fixture route modules, extension hooks and app callbacks call
 * {@link observe} at each observation point; the suites read what was seen.
 * Requests run one at a time, so every observation belongs to the case opened
 * by the last {@link beginCase}. Fixture modules import this file by its
 * compiled URL, so they share this module instance with the suites.
 *
 * {@link counters} counts the app-side work a cost budget names (session
 * resolutions, scope calls, `load` calls, page renders, error-page renders,
 * module evaluations); the process-wide operation counters live in
 * `scripts/bench/collectors`.
 */

import type { RequestContext } from '../../../src/contracts/http.js';
import { currentTenantId } from '../../../src/database/tenant-context.js';
import { currentAppScope } from '../../../src/facades/app-scope.js';
import { currentLocale } from '../../../src/i18n/request-locale.js';
import { currentRequestId } from '../../../src/server/request-scope.js';
import { createServiceToken } from '../../../src/extensions/services.js';

/** A service the conformance app provides, read back ambiently at each point. */
export const probeServiceToken = createServiceToken<{ readonly name: 'probe' }>(
  'conformance.probe',
);

/**
 * What one observation point saw. `session` is the session id the point could
 * read from the context the framework handed it, `null` for no session, and
 * absent when the framework hands that point no context at all.
 */
export interface Observation {
  readonly point: string;
  readonly requestId: string | undefined;
  readonly services: boolean;
  readonly locale: string | undefined;
  readonly tenant: string | number | undefined;
  readonly session?: string | null;
  /** Free-form facts a point adds (the error hook's `info`). */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** The app-side work counters. */
export interface ProbeCounters {
  sessions: number;
  scopes: number;
  loads: number;
  renders: number;
  errorPages: number;
  evaluations: Record<string, number>;
}

function emptyCounters(): ProbeCounters {
  return { sessions: 0, scopes: 0, loads: 0, renders: 0, errorPages: 0, evaluations: {} };
}

let current: Observation[] = [];
let handlerMark: (() => void) | undefined;
const cases = new Map<string, Observation[]>();
const waiters = new Set<() => void>();

/** App-side work since the last {@link resetCounters}. */
export const counters: ProbeCounters = emptyCounters();

/** Zero the app-side work counters (module evaluations are kept). */
export function resetCounters(): void {
  const { evaluations } = counters;
  Object.assign(counters, emptyCounters(), { evaluations });
}

/** Count one evaluation of a fixture module; `name` is its `import.meta.url`. */
export function evaluated(name: string): void {
  counters.evaluations[name] = (counters.evaluations[name] ?? 0) + 1;
}

/**
 * Register what {@link handlerReturned} does: the cost suite marks its
 * collectors there, so work after the handler can be told from the handler's.
 */
export function onHandlerReturn(mark: (() => void) | undefined): void {
  handlerMark = mark;
}

/** Called by a fixture handler just before it returns its response. */
export function handlerReturned(): void {
  handlerMark?.();
}

/** Start recording observations under `id`. */
export function beginCase(id: string): void {
  current = [];
  cases.set(id, current);
}

/** Every observation recorded under `id`. */
export function observationsOf(id: string): readonly Observation[] {
  return cases.get(id) ?? [];
}

/** Record what is ambient at `point`, plus the session `context` carries when given. */
export function observe(
  point: string,
  context?: Pick<RequestContext, 'session'> | { readonly session: { id: string } | null },
  detail?: Readonly<Record<string, unknown>>,
): void {
  const scope = currentAppScope();
  current.push({
    point,
    requestId: currentRequestId(),
    services: scope?.services.has(probeServiceToken) === true,
    locale: currentLocale(),
    tenant: currentTenantId(),
    ...(context === undefined ? {} : { session: context.session?.id ?? null }),
    ...(detail === undefined ? {} : { detail }),
  });
  for (const wake of [...waiters]) wake();
}

/**
 * Resolve once `id` has an observation at `point`, or after `timeoutMs`
 * either way (the suite then reports the point as not observed).
 */
export function waitForObservation(id: string, point: string, timeoutMs = 500): Promise<void> {
  const seen = (): boolean => observationsOf(id).some((entry) => entry.point === point);
  if (seen()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      waiters.delete(check);
      resolve();
    };
    const check = (): void => {
      if (seen()) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    waiters.add(check);
  });
}
