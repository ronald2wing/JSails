/**
 * Known holes in core's request security, each stated as the safe behaviour
 * against a real assembled app (`createTestApp`), so a fix shows up as a test
 * that starts passing.
 *
 * A case that fails today is listed in `scripts/expected-failures/security.json`
 * with the work package that closes it; the runner fails the suite when a
 * listed case starts passing, so the entry has to go with the fix. A case that
 * already holds (a hole closed before this harness existed) stays here as an
 * ordinary passing regression test.
 *
 * The cases: the cross-site check on unsafe requests (filesystem API routes and
 * extension hook routes; a request whose `Origin` is absent passes only with
 * `Sec-Fetch-Site: same-origin`), the order of the gate and the body read (a
 * denied request must cost the server no body bytes), and whether a throwing
 * authorization callback reaches the app's error hook on every surface that
 * takes one, rather than being turned silently into a deny. Each throwing
 * callback counts its calls, so a case whose route went missing or whose
 * fixture broke fails on the count instead of passing as a matched hole.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { z } from 'zod';

import type { Session } from '../../src/contracts/http.js';
import type { JsailsPlugin } from '../../src/extensions/index.js';
import { INTROSPECT_ENDPOINT } from '../../src/introspect/route.js';
import { defineServerComponent } from '../../src/server-components/component.js';
import { serverComponentsPlugin } from '../../src/server-components/extension.js';
import type { RequestErrorHook } from '../../src/server/request-errors.js';
import { createTestApp, type TestApplication } from '../../src/testing/app.js';
import type { JsailsAppConfig } from '../../src/testing/index.js';
import { writeFixture } from '../fixtures/app.js';

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'security-known-holes-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const apiUrl = pathToFileURL(join(distDir, 'src/api/index.js')).href;
const extensionUrl = pathToFileURL(join(distDir, 'src/server-components/extension.js')).href;

writeFixture(
  root,
  'api/items.mjs',
  `export const POST = async (request) => {
  const text = await request.text();
  return Response.json({ length: text.length });
};
`,
);

/**
 * Where the resource fixture counts its `authorize` calls. The fixture is a
 * separate module loaded by the app, so the count lives on a registered symbol
 * both sides can name.
 */
const NOTES_AUTHORIZE_CALLS = 'jsails.test.security-known-holes.notes-authorize-calls';

/** How many times the resource fixture's `authorize` has run. */
function notesAuthorizeCalls(): number {
  const count: unknown = Reflect.get(globalThis, Symbol.for(NOTES_AUTHORIZE_CALLS));
  return typeof count === 'number' ? count : 0;
}

/** A declarative resource whose `authorize` throws: a policy-store outage. */
writeFixture(
  root,
  'api/notes.mjs',
  `import { createResourceHandlers } from ${JSON.stringify(apiUrl)};

const calls = Symbol.for(${JSON.stringify(NOTES_AUTHORIZE_CALLS)});

const handlers = createResourceHandlers({
  serializer: { toRepresentation: (record) => record },
  store: {
    count: async () => 0,
    list: async () => [],
    get: async () => null,
    create: async () => ({}),
    update: async () => null,
    delete: async () => undefined,
  },
  authorize: () => {
    globalThis[calls] = (globalThis[calls] ?? 0) + 1;
    throw new Error('policy store unavailable');
  },
});

export const GET = handlers.collection.GET;
`,
);

writeFixture(
  root,
  'pages/[component].mjs',
  `import { renderServerComponent } from ${JSON.stringify(extensionUrl)};

export default async function Page(_props, context) {
  return renderServerComponent(context.params.component, context);
}
`,
);

const SESSION: Session = {
  id: 'session-known-holes',
  csrfToken: 'csrf-known-holes-0123456789abcdef',
  data: { user: { id: 'u1' } },
  expiresAt: 2_000_000_000_000,
};

/** What a hostile page's origin looks like in these tests. */
const EVIL_ORIGIN = 'https://evil.example';

/** The error every throwing callback in this file raises. */
const outage = (): Error => new Error('policy store unavailable');

/** A callback that records each call, then throws {@link outage}. */
function throwingCallback(): { readonly calls: () => number; readonly callback: () => never } {
  let calls = 0;
  return {
    calls: () => calls,
    callback: () => {
      calls += 1;
      throw outage();
    },
  };
}

/**
 * The statuses a refused request may carry while a throwing callback is the
 * cause: today's deny (403), a component runtime error (500), or the fault
 * mapping SEC-04 introduces (503). Anything else (200, a 404 from a route that
 * went missing) means the case no longer exercises the callback.
 */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([403, 500, 503]);

function assertRefused(response: Response): void {
  assert.ok(REFUSAL_STATUSES.has(response.status), `refused, got ${String(response.status)}`);
}

/** One reported failure, as the app's `onError` hook saw it. */
interface Report {
  readonly error: unknown;
  readonly phase: string;
}

/** An `onError` hook that records every report. */
function recordReports(): { readonly reports: Report[]; readonly onError: RequestErrorHook } {
  const reports: Report[] = [];
  return {
    reports,
    onError: (error, info) => {
      reports.push({ error, phase: info.phase });
    },
  };
}

/** True when some report carries an error with the outage message. */
function reportedOutage(reports: readonly Report[]): boolean {
  const matches = (value: unknown): boolean =>
    value instanceof Error &&
    (value.message === 'policy store unavailable' || matches(value.cause));
  return reports.some((report) => matches(report.error));
}

async function makeApp(config: JsailsAppConfig): Promise<TestApplication> {
  return createTestApp({ config: { rootDir: root, port: 0, ...config } });
}

/**
 * A request body that counts the bytes a consumer actually pulls. The
 * high-water mark of 0 keeps the stream from pre-filling its queue, so the
 * count is exactly what the server read.
 */
function countingBody(totalBytes = 64 * 1024): {
  readonly body: ReadableStream<Uint8Array>;
  pulled(): number;
} {
  const chunk = 1024;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled >= totalBytes) {
          controller.close();
          return;
        }
        pulled += chunk;
        controller.enqueue(new Uint8Array(chunk).fill(0x61));
      },
    },
    { highWaterMark: 0 },
  );
  return { body, pulled: () => pulled };
}

/** A streamed POST (no `Content-Length`, as a chunked upload arrives). */
function streamedPost(
  body: ReadableStream<Uint8Array>,
  headers: Readonly<Record<string, string>>,
): RequestInit {
  return { method: 'POST', headers, body, duplex: 'half' } as RequestInit;
}

/** An extension that mounts one unsafe hook route answering 200. */
const hookRoutePlugin: JsailsPlugin = {
  name: 'known-holes-hook',
  setup: ({ configureHttp }) =>
    configureHttp((app) => {
      app.post('/hook/settings', () => Response.json({ changed: true }));
    }),
};

describe('known holes: cross-site unsafe requests', () => {
  it('refuses an anonymous cross-origin POST to a filesystem API route', async () => {
    const app = await makeApp({ authorize: () => true });
    try {
      const response = await app.request('/api/items', {
        method: 'POST',
        headers: { origin: EVIL_ORIGIN, 'content-type': 'text/plain' },
        body: 'x',
      });
      assert.equal(response.status, 403);
      const sameOrigin = await app.request('/api/items', {
        method: 'POST',
        headers: { origin: app.origin, 'content-type': 'text/plain' },
        body: 'x',
      });
      assert.equal(sameOrigin.status, 200, 'the same request from the app origin passes');
    } finally {
      await app.close();
    }
  });

  it('refuses an unsafe request with neither Origin nor Sec-Fetch-Site: same-origin', async () => {
    const app = await makeApp({ authorize: () => true });
    try {
      // The twin first, so it is exercised while the hole is open: a browser
      // that omits Origin on a same-origin request still sends Sec-Fetch-Site.
      const sameOrigin = await app.request('/api/items', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' },
        body: 'x',
      });
      assert.equal(sameOrigin.status, 200, 'Sec-Fetch-Site: same-origin passes');
      const response = await app.request('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'x',
      });
      assert.equal(response.status, 403, 'an unsafe request with no Origin or Sec-Fetch-Site');
    } finally {
      await app.close();
    }
  });

  it('refuses a cross-origin POST to an extension hook route', async () => {
    const app = await makeApp({ extensions: [hookRoutePlugin], resolveSession: () => SESSION });
    try {
      // A hostile page posting with the visitor's cookie, and without one
      // (login CSRF): both are cross-site writes to a cookie-accepting surface.
      const attempts: readonly Record<string, string>[] = [
        { origin: EVIL_ORIGIN, cookie: 'session=visitor' },
        { origin: EVIL_ORIGIN },
      ];
      for (const headers of attempts) {
        const response = await app.request('/hook/settings', { method: 'POST', headers });
        assert.equal(response.status, 403, 'a cross-origin hook-route POST is refused');
      }
    } finally {
      await app.close();
    }
  });
});

describe('known holes: the gate runs before the body is read', () => {
  it('reads no body bytes for a request the authorize gate denies', async () => {
    const app = await makeApp({ authorize: () => false });
    try {
      const counted = countingBody();
      const response = await app.request(
        '/api/items',
        streamedPost(counted.body, { origin: app.origin, 'content-type': 'text/plain' }),
      );
      assert.equal(response.status, 403);
      assert.equal(counted.pulled(), 0, 'body bytes read before the gate denied');
    } finally {
      await app.close();
    }
  });

  it('reads no body bytes for a cross-origin request the origin check refuses', async () => {
    const app = await makeApp({ authorize: () => true });
    try {
      const counted = countingBody();
      const response = await app.request(
        '/api/items',
        streamedPost(counted.body, { origin: EVIL_ORIGIN, 'content-type': 'text/plain' }),
      );
      assert.equal(response.status, 403);
      assert.equal(counted.pulled(), 0, 'body bytes read before the origin check refused');
    } finally {
      await app.close();
    }
  });
});

describe('known holes: a throwing authorize is a reported fault', () => {
  it('reports a throwing global API authorize', async () => {
    const { reports, onError } = recordReports();
    const authorize = throwingCallback();
    const app = await makeApp({ authorize: authorize.callback, onError });
    try {
      const response = await app.request('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'x',
      });
      assert.ok(authorize.calls() >= 1, 'the global authorize ran');
      assertRefused(response);
      assert.ok(reportedOutage(reports), 'the authorize failure reached onError');
    } finally {
      await app.close();
    }
  });

  it('reports a throwing resource-handler authorize', async () => {
    const { reports, onError } = recordReports();
    const app = await makeApp({ authorize: () => true, onError });
    try {
      const before = notesAuthorizeCalls();
      const response = await app.request('/api/notes');
      assert.ok(notesAuthorizeCalls() > before, 'the resource authorize ran');
      assertRefused(response);
      assert.ok(reportedOutage(reports), 'the resource authorize failure reached onError');
    } finally {
      await app.close();
    }
  });

  it('reports a throwing server-component authorize', async () => {
    const authorize = throwingCallback();
    const guarded = defineServerComponent<{ count: number }>({
      name: 'Guarded',
      stateSchema: z.object({ count: z.number() }).strict(),
      initialState: () => ({ count: 0 }),
      authorize: authorize.callback,
      render: (state) => <span>{state.count}</span>,
    });
    const { reports, onError } = recordReports();
    const app = await makeApp({
      extensions: [
        serverComponentsPlugin({
          components: { Guarded: guarded },
          signingKey: 'known-holes-signing-key-0123456789abcdef',
        }),
      ],
      onError,
    });
    try {
      const response = await app.request('/Guarded');
      assert.ok(authorize.calls() >= 1, 'the component authorize ran');
      assertRefused(response);
      assert.ok(reportedOutage(reports), 'the component authorize failure reached onError');
    } finally {
      await app.close();
    }
  });

  it('reports a throwing readiness authorize', async () => {
    const { reports, onError } = recordReports();
    const authorize = throwingCallback();
    const app = await makeApp({
      readiness: { path: '/ready', probes: { ok: () => true }, authorize: authorize.callback },
      onError,
    });
    try {
      const response = await app.request('/ready');
      assert.ok(authorize.calls() >= 1, 'the readiness authorize ran');
      assert.deepEqual(await response.json(), { status: 'ok' });
      assert.ok(reportedOutage(reports), 'the readiness authorize failure reached onError');
    } finally {
      await app.close();
    }
  });

  it('reports a throwing introspection authorize', async () => {
    const { reports, onError } = recordReports();
    const authorize = throwingCallback();
    const app = await makeApp({
      introspect: { enabled: true, authorize: authorize.callback },
      onError,
    });
    try {
      const response = await app.request(INTROSPECT_ENDPOINT);
      assert.ok(authorize.calls() >= 1, 'the introspection authorize ran');
      assertRefused(response);
      assert.ok(reportedOutage(reports), 'the introspection authorize failure reached onError');
    } finally {
      await app.close();
    }
  });
});
