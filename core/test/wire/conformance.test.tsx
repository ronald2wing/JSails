/**
 * Wire conformance: the browser controller against the real runtime. Every
 * reply the server gives in a fixture table is parsed by the shared parser,
 * and a real `ComponentController`, whose fetch is the runtime's own update
 * route, ends each scenario in the outcome the protocol states.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import {
  ComponentController,
  ComponentControllerError,
  type ComponentRender,
} from '../../src/client/component-controller.js';
import type { RequestContext } from '../../src/contracts/http.js';
import { defineAction, defineServerComponent } from '../../src/server-components/component.js';
import {
  COMPONENT_RENDER_ATTRIBUTE,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  COMPONENT_UPDATE_ENDPOINT,
} from '../../src/server-components/protocol.js';
import { componentRegistryFromMap } from '../../src/server-components/registry.js';
import {
  createServerComponentsRuntime,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime/index.js';
import { HmacComponentSigner } from '../../src/server-components/snapshot.js';
import {
  COMPONENT_PROTOCOL_VERSION,
  MAX_HAVE_SLOTS_BYTES,
  parseUpdateResponse,
  type ComponentUpdateResponse,
} from '../../src/wire/protocol.js';

const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';

const counter = defineServerComponent<{ count: number; title: string }>({
  name: 'counter',
  stateSchema: z.object({ count: z.number(), title: z.string().min(1) }).strict(),
  writableKeys: ['title'],
  initialState: () => ({ count: 0, title: 'hello' }),
  authorize: () => true,
  actions: {
    increment: defineAction({
      run(state) {
        state.count += 1;
      },
    }),
    refuse: defineAction({
      authorize: () => false,
      run() {},
    }),
  },
  render: (state) => (
    <p>
      {state.title}:{state.count}
    </p>
  ),
});

function runtimeOf(): ServerComponentsRuntime {
  return createServerComponentsRuntime({
    components: componentRegistryFromMap({ counter }),
    signer: new HmacComponentSigner({ key: KEY }),
  });
}

function context(request: Request): RequestContext {
  return { request, url: new URL(request.url), params: {}, session: null };
}

function attr(html: string, name: string): string {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(match, `expected ${name}`);
  return match[1]!;
}

interface Wire {
  readonly controller: ComponentController;
  readonly replies: (ComponentUpdateResponse | null)[];
  readonly statuses: number[];
  readonly renders: ComponentRender[];
  readonly errors: ComponentControllerError[];
}

/** A controller over a freshly mounted counter, wired to the runtime's update route. */
async function wire(
  runtime: ServerComponentsRuntime,
  options: { readonly slots?: number } = {},
): Promise<Wire> {
  const html = await runtime.render('counter', context(new Request(`${ORIGIN}/`)));
  const replies: (ComponentUpdateResponse | null)[] = [];
  const statuses: number[] = [];
  const renders: ComponentRender[] = [];
  const errors: ComponentControllerError[] = [];
  const controller = new ComponentController({
    snapshot: attr(html, COMPONENT_SNAPSHOT_ATTRIBUTE),
    render: attr(html, COMPONENT_RENDER_ATTRIBUTE),
    origin: ORIGIN,
    heldSlots: () =>
      Array.from({ length: options.slots ?? 0 }, (_, index) => ({
        slot: `k:item-${index}`,
        component: 'card',
      })),
    fetch: async (url, init) => {
      const request = new Request(new URL(url, ORIGIN), {
        method: init.method,
        headers: { ...init.headers, origin: ORIGIN },
        body: init.body,
      });
      const response = await runtime.routes.update(request, context(request), () => {});
      const text = await response.text();
      statuses.push(response.status);
      replies.push(parseUpdateResponse(JSON.parse(text)));
      return new Response(text, { status: response.status, headers: response.headers });
    },
    onRender: (render) => {
      renders.push(render);
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  return { controller, replies, statuses, renders, errors };
}

/** POST a raw body to the update route, returning the status and the parsed reply. */
async function post(
  runtime: ServerComponentsRuntime,
  body: unknown,
): Promise<{ status: number; reply: ComponentUpdateResponse | null }> {
  const request = new Request(`${ORIGIN}${COMPONENT_UPDATE_ENDPOINT}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await runtime.routes.update(request, context(request), () => {});
  return { status: response.status, reply: parseUpdateResponse(await response.json()) };
}

describe('update wire conformance', () => {
  it('render: an action re-renders, and the controller morphs it with its new tag', async () => {
    const w = await wire(runtimeOf());
    const result = await w.controller.commit('increment');
    assert.equal(result.status, 'applied');
    assert.equal(w.statuses[0], 200);
    assert.equal(w.replies[0]?.kind, 'render');
    assert.equal(w.renders.length, 1);
    assert.match(w.renders[0]!.html, /hello:1/);
    assert.equal(w.controller.render, w.renders[0]!.render);
  });

  it('unchanged: an idle refresh applies nothing and fires no render', async () => {
    const w = await wire(runtimeOf());
    const token = w.controller.snapshot;
    const result = await w.controller.refresh();
    assert.equal(result.status, 'unchanged');
    assert.deepEqual(w.replies[0], { kind: 'unchanged', sequence: 1 });
    assert.equal(w.renders.length, 0);
    assert.equal(w.controller.snapshot, token);
  });

  it('invalid: a rejected edit re-renders with errors and keeps the token', async () => {
    const w = await wire(runtimeOf());
    const token = w.controller.snapshot;
    w.controller.setField('title', '');
    const result = await w.controller.commit('increment');
    assert.equal(result.status, 'invalid');
    assert.equal(w.statuses[0], 422);
    assert.equal(w.replies[0]?.kind, 'invalid');
    assert.equal(w.controller.snapshot, token);
    assert.equal(w.controller.render, w.renders[0]!.render);
  });

  it('error: a refused action blocks the controller', async () => {
    const w = await wire(runtimeOf());
    await assert.rejects(w.controller.commit('refuse'), ComponentControllerError);
    assert.equal(w.statuses[0], 403);
    assert.equal(w.replies[0]?.kind, 'error');
    assert.equal(w.controller.blocked, true);
    assert.equal(w.errors[0]?.code, 'unexpected_status');
  });

  it('too_many_children: the controller refuses before sending, and the server agrees', async () => {
    const runtime = runtimeOf();
    const w = await wire(runtime, { slots: 1000 });
    await assert.rejects(
      w.controller.refresh(),
      (error: unknown) =>
        error instanceof ComponentControllerError && error.code === 'too_many_children',
    );
    assert.equal(w.replies.length, 0);

    const slots = Array.from({ length: 1000 }, (_, index) => ({
      slot: `k:item-${index}`,
      component: 'card',
    }));
    assert.ok(JSON.stringify(slots).length > MAX_HAVE_SLOTS_BYTES);
    const { status, reply } = await post(runtime, {
      v: COMPONENT_PROTOCOL_VERSION,
      sequence: 4,
      snapshot: w.controller.snapshot,
      updates: {},
      have: { render: null, slots },
    });
    assert.equal(status, 400);
    assert.equal(reply?.kind === 'error' && reply.error.code, 'too_many_children');
    assert.equal(reply?.sequence, 4);
  });

  it('protocol_mismatch: a request of another version is told the version spoken', async () => {
    const runtime = runtimeOf();
    for (const body of [
      { snapshot: 'a.b', updates: {}, sequence: 5 },
      { v: 1, snapshot: 'a.b', updates: {}, sequence: 5 },
    ]) {
      const { status, reply } = await post(runtime, body);
      assert.equal(status, 400);
      assert.deepEqual(reply, { kind: 'protocol_mismatch', sequence: 5, v: 2 });
    }
  });

  it('every reply in the table parses', async () => {
    const runtime = runtimeOf();
    const w = await wire(runtime);
    await w.controller.commit('increment');
    await w.controller.refresh();
    w.controller.setField('title', '');
    await w.controller.commit('increment');
    assert.deepEqual(
      w.replies.map((reply) => reply?.kind ?? null),
      ['render', 'unchanged', 'invalid'],
    );
  });
});
