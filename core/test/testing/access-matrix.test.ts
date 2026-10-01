/**
 * The access matrix over a fixture app built with `createApp`, and its
 * mutation-style self-test: a pipeline that admits a cross-site write through
 * a default-allow check, or runs route code after a denial, must fail the
 * hard invariants it breaks. A surface another route shadows is judged by
 * its own chain or reported, and the rules about cross-site requests and
 * refused credentials can hold together.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { legacyAccess, publicAccess, toAccessRef } from '../../src/api/access-ref.js';
import type { Session } from '../../src/contracts/http.js';
import { accessProbeOf } from '../../src/security/access-record.js';
import {
  attachSurfaces,
  createSurfaceRegistry,
  type SurfaceDescriptor,
} from '../../src/security/surfaces.js';
import { createApp } from '../../src/server/app.js';
import { identitySource } from '../../src/server/request-frame.js';
import { createTestApp } from '../../src/testing/app.js';
import {
  ACCESS_INVARIANTS,
  AccessMatrixErrors,
  accessMatrix,
  accessMatrixSession,
  canonicalActors,
  type AccessMatrixRow,
  type AccessViolation,
  type Persona,
} from '../../src/testing/index.js';
import { ACCESS_MATRIX_COOKIE } from '../../src/testing/canonical-actors.js';
import { appRoutes, writeFixture } from '../fixtures/app.js';

const EMPTY_MANIFEST = { entries: [], byRoute: new Map(), notFound: [] };

const ADMIN: Persona = {
  id: 'admin',
  carrier: 'cookie',
  data: { user: { id: 'a', role: 'admin' } },
};

/** Whether the session belongs to an administrator. */
function isAdmin(session: Session | null): boolean {
  const user: unknown = session?.data.user;
  return typeof user === 'object' && user !== null && Reflect.get(user, 'role') === 'admin';
}

/** The fixture app, and how many times any of its route code ran. */
async function fixtureApp(): Promise<{
  readonly app: Awaited<ReturnType<typeof createApp>>;
  ran(): number;
}> {
  let ran = 0;
  const handler = (): Response => {
    ran += 1;
    return new Response('route code');
  };
  const contributions = appRoutes((routes) => {
    routes.add({
      methods: ['GET'],
      path: '/open',
      access: publicAccess('open page'),
      credentials: [],
      handler,
    });
    routes.add({
      methods: ['GET'],
      path: '/feed',
      access: publicAccess('public feed'),
      cache: { maxAge: 60 },
      handler,
    });
    routes.add({
      methods: ['POST'],
      path: '/notes/:id',
      access: (context) => isAdmin(context.session),
      body: { kind: 'form', maxBytes: 1024 },
      handler,
    });
    routes.add({
      methods: ['POST'],
      path: '/signup',
      access: publicAccess('sign-up form'),
      body: { kind: 'form', maxBytes: 1024 },
      handler,
    });
    routes.add({
      methods: ['GET', 'POST'],
      path: '/reports',
      access: (context) => context.session !== null,
      credentials: ['cookie', 'token'],
      body: { kind: 'json', maxBytes: 1024 },
      handler,
    });
    routes.mount(
      '/raw',
      () => {
        ran += 1;
        return new Response('mounted');
      },
      { access: (context) => isAdmin(context.session) },
    );
  });
  const app = await createApp({
    manifest: EMPTY_MANIFEST,
    identity: identitySource({
      cookies: [ACCESS_MATRIX_COOKIE],
      headers: ['authorization'],
      resolve: accessMatrixSession,
    }),
    contributions,
    healthPath: '/up',
    onError: () => undefined,
  });
  return { app, ran: () => ran };
}

function rowsOf(rows: readonly AccessMatrixRow[], surface: string): readonly AccessMatrixRow[] {
  return rows.filter((row) => row.surface === surface);
}

function invariantsOf(violations: readonly AccessViolation[]): readonly string[] {
  return [...new Set(violations.map((violation) => violation.invariant))];
}

describe('accessMatrix over a createApp app', () => {
  it('asks every surface, method and actor, and runs no route code', async () => {
    const { app, ran } = await fixtureApp();
    const result = await accessMatrix(app, { personas: [ADMIN] });
    const actors = canonicalActors([ADMIN]).length;
    assert.equal(ran(), 0, 'the probe answers in the place of every route');
    for (const surface of result.surfaces) {
      const methods = surface.match.methods.filter((method) => method !== 'HEAD');
      const expected = methods.reduce(
        (total, method) => total + actors * (['GET', 'OPTIONS'].includes(method) ? 1 : 3),
        0,
      );
      assert.equal(rowsOf(result.rows, surface.id).length, expected, surface.id);
    }
    const admitted = result.rows.filter((row) => row.outcome === 'admitted');
    assert.ok(admitted.length > 0);
    assert.ok(admitted.every((row) => row.handlerInvoked));
  });

  it('reads no body byte and runs nothing for a denied request', async () => {
    const { app } = await fixtureApp();
    const { rows } = await accessMatrix(app, { personas: [ADMIN] });
    const denied = rows.filter((row) => row.outcome === 'denied');
    assert.ok(denied.length > 0);
    for (const row of denied) {
      assert.equal(row.handlerInvoked, false);
      assert.equal(row.bodyBytesRead, 0);
      assert.equal(row.setCookie, false);
      assert.match(row.cacheControl ?? '', /no-store/);
    }
    const crossSite = rowsOf(rows, 'POST /notes/:id').filter((row) => row.origin !== 'same');
    assert.ok(crossSite.every((row) => row.status === 403 && row.code === 'access.cross_site'));
    const adminWrite = rowsOf(rows, 'POST /notes/:id').find(
      (row) => row.actor === 'admin' && row.origin === 'same',
    );
    assert.equal(adminWrite?.outcome, 'admitted');
    assert.equal(adminWrite?.identified, true);
  });

  it('exempts a request a header token authenticated from the cross-site check', async () => {
    const { app } = await fixtureApp();
    const { rows } = await accessMatrix(app);
    const reportWrites = rowsOf(rows, 'GET,POST /reports').filter((row) => row.method === 'POST');
    const tokenForeign = reportWrites.find(
      (row) => row.actor === 'token-no-scope' && row.origin === 'foreign',
    );
    assert.equal(tokenForeign?.outcome, 'admitted');
    const cookieForeign = reportWrites.find(
      (row) => row.actor === 'user' && row.origin === 'foreign',
    );
    assert.equal(cookieForeign?.code, 'access.cross_site');
    const tokenOnCookieRoute = rowsOf(rows, 'POST /notes/:id').find(
      (row) => row.actor === 'token-no-scope' && row.origin === 'foreign',
    );
    assert.equal(
      tokenOnCookieRoute?.code,
      'access.cross_site',
      'a token the route refuses is no exemption',
    );
  });

  it('never calls the authenticator for a surface accepting no credential', async () => {
    const { app } = await fixtureApp();
    const { rows } = await accessMatrix(app);
    assert.ok(rowsOf(rows, 'GET /open').every((row) => !row.authenticatorInvoked));
    const user = rowsOf(rows, 'GET /feed').find((row) => row.actor === 'user');
    assert.equal(user?.authenticatorInvoked, true);
    assert.equal(user?.identified, true);
    assert.doesNotMatch(user?.cacheControl ?? '', /public/);
    const anonymous = rowsOf(rows, 'GET /feed').find((row) => row.actor === 'anonymous');
    assert.equal(anonymous?.authenticatorInvoked, false);
    assert.match(anonymous?.cacheControl ?? '', /public/);
  });

  it('holds every invariant but the ones today’s chain cannot', async () => {
    const { app } = await fixtureApp();
    const { violations } = await accessMatrix(app, { personas: [ADMIN] });
    assert.deepEqual(invariantsOf(violations), [
      'rejected-credential-401',
      'anonymous-write-rate-limited',
    ]);
    assert.deepEqual(
      violations
        .filter((violation) => violation.invariant === 'anonymous-write-rate-limited')
        .map((violation) => violation.surface),
      ['POST /signup'],
    );
  });

  it('records the same matrix, byte for byte, on a second run', async () => {
    const first = await accessMatrix((await fixtureApp()).app, { personas: [ADMIN] });
    const second = await accessMatrix((await fixtureApp()).app, { personas: [ADMIN] });
    const serialise = (result: typeof first): string =>
      JSON.stringify({ rows: result.rows, violations: result.violations });
    assert.equal(serialise(second), serialise(first));
  });

  it('reports a surface the app declares code-activating only when its plugins are locked', async () => {
    const { app } = await fixtureApp();
    const locked = await accessMatrix(app, { codeActivating: ['POST /notes/:id'] });
    assert.deepEqual(
      locked.violations.filter((violation) => violation.invariant === 'locked-no-code-activation'),
      [
        {
          invariant: 'locked-no-code-activation',
          surface: 'POST /notes/:id',
          method: null,
          actor: null,
          origin: null,
        },
      ],
    );
    const managed = await accessMatrix(app, {
      activation: 'managed',
      codeActivating: ['POST /notes/:id'],
    });
    assert.ok(
      managed.violations.every((violation) => violation.invariant !== 'locked-no-code-activation'),
    );
  });

  it('refuses a code-activating id that names no surface, value-free', async () => {
    const { app } = await fixtureApp();
    await assert.rejects(
      accessMatrix(app, { codeActivating: ['POST /notes/:id', 'POST /notes/renamed'] }),
      (error: unknown) =>
        AccessMatrixErrors.is(error, 'unknown_surface') &&
        !(error as Error).message.includes('renamed'),
    );
  });

  it('judges a surface no stage but its own chain answers, and lets a public, credential-free probe be answered first', async () => {
    const { app } = await fixtureApp();
    const { rows, violations } = await accessMatrix(app);
    const health = rowsOf(rows, 'GET,HEAD /up');
    assert.ok(health.length > 0);
    assert.ok(health.every((row) => row.outcome === 'answered' && row.decidedBy === null));
    assert.ok(
      rows
        .filter((row) => row.outcome !== 'answered')
        .every((row) => row.decidedBy === row.surface),
    );
    assert.ok(violations.every((violation) => violation.invariant !== 'own-chain-decides'));
  });

  it('lists each invariant once, with a rule', () => {
    const ids = ACCESS_INVARIANTS.map((invariant) => invariant.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ACCESS_INVARIANTS.every((invariant) => invariant.rule.length > 0));
  });
});

describe('accessMatrix over a TestApplication', () => {
  const distDir = fileURLToPath(new URL('../../', import.meta.url));
  const root = mkdtempSync(join(distDir, 'testing-access-matrix-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  writeFixture(
    root,
    'api/me.mjs',
    `export const authorize = ({ session }) => session !== null;
export const GET = () => Response.json({ ok: true });
`,
  );

  it('reads the surfaces of the application it assembles', async (t) => {
    const app = await createTestApp({
      config: { rootDir: root, port: 0, resolveSession: accessMatrixSession },
      lifecycle: t,
    });
    const { surfaces, rows, violations } = await accessMatrix(app);
    assert.ok(surfaces.some((surface) => surface.id === 'GET /api/me'));
    const anonymous = rowsOf(rows, 'GET /api/me').find((row) => row.actor === 'anonymous');
    assert.equal(anonymous?.status, 401);
    const user = rowsOf(rows, 'GET /api/me').find((row) => row.actor === 'user');
    assert.equal(user?.outcome, 'admitted');
    assert.deepEqual(
      violations.filter((violation) => violation.surface === 'GET /api/me'),
      [],
    );
  });
});

/** A surface as a registry freezes it. */
function surface(
  fields: Partial<SurfaceDescriptor> & Pick<SurfaceDescriptor, 'id'>,
): SurfaceDescriptor {
  return {
    kind: 'route',
    match: { methods: ['POST'], pattern: '/transfer' },
    access: publicAccess('mutant'),
    action: 'write',
    credentials: ['cookie'],
    owner: 'app',
    ...fields,
  };
}

/**
 * A pipeline over `descriptors` that answers every request with `answer`,
 * given the request's probe: a stand-in for a broken access chain.
 */
function mutantPipeline(
  descriptors: readonly SurfaceDescriptor[],
  answer: (request: Request, descriptor: SurfaceDescriptor) => Promise<Response>,
): { fetch(request: Request): Promise<Response> } {
  const registry = createSurfaceRegistry();
  const registered = descriptors.map((descriptor) => registry.add(descriptor));
  const pipeline = {
    fetch: (request: Request) => {
      const path = new URL(request.url).pathname;
      const target =
        registered.find((descriptor) => descriptor.match.pattern === path) ?? registered[0];
      assert.ok(target !== undefined);
      return answer(request, target);
    },
  };
  attachSurfaces(pipeline, registry);
  return pipeline;
}

describe('the self-test: a broken pipeline fails the matrix', () => {
  it('fails a default-allow check that admits a cross-site write', async () => {
    // A check function that admits everyone, as a route would state it.
    const allowAll = toAccessRef(() => true);
    assert.ok(allowAll !== undefined);
    const mutant = mutantPipeline(
      [surface({ id: 'POST /transfer', access: allowAll })],
      async (request, descriptor) => {
        const probe = accessProbeOf(request);
        assert.ok(probe !== undefined);
        return probe.reached({ surface: descriptor, anonymous: true });
      },
    );
    const broken = invariantsOf((await accessMatrix(mutant)).violations);
    for (const id of [
      'public-only-admits-anonymous',
      'cross-site-refused',
      'anonymous-write-rate-limited',
    ]) {
      assert.ok(broken.includes(id), `${id} is reported`);
    }
  });

  it('fails a pipeline that runs route code and reads the body after a denial', async () => {
    const mutant = mutantPipeline(
      [surface({ id: 'POST /transfer' })],
      async (request, descriptor) => {
        const probe = accessProbeOf(request);
        assert.ok(probe !== undefined);
        probe.denied(descriptor, 'request.forbidden');
        await request.arrayBuffer();
        const response = probe.reached({ surface: descriptor, anonymous: true });
        response.headers.set('set-cookie', 'leaked=1');
        return response;
      },
    );
    const broken = invariantsOf((await accessMatrix(mutant)).violations);
    for (const id of ['denied-before-handler', 'denied-no-store']) {
      assert.ok(broken.includes(id), `${id} is reported`);
    }
  });

  it('fails a connection surface that admits a foreign origin', async () => {
    const connection = surface({
      id: 'GET /socket',
      kind: 'connection',
      match: { methods: ['GET'], pattern: '/socket' },
    });
    const mutant = mutantPipeline([connection], async (request, descriptor) => {
      const probe = accessProbeOf(request);
      assert.ok(probe !== undefined);
      return probe.reached({ surface: descriptor, anonymous: true });
    });
    await assert.rejects(accessMatrix(mutant), (error: unknown) =>
      AccessMatrixErrors.is(error, 'missing_probe'),
    );
    const { violations } = await accessMatrix(mutant, {
      probes: { connection: () => ({ path: '/socket', headers: { upgrade: 'websocket' } }) },
    });
    assert.ok(invariantsOf(violations).includes('connection-origin-and-host'));
  });

  it('fails a management surface that accepts a token', async () => {
    const mutant = mutantPipeline(
      [surface({ id: 'POST /transfer', kind: 'admin', credentials: ['cookie', 'token'] })],
      async () => new Response(null, { status: 403 }),
    );
    const { violations } = await accessMatrix(mutant);
    assert.ok(
      violations.some(
        (violation) => violation.invariant === 'tokenless-management' && violation.actor === null,
      ),
    );
  });
});

describe('a surface another route shadows', () => {
  /** An app of `register`'s routes, with the matrix's sessions. */
  function shadowApp(register: Parameters<typeof appRoutes>[0]): ReturnType<typeof createApp> {
    return createApp({
      manifest: EMPTY_MANIFEST,
      identity: identitySource({
        cookies: [ACCESS_MATRIX_COOKIE],
        headers: ['authorization'],
        resolve: accessMatrixSession,
      }),
      contributions: appRoutes(register),
      onError: () => undefined,
    });
  }

  it('reaches a wildcard route an earlier parameter route shadows at one segment', async () => {
    const handler = (): Response => new Response('route code');
    const app = await shadowApp((routes) => {
      routes.add({
        methods: ['GET'],
        path: '/docs/:slug',
        access: (context) => context.session !== null,
        handler,
      });
      // A check that admits everyone: the exposure the matrix must see.
      routes.add({ methods: ['GET'], path: '/docs/*', access: () => true, handler });
    });
    const { rows, violations } = await accessMatrix(app);
    const wildcard = rowsOf(rows, 'GET /docs/*');
    assert.ok(wildcard.length > 0);
    assert.ok(wildcard.every((row) => row.decidedBy === 'GET /docs/*'));
    assert.equal(wildcard.find((row) => row.actor === 'anonymous')?.outcome, 'admitted');
    assert.ok(
      violations.some(
        (violation) =>
          violation.invariant === 'public-only-admits-anonymous' &&
          violation.surface === 'GET /docs/*',
      ),
    );
  });

  it('reports a surface its probe cannot reach, and judges it by no other rule', async () => {
    const handler = (): Response => new Response('route code');
    const app = await shadowApp((routes) => {
      routes.add({
        methods: ['GET'],
        path: '/files/:name',
        access: (context) => isAdmin(context.session),
        handler,
      });
      routes.add({
        methods: ['GET'],
        path: '/files/:id',
        access: publicAccess('shadowed by /files/:name'),
        handler,
      });
    });
    const { rows, violations } = await accessMatrix(app);
    const shadowed = rowsOf(rows, 'GET /files/:id');
    assert.ok(shadowed.length > 0);
    assert.ok(shadowed.every((row) => row.decidedBy === 'GET /files/:name'));
    const onShadowed = violations.filter((violation) => violation.surface === 'GET /files/:id');
    assert.deepEqual(invariantsOf(onShadowed), ['own-chain-decides']);
    assert.equal(onShadowed.length, shadowed.length);
  });

  it('fails a surface that is not public and credential-free when a stage before its chain answers it', async () => {
    const mutant = mutantPipeline(
      [
        surface({
          id: 'GET /status',
          match: { methods: ['GET'], pattern: '/status' },
          credentials: [],
        }),
        surface({
          id: 'GET /account',
          match: { methods: ['GET'], pattern: '/account' },
          access: legacyAccess(() => true),
        }),
      ],
      async () => new Response('answered before the chain'),
    );
    const { violations } = await accessMatrix(mutant);
    const owned = violations.filter((violation) => violation.invariant === 'own-chain-decides');
    assert.ok(owned.length > 0);
    assert.ok(owned.every((violation) => violation.surface === 'GET /account'));
  });
});

describe('the cross-site and refused-credential rules', () => {
  /** Whether `request` carries a credential the matrix's authenticator must refuse. */
  function presentsRejected(request: Request): boolean {
    return (
      (request.headers.get('cookie') ?? '').includes(`${ACCESS_MATRIX_COOKIE}=rejected`) ||
      request.headers.get('authorization') === 'Bearer access-matrix.rejected'
    );
  }

  /** Whether `request` names the matrix's app origin, or says it is same-origin. */
  function sameOrigin(request: Request): boolean {
    const origin = request.headers.get('origin');
    return origin === null
      ? request.headers.get('sec-fetch-site') === 'same-origin'
      : origin === 'http://localhost';
  }

  /** A denial as the chain renders one: no-store, no cookie. */
  function denial(status: number, code: string): Response {
    return Response.json({ code }, { status, headers: { 'cache-control': 'private, no-store' } });
  }

  /**
   * A cookie-and-token write surface behind a chain that answers a refused
   * credential (401) and a cross-site request (403) in `order`.
   */
  function chain(order: 'refused-first' | 'cross-site-first'): {
    fetch(request: Request): Promise<Response>;
  } {
    return mutantPipeline(
      [
        surface({
          id: 'POST /transfer',
          access: legacyAccess(({ session }) => session !== null),
          credentials: ['cookie', 'token'],
        }),
      ],
      async (request, descriptor) => {
        const probe = accessProbeOf(request);
        assert.ok(probe !== undefined);
        const bearer = (request.headers.get('authorization') ?? '').startsWith('Bearer ');
        const crossSite = !bearer && !sameOrigin(request);
        const refused = presentsRejected(request);
        for (const stage of order === 'refused-first'
          ? (['refused', 'cross-site'] as const)
          : (['cross-site', 'refused'] as const)) {
          if (stage === 'refused' && refused) {
            probe.denied(descriptor, 'request.unauthenticated');
            return denial(401, 'request.unauthenticated');
          }
          if (stage === 'cross-site' && crossSite) {
            probe.denied(descriptor, 'access.cross_site');
            return denial(403, 'access.cross_site');
          }
        }
        const anonymous = request.headers.get('cookie') === null && !bearer;
        if (anonymous) {
          probe.denied(descriptor, 'request.unauthenticated');
          return denial(401, 'request.unauthenticated');
        }
        return probe.reached({ surface: descriptor, anonymous: false });
      },
    );
  }

  /** The invariants of the two rules `violations` breaks. */
  function crossSiteAndRefused(violations: readonly AccessViolation[]): readonly string[] {
    return invariantsOf(violations).filter(
      (id) => id === 'cross-site-refused' || id === 'rejected-credential-401',
    );
  }

  it('both hold for a chain that answers a refused credential 401 before the cross-site check', async () => {
    const { rows, violations } = await accessMatrix(chain('refused-first'));
    const refusedForeign = rows.find(
      (row) => row.actor === 'rejected-cookie' && row.origin === 'foreign',
    );
    assert.equal(refusedForeign?.status, 401);
    assert.deepEqual(crossSiteAndRefused(violations), []);
  });

  it("report only the refused credential's 401 for a chain that checks the origin first", async () => {
    const { violations } = await accessMatrix(chain('cross-site-first'));
    assert.deepEqual(crossSiteAndRefused(violations), ['rejected-credential-401']);
  });

  it('still fail a cross-site request a credential-free caller is answered 401 for', async () => {
    const mutant = mutantPipeline(
      [surface({ id: 'POST /transfer', access: legacyAccess(() => false) })],
      async (request, descriptor) => {
        const probe = accessProbeOf(request);
        assert.ok(probe !== undefined);
        probe.denied(descriptor, 'request.unauthenticated');
        return denial(401, 'request.unauthenticated');
      },
    );
    const { violations } = await accessMatrix(mutant);
    assert.ok(
      violations.some(
        (violation) =>
          violation.invariant === 'cross-site-refused' &&
          violation.actor === 'anonymous' &&
          violation.origin === 'foreign',
      ),
    );
  });
});

describe('accessMatrix inputs', () => {
  it('refuses a target whose surfaces it cannot read', async () => {
    await assert.rejects(accessMatrix({ fetch: () => new Response(null) }), (error: unknown) =>
      AccessMatrixErrors.is(error, 'unsupported_target'),
    );
  });

  for (const [label, persona, problem] of [
    ['an id that is not a lowercase name', { ...ADMIN, id: 'Admin' }, 'invalid_id'],
    ['an id naming a canonical actor', { ...ADMIN, id: 'anonymous' }, 'duplicate_id'],
    ['a carrier that is not cookie or token', { ...ADMIN, carrier: 'basic' }, 'invalid_carrier'],
    ['data that is not an object', { ...ADMIN, data: [] }, 'invalid_data'],
  ] as const) {
    it(`refuses a persona with ${label}, value-free`, () => {
      assert.throws(
        () => canonicalActors([persona as unknown as Persona]),
        (error: unknown) =>
          AccessMatrixErrors.is(error, 'invalid_persona') &&
          (error as Error).message.includes(problem) &&
          !(error as Error).message.includes('Admin'),
      );
    });
  }

  it('gives each canonical actor its credential and session', () => {
    const actors = canonicalActors();
    assert.deepEqual(
      actors.map((actor) => `${actor.id}:${actor.carrier}${actor.rejected ? ':rejected' : ''}`),
      [
        'anonymous:none',
        'user:cookie',
        'unverified:cookie',
        'non-mfa:cookie',
        'stale-authz:cookie',
        'token-no-scope:token',
        'token-exact-scope:token',
        'token-wrong-tenant:token',
        'cookie-and-bearer:cookie+token',
        'rejected-cookie:cookie:rejected',
        'rejected-token:token:rejected',
      ],
    );
    const exact = actors.find((actor) => actor.id === 'token-exact-scope');
    const session = exact?.session(surface({ id: 'POST /transfer' }));
    assert.deepEqual(session?.data.scopes, ['app:write']);
    assert.equal(session?.data.authMethod, 'api-token');
  });
});
