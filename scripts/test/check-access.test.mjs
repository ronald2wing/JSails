/**
 * The access gate's judgement: violations become `<app>:<invariant>` ids, an
 * unlisted one fails with its rows, a pending one that holds now fails until
 * its entry is removed, and a starter's auth plugin is given the matrix's
 * session resolver. The gate also fails a matrix that went blind: an app
 * that resolves sessions with no identified caller, a route-registration
 * surface no app judged, and an undeclared code-activating surface.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  accessApps,
  codeActivationFailures,
  coverageFailures,
  hasSessionSeam,
  identityFailures,
  judge,
  main,
  STARTER_PRESETS,
  violationIds,
  withMatrixSessions,
} from '../check-access.mjs';

const root = mkdtempSync(join(tmpdir(), 'check-access-'));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'scripts', 'gates'), { recursive: true });
mkdirSync(join(root, 'scripts', 'expected-failures'), { recursive: true });
writeFileSync(join(root, 'scripts', 'gates', 'access.mjs'), '');

/** Write the pending ledger with `ids`. */
function ledger(ids) {
  writeFileSync(
    join(root, 'scripts', 'expected-failures', 'access.json'),
    JSON.stringify({
      description: 'pending access invariants',
      kind: 'gate',
      gate: 'access',
      entries: ids.map((id) => ({ id, reason: 'not yet', fixedBy: 'SEC-07' })),
    }),
  );
}

/** One violation of `invariant` on `surface`, shown by a request row. */
function violation(invariant, surface = 'POST /api/login') {
  return { invariant, surface, method: 'POST', actor: 'rejected-cookie', origin: 'same' };
}

/** A surface descriptor as a registry holds it. */
function surface(id, fields = {}) {
  return {
    id,
    kind: 'route',
    match: { methods: [id.split(' ')[0]], pattern: id.split(' ')[1] },
    access: { kind: 'legacy', reason: '' },
    action: 'write',
    credentials: ['cookie'],
    owner: 'auth',
    ...fields,
  };
}

/** A row of `actor` on `surfaceId`, identified or not. */
function row(surfaceId, actor, identified) {
  return { surface: surfaceId, actor, identified, outcome: 'admitted' };
}

const LOGIN = surface('POST /api/login');

const matrices = [
  {
    name: 'auth',
    surfaces: [LOGIN],
    rows: [row('POST /api/login', 'admin', true)],
    violations: [violation('rejected-credential-401'), violation('rejected-credential-401')],
    sessionSeam: true,
    codeActivating: [],
    ms: 1,
  },
  {
    name: 'blog',
    surfaces: [],
    rows: [],
    violations: [],
    sessionSeam: true,
    codeActivating: [],
    ms: 1,
  },
];

/** The route-registration app's surfaces the matrices above cover. */
const snapshot = [LOGIN];

describe('access gate', () => {
  it('names each app and invariant a matrix violates once', () => {
    assert.deepEqual(violationIds(matrices), ['auth:rejected-credential-401']);
  });

  it('passes when every violation is pending', () => {
    ledger(['auth:rejected-credential-401']);
    assert.deepEqual(judge(root, matrices, snapshot), []);
  });

  it('fails an unlisted violation with its rows', () => {
    ledger([]);
    const failures = judge(root, matrices, snapshot);
    assert.match(failures[0] ?? '', /^auth:rejected-credential-401 is violated and not pending/);
    assert.equal(
      failures[1],
      '    auth: rejected-credential-401 on POST /api/login POST as rejected-cookie (same origin)',
    );
  });

  it('fails a pending invariant that holds now', () => {
    ledger(['auth:rejected-credential-401', 'blog:anonymous-write-rate-limited']);
    assert.deepEqual(judge(root, matrices, snapshot), [
      'fixed: blog:anonymous-write-rate-limited holds now; remove it from scripts/expected-failures/access.json',
    ]);
  });

  it('reports every app with its request count and time', async () => {
    ledger(['auth:rejected-credential-401']);
    const result = await main({
      root,
      collect: async () => matrices,
      snapshot: async () => snapshot,
    });
    assert.deepEqual(result, {
      status: 0,
      messages: [
        'auth: 1 requests, 2 violation(s), 1 ms',
        'blog: 0 requests, 0 violation(s), 1 ms',
      ],
    });
  });

  it('judges every first-party fixture and each starter preset that serves HTTP', () => {
    const names = accessApps().map((app) => app.name);
    assert.deepEqual(
      names.filter((name) => name.startsWith('starter-')),
      STARTER_PRESETS.map((preset) => `starter-${preset}`),
    );
    assert.ok(!names.includes('starter-cli'), 'the CLI preset serves no HTTP');
    assert.equal(new Set(names).size, names.length);
  });

  it("gives a starter's auth plugin the matrix's session resolver, and nothing else", async () => {
    const resolve = async (request) => ({ id: request.url, data: {}, expiresAt: 0 });
    const config = {
      rootDir: '.',
      plugins: {
        activation: { mode: 'locked' },
        use: [['@jsails/auth', { registration: { enabled: true } }], '@jsails/cache'],
      },
    };
    const wired = withMatrixSessions(config, resolve);
    const [auth, cache] = wired.plugins.use;
    assert.equal(cache, '@jsails/cache');
    assert.equal(auth[0], '@jsails/auth');
    assert.deepEqual(auth[1].registration, { enabled: true });
    const session = await auth[1].sessionResolver(new Request('http://localhost/probe'));
    assert.equal(session.id, 'http://localhost/probe');
    assert.deepEqual(wired.plugins.activation, { mode: 'locked' });
    assert.equal(config.plugins.use[0][1].sessionResolver, undefined, 'the config is not mutated');
    assert.equal(withMatrixSessions({ rootDir: '.' }, resolve).rootDir, '.');
  });

  it("gives an auth plugin named by its specifier alone the matrix's resolver", async () => {
    const resolve = async (request) => ({ id: request.url, data: {}, expiresAt: 0 });
    const wired = withMatrixSessions({ plugins: { use: ['@jsails/auth'] } }, resolve);
    const [auth] = wired.plugins.use;
    assert.equal(auth[0], '@jsails/auth');
    const session = await auth[1].sessionResolver(new Request('http://localhost/alone'));
    assert.equal(session.id, 'http://localhost/alone');
  });

  it('refuses an auth plugin given as an instance, which the resolver cannot reach', () => {
    for (const name of ['auth', '@jsails/auth']) {
      assert.throws(
        () => withMatrixSessions({ plugins: { use: [{ name, setup() {} }] } }, async () => null),
        /auth plugin as an instance/,
      );
    }
  });

  it('knows an app resolves sessions by its resolver, identity source or auth plugin', () => {
    assert.equal(hasSessionSeam({ rootDir: '.' }), false);
    assert.equal(hasSessionSeam({ plugins: { use: ['@jsails/cache'] } }), false);
    assert.equal(hasSessionSeam({ resolveSession: () => null }), true);
    assert.equal(hasSessionSeam({ identity: {} }), true);
    assert.equal(hasSessionSeam({ plugins: { use: ['@jsails/auth'] } }), true);
    assert.equal(hasSessionSeam({ plugins: { use: [['@jsails/auth', {}]] } }), true);
    assert.equal(hasSessionSeam({ plugins: { use: [{ name: 'auth' }] } }), true);
  });
});

describe('a blind matrix fails the gate', () => {
  const TOKENS = surface('GET /api/me', { credentials: ['cookie', 'token'], owner: 'app' });

  it('fails an app that resolves sessions and identified no caller of a credential it accepts', () => {
    const blind = {
      name: 'starter-admin',
      surfaces: [LOGIN, TOKENS],
      rows: [
        row('POST /api/login', 'admin', false),
        row('GET /api/me', 'token-exact-scope', false),
      ],
      sessionSeam: true,
    };
    const failures = identityFailures(blind);
    assert.equal(failures.length, 2);
    assert.match(failures[0] ?? '', /^starter-admin: no admin request was identified/);
    assert.match(failures[1] ?? '', /^starter-admin: no token-exact-scope request was identified/);
  });

  it('passes an app whose callers were identified, one without a session seam, and a credential no surface accepts', () => {
    assert.deepEqual(
      identityFailures({
        name: 'starter-admin',
        surfaces: [LOGIN, TOKENS],
        rows: [
          row('POST /api/login', 'admin', true),
          row('GET /api/me', 'token-exact-scope', true),
        ],
        sessionSeam: true,
      }),
      [],
    );
    assert.deepEqual(
      identityFailures({
        name: 'starter-starter',
        surfaces: [LOGIN],
        rows: [],
        sessionSeam: false,
      }),
      [],
    );
    assert.deepEqual(
      identityFailures({
        name: 'auth',
        surfaces: [LOGIN],
        rows: [row('POST /api/login', 'admin', true)],
        sessionSeam: true,
      }),
      [],
    );
  });

  it('fails a route-registration surface no matrix judged, or judged as registered differently', () => {
    const webhook = surface('POST /webhooks/payments', {
      kind: 'webhook',
      credentials: [],
      access: { kind: 'public', reason: 'signed' },
      owner: 'webhook',
    });
    assert.deepEqual(coverageFailures([LOGIN], matrices), []);
    const [missing] = coverageFailures([LOGIN, webhook], matrices);
    assert.match(
      missing ?? '',
      /^POST \/webhooks\/payments surface=webhook credentials=none access=public webhook is registered by the route-registration snapshot app and judged by no access-matrix app/,
    );
    const asCookie = surface('POST /api/login', { credentials: [] });
    assert.equal(coverageFailures([asCookie], matrices).length, 1, 'other credentials');
  });

  it('fails a known code-activating surface the app does not declare', () => {
    const plugins = surface('POST /admin/plugins', { kind: 'admin', owner: 'admin' });
    const app = { name: 'starter-admin', surfaces: [LOGIN, plugins], codeActivating: [] };
    assert.deepEqual(codeActivationFailures(app), [
      'starter-admin: registers POST /admin/plugins, which activates plugin code, without declaring it codeActivating',
    ]);
    assert.deepEqual(
      codeActivationFailures({ ...app, codeActivating: ['POST /admin/plugins'] }),
      [],
    );
  });

  it('fails the gate on each of them', async () => {
    ledger(['auth:rejected-credential-401']);
    const blind = { ...matrices[0], rows: [row('POST /api/login', 'admin', false)] };
    const result = await main({
      root,
      collect: async () => [blind, matrices[1]],
      snapshot: async () => [LOGIN, surface('POST /api/logout')],
    });
    assert.equal(result.status, 1);
    assert.ok(
      result.messages.some((message) => /^auth: no admin request was identified/.test(message)),
    );
    assert.ok(result.messages.some((message) => /^POST \/api\/logout surface=route/.test(message)));
  });
});
