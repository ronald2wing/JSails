/**
 * Scope matrix: at every observation point of the request pipeline, the
 * request's own request id, services, locale, tenant and (where the framework
 * hands the point a context) session are visible.
 *
 * The conformance app (`scope-app.ts`) has a tenant request scope, the real
 * i18n plugin negotiating `fr`, a session resolver and a probe service. Each
 * case sends one request carrying `X-Request-Id`, `X-Tenant: acme`,
 * `Accept-Language: fr` and the session cookie, through both drivers
 * (`app.fetch` and the production request listener), and every observation
 * point it reaches records what it saw. One test per point and value, so a
 * work package that fixes one point removes exactly its rows from
 * `scripts/expected-failures/request.json`.
 *
 * Adding an observation point: call `observe('<point>', context)` from the
 * code that runs there (a fixture module in `scope-app.ts`, an extension hook
 * or an app callback), then add the point to a case in `CASES` below with the
 * request that reaches it. If it fails today, add one ledger entry per
 * failing row naming the package that fixes it.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { COMPONENT_UPDATE_ENDPOINT } from '../../../src/server-components/protocol.js';
import { TEST_ORIGIN } from '../../fixtures/app.js';
import { createDrivers, type Driver } from './drivers.js';
import { createScopeApp, EXPECTED, MAX_BODY_BYTES } from './scope-app.js';
import { beginCase, observationsOf, waitForObservation, type Observation } from './scope-probe.js';

/** One observation point a case reaches. */
interface Point {
  readonly point: string;
  readonly label: string;
  /** Whether the framework hands this point the request's context (so its session). */
  readonly session: boolean;
  /** Whether the point is the error hook, whose report also names the route. */
  readonly route?: string;
}

/** One request and the points it reaches. */
interface ScopeCase {
  readonly id: string;
  readonly method?: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly abortAfterChunks?: number;
  readonly points: readonly Point[];
  /** A point reached only after the response (a stream's `finally`, a late report). */
  readonly awaitPoint?: string;
}

const html = { accept: 'text/html' };

const CASES: readonly ScopeCase[] = [
  {
    id: 'api',
    path: '/api/probe',
    points: [
      { point: 'api.authorize', label: 'authorize', session: true },
      { point: 'api.module-authorize', label: 'module authorize', session: true },
      { point: 'api.handler', label: 'API handler', session: true },
    ],
  },
  {
    id: 'page',
    path: '/probe',
    headers: html,
    points: [
      { point: 'page.load', label: 'page load', session: true },
      { point: 'page.render', label: 'page component', session: true },
      { point: 'layout', label: 'layout', session: true },
    ],
  },
  {
    id: 'boundary',
    path: '/boom',
    headers: html,
    points: [{ point: 'error-boundary', label: 'error boundary', session: true }],
  },
  {
    id: 'not-found-page',
    path: '/docs/missing',
    headers: html,
    points: [{ point: 'not-found-page', label: 'not-found page', session: true }],
  },
  {
    id: 'error-404',
    path: '/missing',
    headers: html,
    points: [{ point: 'error-page.404', label: 'error page 404', session: true }],
  },
  {
    id: 'error-405',
    method: 'DELETE',
    path: '/probe',
    headers: html,
    points: [{ point: 'error-page.405', label: 'error page 405', session: true }],
  },
  {
    id: 'error-413',
    method: 'POST',
    path: '/probe',
    headers: { ...html, 'content-type': 'text/plain' },
    body: 'x'.repeat(MAX_BODY_BYTES * 2),
    points: [{ point: 'error-page.413', label: 'error page 413', session: true }],
  },
  {
    id: 'error-500',
    path: '/fail',
    headers: html,
    awaitPoint: 'error-hook',
    points: [
      { point: 'error-page.500', label: 'error page 500', session: true },
      { point: 'error-hook', label: 'failure report', session: false, route: '/fail' },
    ],
  },
  {
    id: 'hook-route',
    path: '/hook/probe',
    points: [{ point: 'hook.route', label: 'hook route', session: true }],
  },
  {
    id: 'hook-mount',
    path: '/sub/probe',
    points: [{ point: 'hook.mount', label: 'mounted sub-app', session: true }],
  },
  {
    id: 'hook-base-path',
    path: '/based/probe',
    points: [{ point: 'hook.base-path', label: 'basePath sub-app', session: true }],
  },
  {
    id: 'component-update',
    method: 'POST',
    path: COMPONENT_UPDATE_ENDPOINT,
    headers: { 'content-type': 'application/json' },
    body: '{}',
    points: [{ point: 'component.update', label: 'component update route', session: true }],
  },
  {
    id: 'stream',
    path: '/stream',
    headers: html,
    points: [1, 2, 3].map((chunk) => ({
      point: `stream.chunk${chunk}`,
      label: `stream chunk ${chunk}`,
      session: true,
    })),
  },
  {
    id: 'cancel',
    path: '/endless',
    headers: html,
    abortAfterChunks: 1,
    awaitPoint: 'stream.finally',
    points: [{ point: 'stream.finally', label: 'generator finally on cancel', session: true }],
  },
  {
    id: 'late',
    path: '/late',
    headers: html,
    awaitPoint: 'error-hook',
    points: [{ point: 'error-hook', label: 'late failure report', session: false, route: '/late' }],
  },
];

type Field = 'request id' | 'services' | 'locale' | 'tenant' | 'session' | 'route';

function fieldsOf(point: Point): readonly Field[] {
  const fields: Field[] = ['request id', 'services', 'locale', 'tenant'];
  if (point.session) fields.push('session');
  if (point.route !== undefined) fields.push('route');
  return fields;
}

function expectedValue(field: Field, point: Point, requestId: string): unknown {
  switch (field) {
    case 'request id':
      return requestId;
    case 'services':
      return true;
    case 'locale':
      return EXPECTED.locale;
    case 'tenant':
      return EXPECTED.tenant;
    case 'session':
      return EXPECTED.session;
    case 'route':
      return point.route;
  }
}

function actualValue(field: Field, observation: Observation): unknown {
  switch (field) {
    case 'request id':
      return observation.requestId;
    case 'services':
      return observation.services;
    case 'locale':
      return observation.locale;
    case 'tenant':
      return observation.tenant;
    case 'session':
      return observation.session;
    case 'route':
      return observation.detail?.['route'];
  }
}

function show(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

const scopeApp = await createScopeApp();
after(() => scopeApp.close());
const drivers = createDrivers(scopeApp.app);

function caseKey(driver: Driver, scopeCase: ScopeCase): string {
  return `scope-${scopeCase.id}-${driver.name === 'app.fetch' ? 'fetch' : 'listener'}`;
}

/** Send every case through `driver`, recording a transport failure instead of throwing. */
async function runCases(driver: Driver, failures: Map<string, string>): Promise<void> {
  for (const scopeCase of CASES) {
    const key = caseKey(driver, scopeCase);
    beginCase(key);
    const request = new Request(`${TEST_ORIGIN}${scopeCase.path}`, {
      method: scopeCase.method ?? 'GET',
      headers: {
        'x-request-id': key,
        'x-tenant': EXPECTED.tenant,
        'accept-language': EXPECTED.locale,
        cookie: `sid=${EXPECTED.session}`,
        ...scopeCase.headers,
      },
      ...(scopeCase.body === undefined ? {} : { body: scopeCase.body }),
    });
    try {
      await driver.send(
        request,
        scopeCase.abortAfterChunks === undefined
          ? {}
          : { abortAfterChunks: scopeCase.abortAfterChunks },
      );
      if (scopeCase.awaitPoint !== undefined) {
        await waitForObservation(key, scopeCase.awaitPoint);
      }
    } catch (error) {
      failures.set(key, error instanceof Error ? error.message : String(error));
    }
  }
}

describe('scope matrix', () => {
  for (const driver of drivers) {
    describe(driver.name, () => {
      const failures = new Map<string, string>();
      before(() => runCases(driver, failures));

      for (const scopeCase of CASES) {
        const key = caseKey(driver, scopeCase);
        for (const point of scopeCase.points) {
          describe(point.label, () => {
            for (const field of fieldsOf(point)) {
              it(`sees the ${field}`, () => {
                const failure = failures.get(key);
                assert.equal(failure, undefined, `${point.label}: the request failed: ${failure}`);
                const seen = observationsOf(key).filter((entry) => entry.point === point.point);
                assert.ok(seen.length > 0, `${point.label} was never observed`);
                const expected = expectedValue(field, point, key);
                for (const observation of seen) {
                  const actual = actualValue(field, observation);
                  assert.equal(
                    actual,
                    expected,
                    `${point.label} saw ${field} ${show(actual)}, expected ${show(expected)}`,
                  );
                }
              });
            }
          });
        }
      }
    });
  }
});
