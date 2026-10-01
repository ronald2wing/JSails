/**
 * The health route: liveness, readiness, and the draining flip.
 *
 * `GET/HEAD <healthPath>` is a liveness probe: a fixed plain-text `OK` that
 * touches nothing. `?deep=1` (and the optional dedicated `readiness.path`) is a
 * readiness probe that runs the synchronous {@link SystemCheckRegistry} plus
 * the app's async {@link ReadinessProbe}s — a database `SELECT 1`, a Valkey
 * `PING` — in parallel, each bounded by a timeout, and answers 503 when any of
 * them fails.
 *
 * Both answer 503 once the server starts draining for shutdown
 * ({@link markDraining}), so a load balancer stops routing to an instance that
 * is about to go away while its in-flight requests finish.
 *
 * The probe is public because orchestrators call it without credentials, so an
 * anonymous caller sees only the aggregate status. Per-check results are shown
 * only to a caller the `readiness.authorize` callback accepts with exactly
 * `true`; a probe's thrown error text is never shown to anyone. Results are
 * cached for `cacheMs` and concurrent callers share one run, so a flood of
 * probes cannot multiply database pings.
 */

import type { Awaitable } from '../contracts/awaitable.js';
import type { SystemCheckRegistry } from '../database/system-checks.js';

/**
 * One readiness probe. It passes when it settles with any value other than
 * `false`; returning `false`, throwing, rejecting, or outliving the timeout
 * fails it. The signal aborts at the timeout so a probe can cancel its I/O.
 */
export type ReadinessProbe = (signal: AbortSignal) => Awaitable<unknown>;

/** Readiness configuration for {@link createApp}. */
export interface ReadinessOptions {
  /** Named async probes, run in parallel on every (uncached) readiness request. */
  readonly probes?: Readonly<Record<string, ReadinessProbe>>;
  /** Per-probe deadline in milliseconds. Defaults to 2000. */
  readonly timeoutMs?: number;
  /** How long one result is reused, in milliseconds. Defaults to 1000; `0` disables. */
  readonly cacheMs?: number;
  /**
   * Who may see per-check results. Exactly `true` shows them; anything else,
   * a throw, or an omitted callback shows only the aggregate status.
   */
  readonly authorize?: (request: Request) => Awaitable<boolean>;
  /** An extra path that serves readiness directly (e.g. `/ready`). */
  readonly path?: string;
}

/** Validated readiness configuration. */
export interface ResolvedReadiness {
  readonly probes: readonly (readonly [string, ReadinessProbe])[];
  readonly timeoutMs: number;
  readonly cacheMs: number;
  readonly authorize: ((request: Request) => Awaitable<boolean>) | undefined;
  readonly path: string | undefined;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_MS = 1000;

/** Apps whose server has begun draining for shutdown. */
const drainingApps = new WeakSet<object>();

/** Flip `app`'s health and readiness answers to 503 for the rest of its life. */
export function markDraining(app: object): void {
  drainingApps.add(app);
}

/** True once {@link markDraining} was called for `app`. */
export function isDraining(app: object): boolean {
  return drainingApps.has(app);
}

/** Validate the optional readiness options. */
export function resolveReadiness(
  value: ReadinessOptions | undefined,
): ResolvedReadiness | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') {
    throw new TypeError('readiness must be an options object');
  }
  const probes: (readonly [string, ReadinessProbe])[] = [];
  if (value.probes !== undefined) {
    if (value.probes === null || typeof value.probes !== 'object') {
      throw new TypeError('readiness.probes must be an object of functions');
    }
    for (const [name, probe] of Object.entries(value.probes)) {
      if (typeof probe !== 'function') {
        throw new TypeError('readiness.probes entries must be functions');
      }
      probes.push([name, probe]);
    }
  }
  const timeoutMs = value.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('readiness.timeoutMs must be a positive integer');
  }
  const cacheMs = value.cacheMs ?? DEFAULT_CACHE_MS;
  if (!Number.isInteger(cacheMs) || cacheMs < 0) {
    throw new TypeError('readiness.cacheMs must be a non-negative integer');
  }
  if (value.authorize !== undefined && typeof value.authorize !== 'function') {
    throw new TypeError('readiness.authorize must be a function');
  }
  if (value.path !== undefined && (typeof value.path !== 'string' || !value.path.startsWith('/'))) {
    throw new TypeError('readiness.path must be an absolute path');
  }
  return { probes, timeoutMs, cacheMs, authorize: value.authorize, path: value.path };
}

/** One check in an authorized readiness report. */
interface CheckResult {
  readonly id: string;
  readonly ok: boolean;
  readonly durationMs?: number;
  /** Why a probe failed: `timed_out` or `failed`. */
  readonly reason?: 'timed_out' | 'failed';
  /** A system check's own severity and framework-authored message. */
  readonly severity?: string;
  readonly message?: string;
}

interface ReadinessReport {
  readonly ok: boolean;
  readonly checks: readonly CheckResult[];
}

/** Everything the health handlers need, bound once per app. */
export interface HealthRouteInput {
  readonly app: object;
  readonly systemChecks: SystemCheckRegistry | undefined;
  readonly readiness: ResolvedReadiness | undefined;
}

/** Health handlers bound to one app: liveness and readiness. */
export interface HealthResponders {
  liveness(): Response;
  /** Readiness, or `undefined` when nothing is configured to check. */
  readiness(request: Request): Promise<Response> | undefined;
}

/** Bind the liveness and readiness handlers for one app. */
export function createHealthResponders(input: HealthRouteInput): HealthResponders {
  const { app, systemChecks, readiness } = input;
  let cached: { readonly at: number; readonly report: ReadinessReport } | undefined;
  let running: Promise<ReadinessReport> | undefined;

  const evaluate = (): Promise<ReadinessReport> => {
    const cacheMs = readiness?.cacheMs ?? DEFAULT_CACHE_MS;
    if (cached !== undefined && Date.now() - cached.at < cacheMs) {
      return Promise.resolve(cached.report);
    }
    running ??= runChecks(systemChecks, readiness).then(
      (report) => {
        cached = { at: Date.now(), report };
        running = undefined;
        return report;
      },
      (error: unknown) => {
        running = undefined;
        throw error;
      },
    );
    return running;
  };

  return {
    liveness: () =>
      isDraining(app) ? jsonHealth(503, { status: 'draining' }) : plainHealth(200, 'OK'),
    readiness: (request) => {
      if (systemChecks === undefined && readiness === undefined) {
        return isDraining(app)
          ? Promise.resolve(jsonHealth(503, { status: 'draining' }))
          : undefined;
      }
      return (async () => {
        if (isDraining(app)) return jsonHealth(503, { status: 'draining' });
        const [report, detailed] = await Promise.all([
          evaluate(),
          mayShowDetails(readiness?.authorize, request),
        ]);
        const status = report.ok ? 'ok' : 'error';
        return jsonHealth(
          report.ok ? 200 : 503,
          detailed ? { status, checks: report.checks } : { status },
        );
      })();
    },
  };
}

/** Run every system check and probe; a failure in one never hides the others. */
async function runChecks(
  systemChecks: SystemCheckRegistry | undefined,
  readiness: ResolvedReadiness | undefined,
): Promise<ReadinessReport> {
  const checks: CheckResult[] = [];
  for (const check of systemChecks?.run() ?? []) {
    checks.push({
      id: check.id,
      ok: check.severity !== 'error',
      severity: check.severity,
      message: check.message,
    });
  }
  const probes = readiness?.probes ?? [];
  const timeoutMs = readiness?.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  checks.push(...(await Promise.all(probes.map(([id, probe]) => runProbe(id, probe, timeoutMs)))));
  return { ok: checks.every((check) => check.ok), checks };
}

/** Run one probe under its deadline; its error text is deliberately dropped. */
async function runProbe(
  id: string,
  probe: ReadinessProbe,
  timeoutMs: number,
): Promise<CheckResult> {
  const controller = new AbortController();
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timed_out');
    }, timeoutMs);
  });
  const attempt = (async (): Promise<'passed' | 'failed'> => {
    try {
      return (await probe(controller.signal)) === false ? 'failed' : 'passed';
    } catch {
      return 'failed';
    }
  })();
  try {
    const outcome = await Promise.race([attempt, deadline]);
    const durationMs = Date.now() - started;
    return outcome === 'passed'
      ? { id, ok: true, durationMs }
      : { id, ok: false, durationMs, reason: outcome };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Per-check details are shown only on an exact `true` from `authorize`. */
async function mayShowDetails(
  authorize: ((request: Request) => Awaitable<boolean>) | undefined,
  request: Request,
): Promise<boolean> {
  if (authorize === undefined) return false;
  try {
    return (await authorize(request)) === true;
  } catch {
    return false;
  }
}

function plainHealth(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function jsonHealth(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
