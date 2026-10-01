/**
 * The generated deny matrix for the server-component lane boundary, over any
 * gate component: one cell for every lane in `LANES` and every reason in
 * `REJECTIONS`, each driving a real request through the runtime's route for
 * that lane and asserting the value-free answer. A snapshot lane's
 * cross-site cell goes through an app that mounts the runtime, because the
 * access chain in front of the transport route, not the lane, refuses it. The table is typed
 * `Record<Lane, Record<Rejection, …>>`, so a new lane or rejection reason
 * fails to compile until it has its cells, and a runtime check holds the
 * table's keys to the exported lists.
 *
 * The gate is built by a {@link GateFactory}, so the same matrix runs over a
 * component written in TSX (`component-lanes.test.ts`) and one compiled from
 * a `.jsails` live component (`compiler/sfc/live-lanes.test.ts`).
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import type { RequestContext, Session } from '../../src/contracts/http.js';
import type { ServerComponentDefinition } from '../../src/server-components/component.js';
import { runExtensions } from '../../src/extensions/index.js';
import { createApp } from '../../src/server/app.js';
import { createDownloadReferenceSigner } from '../../src/server-components/downloads.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';
import {
  COMPONENT_DOWNLOAD_ENDPOINT,
  COMPONENT_UPDATE_ENDPOINT,
  COMPONENT_UPLOAD_ENDPOINT,
  COMPONENT_UPLOAD_FILE_FIELD,
  COMPONENT_UPLOAD_SNAPSHOT_FIELD,
} from '../../src/server-components/protocol.js';
import { componentRegistryFromMap } from '../../src/server-components/registry.js';
import {
  ComponentAuthorizeErrors,
  LANES,
  REJECTIONS,
  createServerComponentsRuntime,
  type AddressLimiter,
  type Lane,
  type LaneLimits,
  type Rejection,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime/index.js';
import { HmacComponentSigner } from '../../src/server-components/snapshot.js';
import {
  createUploadReferenceSigner,
  type UploadStore,
} from '../../src/server-components/uploads.js';
import { updateBody } from './lane-calls.js';

/** The signing key of every fixture; a refusal must never echo it. */
export const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';
const SNAPSHOT_ID = 'instance-1';
const PAGE = Object.freeze({ path: '/gate', params: Object.freeze({ id: 'mine' }) });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

// ---------------------------------------------------------------------------
// Fixture: one gate whose authorize policy each cell sets
// ---------------------------------------------------------------------------

/** The authorize policy a cell gives the gate. */
export type Policy = 'scoped' | 'deny' | 'truthy' | 'throw' | 'hang';

/** What the gate delegates to: the cell's policy, and a count of its action's runs. */
export interface GateHooks {
  /** The gate's authorize: decided by the fixture's current {@link Policy}. */
  authorize(context: RequestContext): Promise<boolean>;
  /** Called when the gate's `ping` action runs. */
  ran(): void;
}

/**
 * Builds the gate a fixture's runtime serves: a component named `gate` with
 * state `{ count: number }`, an anonymous `image/png` upload policy, and a
 * `ping` action, whose authorize and action delegate to `hooks`.
 */
export type GateFactory = (hooks: GateHooks) => ServerComponentDefinition<any>;

/** One runtime serving the gate, with the policy its cell sets. */
export interface LaneFixture {
  runtime: ServerComponentsRuntime;
  readonly signer: HmacComponentSigner;
  policy: Policy;
  authorizeCalls: number;
  actionRuns: number;
  release(): void;
}

function memoryStore(): UploadStore {
  const files = new Map<string, Uint8Array>([['anon/file-1', new Uint8Array([1, 2, 3])]]);
  return {
    async put(input) {
      const chunks: Buffer[] = [];
      for await (const chunk of input.stream) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      files.set(`${input.subject ?? 'anon'}/${input.id}`, bytes);
      return { size: bytes.length };
    },
    async open(id, subject) {
      const bytes = files.get(`${subject ?? 'anon'}/${id}`);
      return bytes === undefined ? null : Readable.from([Buffer.from(bytes)]);
    },
    async delete(id, subject) {
      files.delete(`${subject ?? 'anon'}/${id}`);
    },
  };
}

/** A fresh runtime serving the gate `gateFor` builds, under the `scoped` policy. */
export function makeLaneFixture(
  gateFor: GateFactory,
  options: {
    readonly lane?: Lane;
    readonly limits?: Partial<LaneLimits>;
    readonly limiter?: AddressLimiter;
  } = {},
): LaneFixture {
  let open: () => void = () => undefined;
  let gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const fixture: LaneFixture = {
    runtime: undefined as unknown as ServerComponentsRuntime,
    signer: new HmacComponentSigner({ key: KEY }),
    policy: 'scoped',
    authorizeCalls: 0,
    actionRuns: 0,
    release() {
      open();
      gate = Promise.resolve();
    },
  };
  const gated = gateFor({
    // A params-scoped policy: the credential's page decides, on every lane,
    // including a download minted minutes earlier.
    async authorize(context) {
      fixture.authorizeCalls += 1;
      switch (fixture.policy) {
        case 'deny':
          return false;
        case 'truthy':
          // A truthy non-boolean is not an allow.
          return 'yes' as unknown as boolean;
        case 'throw':
          throw new Error('policy store unreachable');
        case 'hang':
          await gate;
          return true;
        case 'scoped':
          return context.params.id === 'mine';
      }
    },
    ran() {
      fixture.actionRuns += 1;
    },
  });
  fixture.runtime = createServerComponentsRuntime({
    components: componentRegistryFromMap({ gate: gated }),
    signer: fixture.signer,
    store: memoryStore(),
    uploads: { signer: createUploadReferenceSigner({ key: KEY }) },
    downloads: { signer: createDownloadReferenceSigner({ key: KEY }) },
    ...(options.lane === undefined || options.limits === undefined
      ? {}
      : { limits: { [options.lane]: options.limits } }),
    ...(options.limiter === undefined ? {} : { addressLimiter: options.limiter }),
  });
  return fixture;
}

// ---------------------------------------------------------------------------
// Requests: one valid request per lane, with the perturbations a cell applies
// ---------------------------------------------------------------------------

/** How a cell's request departs from a valid one. */
export interface Perturbation {
  /** Claims the credential is signed with (the defaults are a valid credential). */
  readonly component?: string;
  readonly subject?: string | null;
  readonly origin?: string;
  readonly params?: Readonly<Record<string, string>>;
  /** Corrupt the signed token. */
  readonly tamper?: boolean;
  /** Request headers: the `Origin` and `Sec-Fetch-Site`. */
  readonly requestOrigin?: string;
  readonly fetchSite?: string;
  /** Send a request the lane cannot read. */
  readonly malformed?: boolean;
}

function credentialFor(fixture: LaneFixture, lane: Lane, p: Perturbation): string {
  const claims = {
    component: p.component ?? 'gate',
    subject: p.subject === undefined ? null : p.subject,
    origin: p.origin ?? ORIGIN,
    page: { path: PAGE.path, params: p.params ?? PAGE.params },
  };
  const token =
    lane === 'download'
      ? createDownloadReferenceSigner({ key: KEY }).sign({
          ...claims,
          downloadId: 'file-1',
          filename: 'report.bin',
          contentType: 'application/octet-stream',
        })
      : fixture.signer.sign({ ...claims, v: 1, id: SNAPSHOT_ID, state: { count: 0 } });
  if (p.tamper !== true) {
    return token;
  }
  const index = Math.floor(token.length / 4);
  return `${token.slice(0, index)}${token[index] === 'A' ? 'B' : 'A'}${token.slice(index + 1)}`;
}

function snapshotHeaders(p: Perturbation): Record<string, string> {
  return {
    origin: p.requestOrigin ?? ORIGIN,
  };
}

function requestFor(fixture: LaneFixture, lane: Lane, p: Perturbation): Request {
  const token = credentialFor(fixture, lane, p);
  switch (lane) {
    case 'update':
    case 'refresh':
      return new Request(`${ORIGIN}${COMPONENT_UPDATE_ENDPOINT}`, {
        method: 'POST',
        headers: { ...snapshotHeaders(p), 'content-type': 'application/json' },
        body:
          p.malformed === true
            ? '[1, 2, 3]'
            : JSON.stringify(
                updateBody({
                  snapshot: token,
                  action: { name: lane === 'refresh' ? '$refresh' : 'ping' },
                }),
              ),
      });
    case 'upload': {
      const form = new FormData();
      if (p.malformed !== true) {
        form.set(COMPONENT_UPLOAD_SNAPSHOT_FIELD, token);
      }
      form.set(COMPONENT_UPLOAD_FILE_FIELD, new Blob([PNG], { type: 'image/png' }), 'a.png');
      return new Request(`${ORIGIN}${COMPONENT_UPLOAD_ENDPOINT}`, {
        method: 'POST',
        headers: snapshotHeaders(p),
        body: form,
      });
    }
    case 'download': {
      const url = new URL(COMPONENT_DOWNLOAD_ENDPOINT, ORIGIN);
      if (p.malformed !== true) {
        url.searchParams.set('ref', token);
      }
      return new Request(url, {
        headers: p.fetchSite === undefined ? {} : { 'sec-fetch-site': p.fetchSite },
      });
    }
  }
}

/** A route's answer to one cell's request. */
export interface Answer {
  readonly status: number;
  readonly code: string | undefined;
  readonly raw: string;
  readonly reported: readonly unknown[];
}

/** Drive one request of `lane`, perturbed by `p`, through the fixture's route for it. */
export async function sendLane(
  fixture: LaneFixture,
  lane: Lane,
  p: Perturbation,
  session: Session | null = null,
): Promise<Answer> {
  const request = requestFor(fixture, lane, p);
  const context: RequestContext = {
    request,
    url: new URL(request.url),
    params: {},
    session,
  };
  const reported: unknown[] = [];
  const route = lane === 'refresh' ? fixture.runtime.routes.update : fixture.runtime.routes[lane];
  const response = await route(request, context, (error) => {
    reported.push(error);
  });
  const raw = await response.text();
  const code = response.headers.get('content-type')?.startsWith('application/json')
    ? (JSON.parse(raw) as { error?: { code?: string } }).error?.code
    : undefined;
  return { status: response.status, code, raw, reported };
}

/**
 * Drive one request of `lane` through an app that mounts the fixture's
 * runtime, so the access chain in front of the transport route runs first.
 * The answer's code is the lane's wire code or the problem document's.
 */
export async function sendMounted(
  fixture: LaneFixture,
  lane: Lane,
  p: Perturbation,
): Promise<Answer> {
  const runtime = await runExtensions(
    [
      {
        name: 'lane-matrix',
        setup: ({ services }) => services.provide(serverComponentsToken, fixture.runtime),
      },
    ],
    { rootDir: import.meta.dirname },
  );
  const reported: unknown[] = [];
  const app = await createApp({
    manifest: { entries: [], byRoute: new Map() },
    services: runtime.services,
    onError: (error) => {
      reported.push(error);
    },
  });
  const response = await app.fetch(requestFor(fixture, lane, p));
  const raw = await response.text();
  const body = JSON.parse(raw) as { code?: string; error?: { code?: string } };
  return { status: response.status, code: body.error?.code ?? body.code, raw, reported };
}

/** Wait until the fixture's authorize has run `count` times. */
export async function authorizeEntered(fixture: LaneFixture, count = 1): Promise<void> {
  while (fixture.authorizeCalls < count) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

interface Expected {
  readonly status: number;
  readonly code: string;
}

/** How one cell provokes its rejection, returning the answer to check. */
type Cell = (lane: Lane) => Promise<Answer>;

/** The answers that differ by credential kind: snapshot lanes name the check, a download reads as one `forbidden`. */
function byKind(lane: Lane, snapshot: Expected, download: Expected): Expected {
  return lane === 'download' ? download : snapshot;
}

const FORBIDDEN: Expected = { status: 403, code: 'forbidden' };

/**
 * Declare the deny matrix over the gate `gateFor` builds, as the suite
 * `title`: a cell for every lane and every rejection reason, and each lane's
 * valid request as the control.
 */
export function describeLaneMatrix(title: string, gateFor: GateFactory): void {
  const CELLS: {
    readonly [R in Rejection]: { readonly provoke: Cell; expect(lane: Lane): Expected };
  } = {
    closed: {
      async provoke(lane) {
        const fixture = makeLaneFixture(gateFor);
        fixture.runtime.close();
        return sendLane(fixture, lane, {});
      },
      expect: () => ({ status: 503, code: 'unavailable' }),
    },
    rate_limited: {
      async provoke(lane) {
        const fixture = makeLaneFixture(gateFor, { limiter: { admit: () => false } });
        return sendLane(fixture, lane, {});
      },
      expect: () => ({ status: 429, code: 'rate_limited' }),
    },
    malformed: {
      async provoke(lane) {
        return sendLane(makeLaneFixture(gateFor), lane, { malformed: true });
      },
      expect: () => ({ status: 400, code: 'invalid_request' }),
    },
    credential: {
      async provoke(lane) {
        return sendLane(makeLaneFixture(gateFor), lane, { tamper: true });
      },
      expect: (lane) => byKind(lane, { status: 403, code: 'invalid_snapshot' }, FORBIDDEN),
    },
    origin: {
      async provoke(lane) {
        // A credential minted for another origin (another tenant host, say).
        return sendLane(makeLaneFixture(gateFor), lane, { origin: 'https://evil.example' });
      },
      expect: (lane) => byKind(lane, { status: 403, code: 'origin_mismatch' }, FORBIDDEN),
    },
    unknown_component: {
      async provoke(lane) {
        return sendLane(makeLaneFixture(gateFor), lane, { component: 'ghost' });
      },
      expect: () => ({ status: 404, code: 'unknown_component' }),
    },
    subject: {
      async provoke(lane) {
        const fixture = makeLaneFixture(gateFor);
        // A credential bound to a session, presented without one.
        return sendLane(fixture, lane, { subject: fixture.signer.subjectFor('session-other') });
      },
      expect: (lane) => byKind(lane, { status: 403, code: 'invalid_snapshot' }, FORBIDDEN),
    },
    cross_site: {
      async provoke(lane) {
        // A download navigation's own check; a snapshot lane's POST accepts the
        // session cookie, so the access chain in front of the mounted route
        // refuses it before the lane runs.
        const fixture = makeLaneFixture(gateFor);
        if (lane === 'download') return sendLane(fixture, lane, { fetchSite: 'cross-site' });
        const answer = await sendMounted(fixture, lane, { requestOrigin: 'https://evil.example' });
        assert.equal(fixture.authorizeCalls, 0, 'the lane never ran for a cross-site request');
        return answer;
      },
      expect: (lane) => byKind(lane, { status: 403, code: 'access.cross_site' }, FORBIDDEN),
    },
    busy: {
      async provoke(lane) {
        // The per-principal cap: both requests are the same anonymous client,
        // while the lane's runtime-wide cap keeps its default headroom.
        const fixture = makeLaneFixture(gateFor, {
          lane,
          limits: { maxConcurrentPerPrincipal: 1 },
        });
        fixture.policy = 'hang';
        const holder = sendLane(fixture, lane, {});
        await authorizeEntered(fixture);
        const refused = await sendLane(fixture, lane, {});
        fixture.release();
        assert.equal((await holder).status < 400, true, 'the slot holder completes');
        return refused;
      },
      expect: () => ({ status: 503, code: 'unavailable' }),
    },
    forbidden: {
      async provoke(lane) {
        const truthy = makeLaneFixture(gateFor);
        truthy.policy = 'truthy';
        const answer = await sendLane(truthy, lane, {});
        assert.equal(answer.code, 'forbidden', 'a truthy non-boolean authorize denies');
        // The policy is decided from the credential's page params: a
        // credential minted for another record's page is refused.
        return sendLane(makeLaneFixture(gateFor), lane, { params: { id: 'theirs' } });
      },
      expect: () => FORBIDDEN,
    },
    authorize_fault: {
      async provoke(lane) {
        const fixture = makeLaneFixture(gateFor);
        fixture.policy = 'throw';
        const answer = await sendLane(fixture, lane, {});
        assert.ok(
          answer.reported.some((error) => ComponentAuthorizeErrors.is(error, 'component_failed')),
          'the throwing authorize is reported',
        );
        return answer;
      },
      expect: () => ({ status: 503, code: 'unavailable' }),
    },
    deadline: {
      async provoke(lane) {
        const fixture = makeLaneFixture(gateFor, { lane, limits: { totalMs: 50 } });
        fixture.policy = 'hang';
        try {
          return await sendLane(fixture, lane, {});
        } finally {
          fixture.release();
        }
      },
      expect: () => ({ status: 503, code: 'timeout' }),
    },
  };

  const MATRIX: { readonly [L in Lane]: { readonly [R in Rejection]: (typeof CELLS)[R] } } =
    Object.fromEntries(LANES.map((lane) => [lane, CELLS])) as {
      readonly [L in Lane]: { readonly [R in Rejection]: (typeof CELLS)[R] };
    };

  describe(title, () => {
    it('has a cell for every lane and every rejection reason', () => {
      assert.deepEqual(Object.keys(MATRIX), [...LANES]);
      for (const lane of LANES) {
        assert.deepEqual(Object.keys(MATRIX[lane]), [...REJECTIONS], `cells for ${lane}`);
      }
    });

    for (const lane of LANES) {
      it(`${lane}: a valid request passes the boundary (control)`, async () => {
        const answer = await sendLane(makeLaneFixture(gateFor), lane, {});
        assert.equal(answer.status, lane === 'upload' ? 201 : 200, answer.raw);
      });

      for (const reason of REJECTIONS) {
        const cell = MATRIX[lane][reason];
        const expected = cell.expect(lane);
        it(`${lane} × ${reason} -> ${expected.status} ${expected.code}`, async () => {
          const answer = await cell.provoke(lane);
          assert.equal(answer.status, expected.status, answer.raw);
          assert.equal(answer.code, expected.code);
          assert.ok(!answer.raw.includes(KEY), 'a refusal never echoes the key');
          assert.ok(!answer.raw.includes('policy store'), 'a refusal never echoes the fault');
        });
      }
    }
  });
}
