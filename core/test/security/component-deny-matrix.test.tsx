/**
 * Table-driven deny matrix for the server-component transport endpoints
 * (`/_jsails/components/update`, `/upload`, `/download`) through a real
 * `Application` built by `createTestApp`.
 *
 * Each row is one request against a mounted component: missing, empty, wrong,
 * and cross-session CSRF tokens; cross-origin and Origin-less requests; and
 * tampered, truncated, re-encoded, and cross-session snapshot tokens. The
 * enumeration check fails when the protocol gains an endpoint this suite has
 * no rows for.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { z } from 'zod';

import type { Session } from '../../src/contracts/http.js';
import { defineAction, defineServerComponent } from '../../src/server-components/component.js';
import { serverComponentsPlugin } from '../../src/server-components/extension.js';
import * as protocol from '../../src/server-components/protocol.js';
import {
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_CSRF_HEADER,
  COMPONENT_DOWNLOAD_ENDPOINT,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  COMPONENT_UPDATE_ENDPOINT,
  COMPONENT_UPLOAD_ENDPOINT,
} from '../../src/server-components/protocol.js';
import { createTestApp, type TestApplication } from '../../src/testing/app.js';
import { writeFixture } from '../fixtures/app.js';

const KEY = 'security-deny-matrix-signing-key-0123456789';

const counter = defineServerComponent<{ count: number; title: string }>({
  name: 'Counter',
  stateSchema: z.object({ count: z.number(), title: z.string() }).strict(),
  writableKeys: ['title'],
  initialState() {
    return { count: 0, title: 'hello' };
  },
  authorize() {
    return true;
  },
  // Accepting uploads lets the untampered control reach 201, so the tampered row
  // can only fail at the snapshot check.
  uploads: { contentTypes: ['image/png'] },
  actions: {
    increment: defineAction({
      input: z.object({ by: z.number() }).strict(),
      run(state, input) {
        state.count += input.by;
      },
    }),
  },
  render(state) {
    return <span id="count">{state.count}</span>;
  },
});

const distDir = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync(join(distDir, 'security-components-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const extensionUrl = pathToFileURL(join(distDir, 'src/server-components/extension.js')).href;
writeFixture(
  root,
  'pages/[component].mjs',
  `import { renderServerComponent } from ${JSON.stringify(extensionUrl)};

export default async function Page(_props, context) {
  return renderServerComponent(context.params.component, context);
}
`,
);

const SESSION_A: Session = {
  id: 'session-a-deny-matrix',
  csrfToken: 'csrf-a-0123456789abcdef0123456789',
  data: {},
  expiresAt: 2_000_000_000_000,
};
const SESSION_B: Session = {
  id: 'session-b-deny-matrix',
  csrfToken: 'csrf-b-0123456789abcdef0123456789',
  data: {},
  expiresAt: 2_000_000_000_000,
};

/** The session the next request resolves; rows switch it to probe binding. */
let currentSession: Session | null = SESSION_A;

async function makeApp(): Promise<TestApplication> {
  return createTestApp({
    config: {
      rootDir: root,
      port: 0,
      extensions: [
        serverComponentsPlugin({ components: { Counter: counter }, signingKey: KEY, uploads: {} }),
      ],
      resolveSession: () => currentSession,
    },
  });
}

function attribute(html: string, name: string): string {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(match, `expected ${name} in the mounted HTML`);
  return match[1]!;
}

async function mount(app: TestApplication): Promise<{ snapshot: string; csrf: string }> {
  const response = await app.request('/Counter');
  const html = await response.text();
  assert.equal(response.status, 200);
  return {
    snapshot: attribute(html, COMPONENT_SNAPSHOT_ATTRIBUTE),
    csrf: attribute(html, COMPONENT_CSRF_ATTRIBUTE),
  };
}

// ---------------------------------------------------------------------------
// Endpoint enumeration
// ---------------------------------------------------------------------------

const COVERED_ENDPOINTS = new Set([
  COMPONENT_UPDATE_ENDPOINT,
  COMPONENT_UPLOAD_ENDPOINT,
  COMPONENT_DOWNLOAD_ENDPOINT,
]);

describe('component deny matrix: endpoint enumeration', () => {
  it('has rows for every transport endpoint the protocol declares', () => {
    const declared = Object.entries(protocol)
      .filter(([name]) => name.endsWith('_ENDPOINT'))
      .map(([, value]) => value as string);
    assert.deepEqual(
      declared.filter((endpoint) => !COVERED_ENDPOINTS.has(endpoint)),
      [],
      'a new component endpoint needs deny-matrix rows',
    );
  });
});

// ---------------------------------------------------------------------------
// Update endpoint
// ---------------------------------------------------------------------------

interface Mounted {
  readonly snapshot: string;
  readonly csrf: string;
}

interface UpdateRow {
  readonly name: string;
  /** The session the update request resolves (the mount always uses A). */
  readonly session?: Session | null;
  readonly origin?: (app: TestApplication) => string | undefined;
  readonly csrf?: (mounted: Mounted) => string | undefined;
  readonly snapshot?: (mounted: Mounted) => string;
  readonly status: number;
  readonly code?: string;
}

/** Flip one character in the middle of a base64url token segment. */
function flipMiddle(token: string): string {
  const index = Math.floor(token.length / 2);
  const original = token[index];
  const replacement = original === 'A' ? 'B' : 'A';
  return `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
}

/** Re-sign nothing: swap in a payload with a raised count but keep the old MAC. */
function forgeCount(token: string): string {
  const [payload, mac] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as {
    state: { count: number };
  };
  decoded.state.count = 1_000_000;
  return `${Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')}.${mac!}`;
}

const UPDATE_ROWS: readonly UpdateRow[] = [
  { name: 'a valid same-origin update', status: 200 },
  { name: 'a missing CSRF token', csrf: () => undefined, status: 403, code: 'csrf_mismatch' },
  { name: 'an empty CSRF token', csrf: () => '', status: 403, code: 'csrf_mismatch' },
  { name: 'a wrong CSRF token', csrf: () => 'wrong-token', status: 403, code: 'csrf_mismatch' },
  {
    name: 'another session’s CSRF token',
    csrf: () => SESSION_B.csrfToken,
    status: 403,
    code: 'csrf_mismatch',
  },
  {
    name: 'a cross-origin request',
    origin: () => 'https://evil.example',
    status: 403,
    code: 'origin_mismatch',
  },
  {
    name: 'a request without Origin',
    origin: () => undefined,
    status: 403,
    code: 'origin_mismatch',
  },
  {
    name: 'a snapshot with one flipped character',
    snapshot: (m) => flipMiddle(m.snapshot),
    status: 403,
    code: 'invalid_snapshot',
  },
  {
    name: 'a truncated snapshot',
    snapshot: (m) => m.snapshot.slice(0, -4),
    status: 403,
    code: 'invalid_snapshot',
  },
  {
    name: 'a snapshot without its MAC',
    snapshot: (m) => m.snapshot.split('.')[0]!,
    status: 403,
    code: 'invalid_snapshot',
  },
  {
    name: 'a snapshot with a forged payload and the original MAC',
    snapshot: (m) => forgeCount(m.snapshot),
    status: 403,
    code: 'invalid_snapshot',
  },
  {
    name: 'a snapshot replayed under another session',
    session: SESSION_B,
    csrf: () => SESSION_B.csrfToken,
    status: 403,
    code: 'invalid_snapshot',
  },
  {
    name: 'a session snapshot replayed anonymously',
    session: null,
    status: 403,
    code: 'invalid_snapshot',
  },
];

describe('component deny matrix: update endpoint', () => {
  for (const row of UPDATE_ROWS) {
    it(`${row.name} -> ${row.status}${row.code ? ` ${row.code}` : ''}`, async () => {
      currentSession = SESSION_A;
      const app = await makeApp();
      try {
        const mounted = await mount(app);
        currentSession = row.session === undefined ? SESSION_A : row.session;
        const origin = row.origin === undefined ? app.origin : row.origin(app);
        const csrf = row.csrf === undefined ? mounted.csrf : row.csrf(mounted);
        const snapshot = row.snapshot === undefined ? mounted.snapshot : row.snapshot(mounted);
        const response = await app.request(COMPONENT_UPDATE_ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(origin === undefined ? {} : { origin }),
            ...(csrf === undefined ? {} : { [COMPONENT_CSRF_HEADER]: csrf }),
          },
          body: JSON.stringify({
            snapshot,
            updates: {},
            sequence: 1,
            action: { name: 'increment', args: { by: 1 } },
          }),
        });
        assert.equal(response.status, row.status);
        assert.match(response.headers.get('cache-control') ?? '', /no-store/);
        const raw = await response.text();
        if (row.code === undefined) {
          assert.match(raw, />1<\/span>/);
        } else {
          const body = JSON.parse(raw) as { error: { code: string } };
          assert.equal(body.error.code, row.code);
          assert.ok(!raw.includes(KEY), 'a rejection must not echo the key');
          assert.ok(!raw.includes(snapshot), 'a rejection must not echo the token');
          assert.ok(!raw.includes('1000000'), 'a rejection must not run the forged state');
        }
      } finally {
        currentSession = SESSION_A;
        await app.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Upload and download endpoints
// ---------------------------------------------------------------------------

describe('component deny matrix: upload endpoint', () => {
  const rows: readonly { name: string; origin: string | undefined }[] = [
    { name: 'a cross-origin upload', origin: 'https://evil.example' },
    { name: 'an upload without Origin', origin: undefined },
  ];
  for (const row of rows) {
    it(`${row.name} -> 403 origin_mismatch before the body is read`, async () => {
      const app = await makeApp();
      try {
        const { snapshot, csrf } = await mount(app);
        const form = new FormData();
        form.set('snapshot', snapshot);
        form.set(
          'file',
          new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
          'a.png',
        );
        const response = await app.request(COMPONENT_UPLOAD_ENDPOINT, {
          method: 'POST',
          headers: {
            ...(row.origin === undefined ? {} : { origin: row.origin }),
            [COMPONENT_CSRF_HEADER]: csrf,
          },
          body: form,
        });
        assert.equal(response.status, 403);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(body.error.code, 'origin_mismatch');
      } finally {
        await app.close();
      }
    });
  }

  async function sameOriginUpload(
    app: TestApplication,
    tamper: (snapshot: string) => string,
  ): Promise<Response> {
    const { snapshot, csrf } = await mount(app);
    const form = new FormData();
    form.set('snapshot', tamper(snapshot));
    form.set(
      'file',
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
      'a.png',
    );
    return app.request(COMPONENT_UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: { origin: app.origin, [COMPONENT_CSRF_HEADER]: csrf },
      body: form,
    });
  }

  it('a same-origin upload with the untampered snapshot is accepted (control)', async () => {
    const app = await makeApp();
    try {
      const response = await sameOriginUpload(app, (snapshot) => snapshot);
      assert.equal(response.status, 201);
      const body = (await response.json()) as { reference?: unknown };
      assert.equal(typeof body.reference, 'string');
    } finally {
      await app.close();
    }
  });

  it('a same-origin upload with a tampered snapshot -> 403 invalid_snapshot', async () => {
    const app = await makeApp();
    try {
      const response = await sameOriginUpload(app, flipMiddle);
      assert.equal(response.status, 403);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'invalid_snapshot');
    } finally {
      await app.close();
    }
  });
});

describe('component deny matrix: download endpoint', () => {
  const rows: readonly { name: string; query: string; status: number }[] = [
    { name: 'no reference', query: '', status: 400 },
    { name: 'an empty reference', query: '?ref=', status: 400 },
    { name: 'a garbage reference', query: '?ref=not-a-token', status: 403 },
    { name: 'a reference with a forged MAC', query: '?ref=e30.AAAA', status: 403 },
  ];
  for (const row of rows) {
    it(`${row.name} -> ${row.status}`, async () => {
      const app = await makeApp();
      try {
        const response = await app.request(`${COMPONENT_DOWNLOAD_ENDPOINT}${row.query}`);
        assert.equal(response.status, row.status);
        assert.match(response.headers.get('cache-control') ?? '', /no-store/);
      } finally {
        await app.close();
      }
    });
  }
});
