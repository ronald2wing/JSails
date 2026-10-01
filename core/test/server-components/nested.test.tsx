/**
 * Nested component tests.
 *
 * These tests cover `src/server-components/nested.ts`: `defineNestedComponent`
 * validation, `renderNested` with a real runtime (child gets independent
 * snapshot, CSRF, and id), child `authorize` denial, runtime-not-found errors,
 * and static fallback paths.
 *
 * Uses the same in-memory signer and runtime factory pattern as
 * `server-component-runtime.test.tsx`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import type { RequestContext } from '../../src/contracts/http.js';
import {
  defineAction,
  defineServerComponent,
  type ServerComponentDefinition,
} from '../../src/server-components/component.js';
import {
  defineNestedComponent,
  MAX_NESTING_DEPTH,
  NestedComponentError,
  renderNested,
} from '../../src/server-components/nested.js';
import {
  COMPONENT_ATTRIBUTE,
  COMPONENT_NAME_ATTRIBUTE,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_CSRF_HEADER,
  MAX_NESTED_SNAPSHOT_LENGTH,
  MAX_NESTED_SNAPSHOTS,
  MAX_NESTED_SNAPSHOTS_TOTAL_LENGTH,
  NESTED_SLOT_ATTRIBUTE,
  type ComponentNestedSnapshot,
} from '../../src/server-components/protocol.js';
import {
  createServerComponentsRuntime,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime/index.js';
import { HmacComponentSigner } from '../../src/server-components/snapshot.js';
import { createServiceRegistry } from '../../src/extensions/services.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';

const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';

// Preact VNode generic doesn't expose dangerouslySetInnerHTML in its props
// type for intrinsic elements; this helper extracts the inner HTML safely.
function getNestedHtml(vnode: any): string {
  return vnode.props.dangerouslySetInnerHTML.__html as string;
}

function getNestedProp(vnode: any, key: string): unknown {
  return vnode.props[key];
}

// ---------------------------------------------------------------------------
// Child components
// ---------------------------------------------------------------------------

type CardState = { label: string; count: number };

const card = defineServerComponent<CardState>({
  name: 'card',
  stateSchema: z.object({ label: z.string(), count: z.number() }).strict(),
  writableKeys: ['label'],
  initialState() {
    return { label: 'default', count: 0 };
  },
  authorize() {
    return true;
  },
  actions: {
    increment: defineAction({
      run(state) {
        state.count += 1;
      },
    }),
  },
  render(state, { bind }) {
    // JSX is compiled by the test runner; we use plain function calls.
    return (
      <div>
        <span id="child-label">{state.label}</span>
        <span id="child-count">{state.count}</span>
        <input {...bind('label')} />
      </div>
    );
  },
});

const childDenied = defineServerComponent({
  name: 'child-denied',
  stateSchema: z.object({}).strict(),
  initialState() {
    return {};
  },
  authorize() {
    return false;
  },
  render() {
    return null;
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime(
  components: Readonly<Record<string, ServerComponentDefinition<any>>>,
): ServerComponentsRuntime {
  return createServerComponentsRuntime({
    components,
    signer: new HmacComponentSigner({ key: KEY, now: () => 0 }),
  });
}

function makeRequest(url: string): Request {
  return new Request(url);
}

/**
 * Build a RequestContext that carries a service registry with the runtime
 * registered, so renderNested can resolve it.
 */
function nestedContext(runtime: ServerComponentsRuntime, path = '/'): RequestContext {
  const url = new URL(path, ORIGIN);
  const controller = createServiceRegistry();
  controller.registrar.provide(serverComponentsToken, runtime);
  controller.seal();

  return {
    request: makeRequest(url.toString()),
    url,
    params: {},
    session: null,
    services: controller.services,
  };
}

function extractAttr(html: string, name: string): string {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(match, `expected attribute ${name} in HTML: ${html}`);
  return match[1]!;
}

// ---------------------------------------------------------------------------
// defineNestedComponent validation
// ---------------------------------------------------------------------------

describe('defineNestedComponent', () => {
  it('rejects null', () => {
    assert.throws(() => defineNestedComponent(null as unknown as any), NestedComponentError);
  });

  it('rejects non-object', () => {
    assert.throws(() => defineNestedComponent(42 as unknown as any), NestedComponentError);
  });

  it('rejects empty component name', () => {
    assert.throws(
      () => defineNestedComponent({ name: 'div', component: '' }),
      NestedComponentError,
    );
  });

  it('rejects empty tag name', () => {
    assert.throws(
      () => defineNestedComponent({ name: '', component: 'card' }),
      NestedComponentError,
    );
  });

  it('rejects invalid tag name', () => {
    assert.throws(
      () => defineNestedComponent({ name: '123bad', component: 'card' }),
      NestedComponentError,
    );
  });

  it('accepts valid tag with optional key', () => {
    const config = defineNestedComponent({ name: 'section', component: 'card', key: 'my-key' });
    assert.equal(config.tag, 'section');
    assert.equal(config.component, 'card');
    assert.equal(config.key, 'my-key');
  });

  it('returns a frozen object', () => {
    const config = defineNestedComponent({ name: 'div', component: 'card' });
    assert.throws(() => {
      (config as any).tag = 'span';
    });
  });

  it('key is absent when omitted', () => {
    const config = defineNestedComponent({ name: 'div', component: 'card' });
    assert.equal(config.key, undefined);
  });
});

// ---------------------------------------------------------------------------
// renderNested with real runtime
// ---------------------------------------------------------------------------

describe('renderNested', () => {
  it('renders a child component with its own snapshot and markers', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await renderNested('card', ctx);

    assert.ok(vnode.type === 'div');
    assert.ok(getNestedHtml(vnode) !== undefined);
    const html = getNestedHtml(vnode);

    // The child carries its own component-root markers.
    assert.ok(html.includes(`${COMPONENT_ATTRIBUTE}="card"`));
    assert.ok(html.includes(`${COMPONENT_NAME_ATTRIBUTE}="card"`));
    // It has its own snapshot token.
    const childSnapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    assert.ok(childSnapshot.length > 0);
    // It has its own CSRF token.
    const childCsrf = extractAttr(html, COMPONENT_CSRF_ATTRIBUTE);
    assert.ok(childCsrf.length > 0);
  });

  it('renders child content (label/count in initial state)', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await renderNested('card', ctx);
    const html = getNestedHtml(vnode);

    assert.ok(html.includes('default'));
    assert.ok(html.includes('>0<'));
  });

  it('accepts a string name (default div wrapper)', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await renderNested('card', ctx);
    assert.equal(vnode.type, 'div');
  });

  it('accepts a NestedComponentConfig with custom tag', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const config = defineNestedComponent({ name: 'section', component: 'card' });
    const vnode = await renderNested(config, ctx);
    assert.equal(vnode.type, 'section');
  });

  it('places data-nested-key on the wrapper when key is set', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const config = defineNestedComponent({ name: 'div', component: 'card', key: 'child-1' });
    const vnode = await renderNested(config, ctx);
    assert.equal(getNestedProp(vnode, 'data-nested-key'), 'child-1');
  });

  it('child state is independent — two renders produce distinct tokens', async () => {
    const runtime = makeRuntime({ card });
    const ctx1 = nestedContext(runtime);
    const ctx2 = nestedContext(runtime);

    const vnode1 = await renderNested('card', ctx1);
    const vnode2 = await renderNested('card', ctx2);

    const snap1 = extractAttr(getNestedHtml(vnode1), COMPONENT_SNAPSHOT_ATTRIBUTE);
    const snap2 = extractAttr(getNestedHtml(vnode2), COMPONENT_SNAPSHOT_ATTRIBUTE);
    assert.notEqual(snap1, snap2);
  });

  it('a child with a failing authorize throws NestedComponentError', async () => {
    const runtime = makeRuntime({ 'child-denied': childDenied });
    const ctx = nestedContext(runtime);
    await assert.rejects(() => renderNested('child-denied', ctx), NestedComponentError);
  });
});

// ---------------------------------------------------------------------------
// renderNested error paths
// ---------------------------------------------------------------------------

describe('renderNested errors', () => {
  it('stops a self-nesting component at the maximum depth', async () => {
    let renders = 0;
    const recursive = defineServerComponent({
      name: 'recursive',
      stateSchema: z.object({}).strict(),
      initialState() {
        return {};
      },
      authorize() {
        return true;
      },
      async render(_state, { context }) {
        renders += 1;
        return renderNested('recursive', context);
      },
    });
    const runtime = makeRuntime({ recursive });
    await assert.rejects(
      renderNested('recursive', nestedContext(runtime)),
      (error: unknown) => error instanceof NestedComponentError && error.code === 'too_deep',
    );
    assert.equal(renders, MAX_NESTING_DEPTH);
  });

  it('throws when no runtime is registered on the context', async () => {
    // Build a context with no services.
    const bareContext: RequestContext = {
      request: makeRequest(`${ORIGIN}/`),
      url: new URL(ORIGIN),
      params: {},
      session: null,
    };
    await assert.rejects(() => renderNested('card', bareContext), NestedComponentError);
  });

  it('throws for an unknown component name', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    await assert.rejects(() => renderNested('nonexistent', ctx), NestedComponentError);
  });

  it('throws when the name string is invalid', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    await assert.rejects(() => renderNested(42 as unknown as string, ctx), NestedComponentError);
  });
});

// ---------------------------------------------------------------------------
// Integration: child snapshots are independently verified
// ---------------------------------------------------------------------------

describe('child snapshot independence', () => {
  it('child snapshot carries its own component name, not the parent', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await renderNested('card', ctx);
    const html = getNestedHtml(vnode);
    assert.ok(html.includes(`${COMPONENT_ATTRIBUTE}="card"`));
  });

  it('child snapshot is signed and carries an id', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await renderNested('card', ctx);
    const html = getNestedHtml(vnode);

    // Extract the snapshot token: it is a base64url payload.signature pair.
    const snap = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    const parts = snap.split('.');
    assert.equal(parts.length, 2);
    assert.ok(parts[0]!.length > 0);
    assert.ok(parts[1]!.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Child state across a parent update
// ---------------------------------------------------------------------------

interface ChildFixture {
  readonly components: Record<string, ServerComponentDefinition<any>>;
  readonly calls: { initialState: number; mount: number; authorize: number };
  allow: boolean;
}

/**
 * A parent `board` rendering a keyed `card`, an unkeyed `card`, and an unkeyed
 * `shelf` that itself nests a `card`; `card` counts its lifecycle calls.
 */
function childFixture(): ChildFixture {
  const fixture: ChildFixture = {
    components: {},
    calls: { initialState: 0, mount: 0, authorize: 0 },
    allow: true,
  };
  const countingCard = defineServerComponent<CardState>({
    name: 'card',
    stateSchema: z.object({ label: z.string(), count: z.number() }).strict(),
    writableKeys: ['label'],
    initialState() {
      fixture.calls.initialState += 1;
      return { label: 'default', count: 0 };
    },
    mount() {
      fixture.calls.mount += 1;
    },
    authorize() {
      fixture.calls.authorize += 1;
      return fixture.allow;
    },
    actions: {
      increment: defineAction({
        run(state) {
          state.count += 1;
        },
      }),
    },
    render(state) {
      return <span class="count">{state.count}</span>;
    },
  });
  const shelf = defineServerComponent({
    name: 'shelf',
    stateSchema: z.object({}).strict(),
    initialState: () => ({}),
    authorize: () => true,
    async render(_state, { context }) {
      return <div>{await renderNested('card', context)}</div>;
    },
  });
  const board = defineServerComponent<{ title: string }>({
    name: 'board',
    stateSchema: z.object({ title: z.string().min(1) }).strict(),
    writableKeys: ['title'],
    initialState: () => ({ title: 'board' }),
    authorize: () => true,
    async render(_state, { context }) {
      const keyed = defineNestedComponent({ name: 'section', component: 'card', key: 'main' });
      return (
        <div>
          {await renderNested(keyed, context)}
          {await renderNested('card', context)}
          {await renderNested('shelf', context)}
        </div>
      );
    },
  });
  fixture.components.card = countingCard;
  fixture.components.shelf = shelf;
  fixture.components.board = board;
  return fixture;
}

/** The first child root's snapshot and CSRF after the wrapper carrying `slot`. */
function childAt(
  html: string,
  slot: string,
  from = 0,
): { snapshot: string; csrf: string; html: string } {
  const start = html.indexOf(`${NESTED_SLOT_ATTRIBUTE}="${slot}"`, from);
  assert.ok(start !== -1, `expected slot ${slot} in HTML: ${html}`);
  const rest = html.slice(start);
  return {
    snapshot: extractAttr(rest, COMPONENT_SNAPSHOT_ATTRIBUTE),
    csrf: extractAttr(rest, COMPONENT_CSRF_ATTRIBUTE),
    html: rest,
  };
}

/** The `count` text the first card after `slot` renders. */
function countAt(html: string, slot: string, from = 0): string {
  const match = childAt(html, slot, from).html.match(/<span class="count">(\d+)<\/span>/);
  assert.ok(match);
  return match[1]!;
}

function postContext(runtime: ServerComponentsRuntime, csrf: string): RequestContext {
  const base = nestedContext(runtime);
  return {
    ...base,
    request: new Request(base.url.toString(), {
      method: 'POST',
      headers: { origin: ORIGIN, [COMPONENT_CSRF_HEADER]: csrf },
    }),
  };
}

async function mountBoard(runtime: ServerComponentsRuntime): Promise<{
  html: string;
  snapshot: string;
  csrf: string;
}> {
  const html = await runtime.render('board', nestedContext(runtime));
  return {
    html,
    snapshot: extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE),
    csrf: extractAttr(html, COMPONENT_CSRF_ATTRIBUTE),
  };
}

/** Increment a card through its own update, returning its new token. */
async function incrementCard(
  runtime: ServerComponentsRuntime,
  child: { snapshot: string; csrf: string },
): Promise<string> {
  const result = await runtime.update(
    { snapshot: child.snapshot, updates: {}, sequence: 1, action: { name: 'increment' } },
    postContext(runtime, child.csrf),
  );
  assert.equal(result.status, 200);
  return result.body.snapshot!;
}

async function updateBoard(
  runtime: ServerComponentsRuntime,
  board: { snapshot: string; csrf: string },
  children: unknown,
  updates: Record<string, unknown> = { title: 'next' },
): Promise<{ status: number; html: string | undefined; error: string | undefined }> {
  const payload: Record<string, unknown> = { snapshot: board.snapshot, updates, sequence: 1 };
  if (children !== undefined) {
    payload.children = children;
  }
  const result = await runtime.update(payload, postContext(runtime, board.csrf));
  return { status: result.status, html: result.body.html, error: result.body.error?.code };
}

describe('nested child state across a parent update', () => {
  it('marks each wrapper with a keyed or positional slot', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const { html } = await mountBoard(runtime);
    assert.ok(html.includes(`${NESTED_SLOT_ATTRIBUTE}="k:main"`));
    assert.ok(html.includes(`${NESTED_SLOT_ATTRIBUTE}="p:card:0"`));
    assert.ok(html.includes(`${NESTED_SLOT_ATTRIBUTE}="p:shelf:0"`));
  });

  it('restores keyed and positional children from their snapshots', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const keyedToken = await incrementCard(runtime, childAt(board.html, 'k:main'));
    const positionalToken = await incrementCard(runtime, childAt(board.html, 'p:card:0'));
    const before = { ...fixture.calls };

    const result = await updateBoard(runtime, board, [
      { slot: 'k:main', snapshot: keyedToken },
      { slot: 'p:card:0', snapshot: positionalToken },
    ]);

    assert.equal(result.status, 200);
    const html = result.html!;
    assert.equal(countAt(html, 'k:main'), '1');
    assert.equal(countAt(html, 'p:card:0'), '1');
    // A restored child keeps its token verbatim.
    assert.equal(childAt(html, 'k:main').snapshot, keyedToken);
    assert.equal(childAt(html, 'p:card:0').snapshot, positionalToken);
    // Only the shelf's card (offered nothing) mounted; every card was authorized.
    assert.equal(fixture.calls.initialState - before.initialState, 1);
    assert.equal(fixture.calls.mount - before.mount, 1);
    assert.equal(fixture.calls.authorize - before.authorize, 3);
  });

  it('restores a grandchild through its parent child entry', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const shelfIndex = board.html.indexOf(`${NESTED_SLOT_ATTRIBUTE}="p:shelf:0"`);
    const shelf = childAt(board.html, 'p:shelf:0');
    const grandchildToken = await incrementCard(
      runtime,
      childAt(board.html, 'p:card:0', shelfIndex),
    );

    const result = await updateBoard(runtime, board, [
      {
        slot: 'p:shelf:0',
        snapshot: shelf.snapshot,
        children: [{ slot: 'p:card:0', snapshot: grandchildToken }],
      },
    ]);

    const html = result.html!;
    const restoredShelf = html.indexOf(`${NESTED_SLOT_ATTRIBUTE}="p:shelf:0"`);
    assert.equal(childAt(html, 'p:shelf:0').snapshot, shelf.snapshot);
    assert.equal(countAt(html, 'p:card:0', restoredShelf), '1');
    // The board's own unkeyed card was offered nothing and mounted fresh.
    assert.equal(countAt(html, 'p:card:0'), '0');
  });

  it('mounts the subtree fresh under a child whose own snapshot is rejected', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const shelfIndex = board.html.indexOf(`${NESTED_SLOT_ATTRIBUTE}="p:shelf:0"`);
    const shelf = childAt(board.html, 'p:shelf:0');
    const grandchildToken = await incrementCard(
      runtime,
      childAt(board.html, 'p:card:0', shelfIndex),
    );
    const tampered = `${shelf.snapshot.slice(0, -2)}${shelf.snapshot.endsWith('AA') ? 'BB' : 'AA'}`;
    // A card's token offered for the shelf's slot names another component.
    const otherComponent = childAt(board.html, 'k:main').snapshot;

    for (const snapshot of [tampered, otherComponent]) {
      const before = fixture.calls.initialState;
      const result = await updateBoard(runtime, board, [
        {
          slot: 'p:shelf:0',
          snapshot,
          children: [{ slot: 'p:card:0', snapshot: grandchildToken }],
        },
      ]);

      assert.equal(result.status, 200);
      const html = result.html!;
      const freshShelf = html.indexOf(`${NESTED_SLOT_ATTRIBUTE}="p:shelf:0"`);
      assert.notEqual(childAt(html, 'p:shelf:0').snapshot, shelf.snapshot);
      // The grandchild offer is not honored under a shelf that mounted fresh.
      assert.equal(countAt(html, 'p:card:0', freshShelf), '0');
      assert.notEqual(childAt(html, 'p:card:0', freshShelf).snapshot, grandchildToken);
      // All three cards (keyed, positional, and the shelf's) ran initialState.
      assert.equal(fixture.calls.initialState - before, 3);
    }
  });

  it('keeps children through a 422 re-render', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const keyedToken = await incrementCard(runtime, childAt(board.html, 'k:main'));

    const result = await updateBoard(runtime, board, [{ slot: 'k:main', snapshot: keyedToken }], {
      title: '',
    });

    assert.equal(result.status, 422);
    assert.equal(countAt(result.html!, 'k:main'), '1');
  });

  it('re-mounts every child for a request without children (older clients)', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const keyed = childAt(board.html, 'k:main');
    await incrementCard(runtime, keyed);
    const before = fixture.calls.initialState;

    const result = await updateBoard(runtime, board, undefined);

    assert.equal(result.status, 200);
    assert.equal(countAt(result.html!, 'k:main'), '0');
    assert.notEqual(childAt(result.html!, 'k:main').snapshot, keyed.snapshot);
    assert.equal(fixture.calls.initialState - before, 3);
  });

  it('mounts fresh for a tampered, foreign, misplaced, or wrong-component snapshot', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const keyedToken = await incrementCard(runtime, childAt(board.html, 'k:main'));

    const tampered = `${keyedToken.slice(0, -2)}${keyedToken.endsWith('AA') ? 'BB' : 'AA'}`;
    const foreignRuntime = createServerComponentsRuntime({
      components: fixture.components,
      signer: new HmacComponentSigner({ key: 'f'.repeat(32), now: () => 0 }),
    });
    const foreign = await incrementCard(
      foreignRuntime,
      childAt((await mountBoard(foreignRuntime)).html, 'k:main'),
    );
    // A card signed on another page never carries over.
    const elsewhereHtml = await runtime.render('card', nestedContext(runtime, '/elsewhere'));
    const elsewhere = extractAttr(elsewhereHtml, COMPONENT_SNAPSHOT_ATTRIBUTE);
    // The shelf's snapshot offered for a card slot names the wrong component.
    const shelfToken = childAt(board.html, 'p:shelf:0').snapshot;

    for (const snapshot of [tampered, foreign, elsewhere, shelfToken]) {
      const result = await updateBoard(runtime, board, [{ slot: 'k:main', snapshot }]);
      assert.equal(result.status, 200);
      assert.equal(countAt(result.html!, 'k:main'), '0');
      assert.notEqual(childAt(result.html!, 'k:main').snapshot, snapshot);
    }
  });

  it('a snapshot offered under another slot restores only that slot', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const keyedToken = await incrementCard(runtime, childAt(board.html, 'k:main'));

    // Two entries for one slot: only the first is used, once.
    const result = await updateBoard(runtime, board, [
      { slot: 'p:card:0', snapshot: keyedToken },
      { slot: 'p:card:0', snapshot: 'ignored.token' },
    ]);

    assert.equal(result.status, 200);
    assert.equal(countAt(result.html!, 'p:card:0'), '1');
    assert.equal(countAt(result.html!, 'k:main'), '0');
  });

  it('still runs authorize for a restored child', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const keyedToken = await incrementCard(runtime, childAt(board.html, 'k:main'));
    fixture.allow = false;

    const result = await updateBoard(runtime, board, [{ slot: 'k:main', snapshot: keyedToken }]);

    // The denied child fails the parent's render, as a fresh mount would.
    assert.equal(result.status, 500);
    assert.equal(result.error, 'internal_error');
  });

  it('rejects an offer over the count, length, or shape bounds', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const entry = (index: number): ComponentNestedSnapshot => ({
      slot: `p:card:${index}`,
      snapshot: 'a.b',
    });
    const tooMany = Array.from({ length: MAX_NESTED_SNAPSHOTS + 1 }, (_, index) => entry(index));
    // Two tokens that each fit, but whose slots and tokens together are one
    // character over the combined allowance.
    const atTotal = [
      { slot: 'k:a', snapshot: 'x'.repeat(MAX_NESTED_SNAPSHOT_LENGTH) },
      {
        slot: 'k:b',
        snapshot: 'x'.repeat(MAX_NESTED_SNAPSHOTS_TOTAL_LENGTH - MAX_NESTED_SNAPSHOT_LENGTH - 6),
      },
    ];
    const overTotal = [atTotal[0]!, { ...atTotal[1]!, snapshot: `${atTotal[1]!.snapshot}x` }];
    const tooManyNested = [
      {
        ...entry(0),
        children: Array.from({ length: MAX_NESTED_SNAPSHOTS }, (_, index) => entry(index)),
      },
    ];
    const offers: unknown[] = [
      tooMany,
      tooManyNested,
      [{ slot: 'k:main', snapshot: 'x'.repeat(MAX_NESTED_SNAPSHOT_LENGTH + 1) }],
      overTotal,
      [{ slot: 's'.repeat(257), snapshot: 'a.b' }],
      [{ slot: '', snapshot: 'a.b' }],
      [{ slot: 'k:main' }],
      [{ slot: 'k:main', snapshot: 'a.b', children: {} }],
      ['k:main'],
      { slot: 'k:main', snapshot: 'a.b' },
    ];
    for (const children of offers) {
      const result = await updateBoard(runtime, board, children);
      assert.equal(result.status, 400);
      assert.equal(result.error, 'invalid_request');
    }
    // Exactly at the bound is accepted.
    const atBound = Array.from({ length: MAX_NESTED_SNAPSHOTS }, (_, index) => entry(index));
    assert.equal((await updateBoard(runtime, board, atBound)).status, 200);
    assert.equal((await updateBoard(runtime, board, atTotal)).status, 200);
  });
});
