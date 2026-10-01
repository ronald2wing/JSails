/**
 * Nested component tests.
 *
 * These tests cover `src/server-components/nested.ts`: `defineNestedComponent`
 * validation, `renderNested` with a real runtime (child gets independent
 * snapshot and id), child `authorize` denial, runtime-not-found errors,
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
  COMPONENT_ROOT_ID_PREFIX,
  NESTED_COMPONENT_ATTRIBUTE,
  NESTED_KEEP_ATTRIBUTE,
  NESTED_SLOT_ATTRIBUTE,
  NESTED_WRAPPER_ID_PREFIX,
} from '../../src/server-components/protocol.js';
import {
  MAX_HAVE_SLOTS_BYTES,
  MAX_SLOT_LENGTH,
  haveSlotsByteLength,
  type ComponentHeldSlot,
} from '../../src/wire/protocol.js';
import {
  createServerComponentsRuntime,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime/index.js';
import { HmacComponentSigner } from '../../src/server-components/snapshot.js';
import { createServiceRegistry } from '../../src/extensions/services.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';
import { componentRegistryFromMap } from '../../src/server-components/registry.js';
import { callUpdate, updateBody } from './lane-calls.js';

const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';

// Preact VNode generic doesn't expose dangerouslySetInnerHTML in its props
// type for intrinsic elements; this helper extracts the inner HTML safely.
function getNestedHtml(vnode: any): string {
  return vnode.props.dangerouslySetInnerHTML.__html as string;
}

/** `renderNested`'s element for an allowed child; fails the test on `null`. */
async function nestedVNode(
  ...args: Parameters<typeof renderNested>
): Promise<NonNullable<Awaited<ReturnType<typeof renderNested>>>> {
  const vnode = await renderNested(...args);
  assert.ok(vnode !== null, 'expected an allowed child');
  return vnode;
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
    components: componentRegistryFromMap(components),
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
    const vnode = await nestedVNode('card', ctx);

    assert.ok(vnode.type === 'div');
    assert.ok(getNestedHtml(vnode) !== undefined);
    const html = getNestedHtml(vnode);

    // The child carries its own component-root markers.
    assert.ok(html.includes(`${COMPONENT_ATTRIBUTE}="card"`));
    assert.ok(html.includes(`${COMPONENT_NAME_ATTRIBUTE}="card"`));
    // It has its own snapshot token.
    const childSnapshot = extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE);
    assert.ok(childSnapshot.length > 0);
  });

  it('renders child content (label/count in initial state)', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await nestedVNode('card', ctx);
    const html = getNestedHtml(vnode);

    assert.ok(html.includes('default'));
    assert.ok(html.includes('>0<'));
  });

  it('accepts a string name (default div wrapper)', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await nestedVNode('card', ctx);
    assert.equal(vnode.type, 'div');
  });

  it('accepts a NestedComponentConfig with custom tag', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const config = defineNestedComponent({ name: 'section', component: 'card' });
    const vnode = await nestedVNode(config, ctx);
    assert.equal(vnode.type, 'section');
  });

  it('marks no slot on a child rendered outside a component render', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const config = defineNestedComponent({ name: 'div', component: 'card', key: 'child-1' });
    const vnode = await nestedVNode(config, ctx);
    assert.deepEqual(Object.keys(vnode.props as object), ['dangerouslySetInnerHTML']);
  });

  it('child state is independent — two renders produce distinct tokens', async () => {
    const runtime = makeRuntime({ card });
    const ctx1 = nestedContext(runtime);
    const ctx2 = nestedContext(runtime);

    const vnode1 = await nestedVNode('card', ctx1);
    const vnode2 = await nestedVNode('card', ctx2);

    const snap1 = extractAttr(getNestedHtml(vnode1), COMPONENT_SNAPSHOT_ATTRIBUTE);
    const snap2 = extractAttr(getNestedHtml(vnode2), COMPONENT_SNAPSHOT_ATTRIBUTE);
    assert.notEqual(snap1, snap2);
  });

  it('a child whose authorize denies renders nothing', async () => {
    const runtime = makeRuntime({ 'child-denied': childDenied });
    const ctx = nestedContext(runtime);
    assert.equal(await renderNested('child-denied', ctx), null);
  });

  it('a child whose authorize throws fails the render', async () => {
    const throwing = defineServerComponent({
      name: 'child-throws',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize() {
        throw new Error('policy store down');
      },
      render: () => null,
    });
    const runtime = makeRuntime({ 'child-throws': throwing });
    await assert.rejects(() => renderNested('child-throws', nestedContext(runtime)));
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
    const vnode = await nestedVNode('card', ctx);
    const html = getNestedHtml(vnode);
    assert.ok(html.includes(`${COMPONENT_ATTRIBUTE}="card"`));
  });

  it('child snapshot is signed and carries an id', async () => {
    const runtime = makeRuntime({ card });
    const ctx = nestedContext(runtime);
    const vnode = await nestedVNode('card', ctx);
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
// Child identity across a parent update
// ---------------------------------------------------------------------------

interface ChildFixture {
  readonly components: Record<string, ServerComponentDefinition<any>>;
  readonly calls: { initialState: number; mount: number; authorize: number; render: number };
  allow: boolean;
}

/**
 * A parent `board` rendering a keyed `card`, an unkeyed `card`, and an unkeyed
 * `shelf` that itself nests a `card`; `card` counts its lifecycle calls. The
 * board's `refresh-main` and `refresh-all` actions ask the client to refresh
 * kept children.
 */
function childFixture(): ChildFixture {
  const fixture: ChildFixture = {
    components: {},
    calls: { initialState: 0, mount: 0, authorize: 0, render: 0 },
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
      fixture.calls.render += 1;
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
    actions: {
      'refresh-main': defineAction({
        run(_state, _input, context) {
          context.refreshChild('main');
          context.refreshChild('absent');
        },
      }),
      'refresh-all': defineAction({
        run(_state, _input, context) {
          context.refreshChildren();
        },
      }),
    },
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

/** The HTML from the wrapper carrying `slot` onward. */
function fromSlot(html: string, slot: string, from = 0): string {
  const start = html.indexOf(`${NESTED_SLOT_ATTRIBUTE}="${slot}"`, from);
  assert.ok(start !== -1, `expected slot ${slot} in HTML: ${html}`);
  return html.slice(start);
}

/** The first child root's snapshot after the wrapper carrying `slot`. */
function childAt(html: string, slot: string, from = 0): { snapshot: string } {
  const rest = fromSlot(html, slot, from);
  return {
    snapshot: extractAttr(rest, COMPONENT_SNAPSHOT_ATTRIBUTE),
  };
}

/** The wrapper element carrying `slot`, open tag through its first child content. */
function wrapperAt(html: string, slot: string): string {
  const start = html.lastIndexOf('<', html.indexOf(`${NESTED_SLOT_ATTRIBUTE}="${slot}"`));
  return html.slice(start);
}

/** True when the wrapper carrying `slot` holds the keep marker as its whole content. */
function isKept(html: string, slot: string): boolean {
  const wrapper = wrapperAt(html, slot);
  const open = wrapper.indexOf('>') + 1;
  return wrapper.startsWith(`<template ${NESTED_KEEP_ATTRIBUTE}></template></`, open);
}

/** The `count` text the first card after `slot` renders. */
function countAt(html: string, slot: string, from = 0): string {
  const match = fromSlot(html, slot, from).match(/<span class="count">(\d+)<\/span>/);
  assert.ok(match);
  return match[1]!;
}

function postContext(runtime: ServerComponentsRuntime): RequestContext {
  const base = nestedContext(runtime);
  return {
    ...base,
    request: new Request(base.url.toString(), {
      method: 'POST',
      headers: { origin: ORIGIN },
    }),
  };
}

async function mountBoard(
  runtime: ServerComponentsRuntime,
  name = 'board',
): Promise<{
  html: string;
  snapshot: string;
}> {
  const html = await runtime.render(name, nestedContext(runtime));
  return {
    html,
    snapshot: extractAttr(html, COMPONENT_SNAPSHOT_ATTRIBUTE),
  };
}

const ALL_HELD: readonly ComponentHeldSlot[] = [
  { slot: 'k:main', component: 'card' },
  { slot: 'p:card:0', component: 'card' },
  { slot: 'p:shelf:0', component: 'shelf' },
];

interface BoardUpdate {
  readonly status: number;
  readonly html: string | undefined;
  readonly error: string | undefined;
  readonly kind: string | undefined;
  readonly refresh: readonly string[] | undefined;
}

async function updateBoard(
  runtime: ServerComponentsRuntime,
  board: { snapshot: string },
  slots: readonly ComponentHeldSlot[],
  fields: { updates?: Record<string, unknown>; action?: string } = {},
): Promise<BoardUpdate> {
  const result = await callUpdate(
    runtime,
    updateBody({
      snapshot: board.snapshot,
      updates: fields.updates ?? { title: 'next' },
      ...(fields.action === undefined ? {} : { action: { name: fields.action } }),
      slots,
    }),
    postContext(runtime),
  );
  return {
    status: result.status,
    html: result.body.html,
    error: result.body.error?.code,
    kind: result.body.kind,
    refresh: result.body.effects?.refresh,
  };
}

describe('nested child identity across a parent update', () => {
  it('marks each wrapper with its slot, its component, and a per-instance id', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const { html } = await mountBoard(runtime);
    const instance = extractAttr(html, 'id').slice(COMPONENT_ROOT_ID_PREFIX.length);
    for (const [slot, component] of [
      ['k:main', 'card'],
      ['p:card:0', 'card'],
      ['p:shelf:0', 'shelf'],
    ] as const) {
      const wrapper = wrapperAt(html, slot);
      assert.ok(wrapper.includes(`${NESTED_COMPONENT_ATTRIBUTE}="${component}"`));
      const id = `${NESTED_WRAPPER_ID_PREFIX}${instance}-${Buffer.from(slot).toString('base64url')}`;
      assert.ok(wrapper.includes(`id="${id}"`), `wrapper id for ${slot}`);
    }
    assert.equal(html.includes('data-nested-key'), false);
  });

  it('keeps held children by reference: authorized, never executed', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const before = { ...fixture.calls };

    const result = await updateBoard(runtime, board, ALL_HELD.slice(0, 2));

    assert.equal(result.status, 200);
    assert.equal(result.kind, 'render');
    const html = result.html!;
    assert.ok(isKept(html, 'k:main'));
    assert.ok(isKept(html, 'p:card:0'));
    // The shelf was not reported, so it and its own card mount fresh.
    assert.equal(isKept(html, 'p:shelf:0'), false);
    assert.equal(countAt(html, 'p:shelf:0'), '0');
    // Two kept cards plus the shelf's fresh card were authorized; only the
    // shelf's card ran its lifecycle and rendered.
    assert.equal(fixture.calls.authorize - before.authorize, 3);
    assert.equal(fixture.calls.initialState - before.initialState, 1);
    assert.equal(fixture.calls.mount - before.mount, 1);
    assert.equal(fixture.calls.render - before.render, 1);
  });

  it('mounts fresh a slot reported with another component', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);

    const result = await updateBoard(runtime, board, [
      { slot: 'k:main', component: 'shelf' },
      { slot: 'p:shelf:0', component: 'card' },
    ]);

    assert.equal(result.status, 200);
    assert.equal(isKept(result.html!, 'k:main'), false);
    assert.equal(isKept(result.html!, 'p:shelf:0'), false);
    assert.equal(countAt(result.html!, 'k:main'), '0');
  });

  it('ignores a held slot the render does not produce', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);

    const result = await updateBoard(runtime, board, [
      { slot: 'k:gone', component: 'card' },
      { slot: 'k:main', component: 'card' },
    ]);

    assert.equal(result.status, 200);
    assert.equal(result.html!.includes('k:gone'), false);
    assert.ok(isKept(result.html!, 'k:main'));
  });

  it('removes a kept child whose authorize now denies', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    fixture.allow = false;

    const result = await updateBoard(runtime, board, ALL_HELD);

    assert.equal(result.status, 200);
    const html = result.html!;
    assert.equal(html.includes(`${NESTED_SLOT_ATTRIBUTE}="k:main"`), false);
    assert.equal(html.includes(`${NESTED_SLOT_ATTRIBUTE}="p:card:0"`), false);
    // The shelf is still kept: its own (denied) card is the shelf's business.
    assert.ok(isKept(html, 'p:shelf:0'));
  });

  it('keeps children through a 422 re-render', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);

    const result = await updateBoard(runtime, board, ALL_HELD, { updates: { title: '' } });

    assert.equal(result.status, 422);
    assert.equal(result.kind, 'invalid');
    assert.ok(isKept(result.html!, 'k:main'));
    assert.ok(isKept(result.html!, 'p:shelf:0'));
  });

  it('mounts every child fresh for an update that holds none', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const keyed = childAt(board.html, 'k:main');
    const before = fixture.calls.initialState;

    const result = await updateBoard(runtime, board, []);

    assert.equal(result.status, 200);
    assert.notEqual(childAt(result.html!, 'k:main').snapshot, keyed.snapshot);
    assert.equal(fixture.calls.initialState - before, 3);
  });

  it('mounts a keyed child fresh when its key changes', async () => {
    const card = childFixture().components.card!;
    const switcher = defineServerComponent<{ key: string }>({
      name: 'switcher',
      stateSchema: z.object({ key: z.string() }).strict(),
      writableKeys: ['key'],
      initialState: () => ({ key: 'a' }),
      authorize: () => true,
      async render(state, { context }) {
        const config = defineNestedComponent({ name: 'div', component: 'card', key: state.key });
        return <div>{await renderNested(config, context)}</div>;
      },
    });
    const runtime = makeRuntime({ card, switcher });
    const parent = await mountBoard(runtime, 'switcher');

    const result = await updateBoard(runtime, parent, [{ slot: 'k:a', component: 'card' }], {
      updates: { key: 'b' },
    });

    assert.equal(result.status, 200);
    assert.equal(isKept(result.html!, 'k:b'), false);
    assert.equal(countAt(result.html!, 'k:b'), '0');
  });

  it('fails a render that uses one key twice', async () => {
    const card = childFixture().components.card!;
    const twice = defineServerComponent({
      name: 'twice',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize: () => true,
      async render(_state, { context }) {
        const config = defineNestedComponent({ name: 'div', component: 'card', key: 'same' });
        return (
          <div>
            {await renderNested(config, context)}
            {await renderNested(config, context)}
          </div>
        );
      },
    });
    const runtime = makeRuntime({ card, twice });
    await assert.rejects(
      runtime.render('twice', nestedContext(runtime)),
      (error: unknown) => error instanceof NestedComponentError && error.code === 'duplicate_slot',
    );
  });

  it('fails a render whose slot the client could not report back', async () => {
    const card = childFixture().components.card!;
    // `k:` plus the key is one character over the bound.
    const key = 'x'.repeat(MAX_SLOT_LENGTH - 1);
    const long = defineServerComponent({
      name: 'long',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize: () => true,
      async render(_state, { context }) {
        const config = defineNestedComponent({ name: 'div', component: 'card', key });
        return <div>{await renderNested(config, context)}</div>;
      },
    });
    const runtime = makeRuntime({ card, long });
    await assert.rejects(
      runtime.render('long', nestedContext(runtime)),
      (error: unknown) => error instanceof NestedComponentError && error.code === 'invalid_config',
    );
  });

  it('asks the client to refresh the kept children an action names', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);

    const named = await updateBoard(runtime, board, ALL_HELD, {
      updates: {},
      action: 'refresh-main',
    });
    assert.equal(named.status, 200);
    // `absent` names no kept child and is dropped.
    assert.deepEqual(named.refresh, ['k:main']);

    const all = await updateBoard(runtime, board, ALL_HELD, { updates: {}, action: 'refresh-all' });
    assert.deepEqual(all.refresh, ['k:main', 'p:card:0', 'p:shelf:0']);

    // A child mounted by this render is already fresh, so it is never named.
    const none = await updateBoard(runtime, board, [], { updates: {}, action: 'refresh-all' });
    assert.equal(none.status, 200);
    assert.equal(none.refresh, undefined);
  });

  it('keeps 500 held children through a parent action', async () => {
    const card = childFixture().components.card!;
    const keys = Array.from({ length: 500 }, (_, index) => `item-${index}`);
    const list = defineServerComponent<{ title: string }>({
      name: 'list',
      stateSchema: z.object({ title: z.string() }).strict(),
      writableKeys: ['title'],
      initialState: () => ({ title: 'list' }),
      authorize: () => true,
      actions: {
        rename: defineAction({
          run(state) {
            state.title = 'renamed';
          },
        }),
      },
      async render(state, { context }) {
        const children = await Promise.all(
          keys.map((key) =>
            renderNested(defineNestedComponent({ name: 'li', component: 'card', key }), context),
          ),
        );
        return (
          <div>
            <h2>{state.title}</h2>
            <ul>{children}</ul>
          </div>
        );
      },
    });
    const runtime = makeRuntime({ card, list });
    const parent = await mountBoard(runtime, 'list');
    const slots = keys.map((key) => ({ slot: `k:${key}`, component: 'card' }));
    assert.ok(haveSlotsByteLength(slots) <= MAX_HAVE_SLOTS_BYTES);

    const result = await updateBoard(runtime, parent, slots, { updates: {}, action: 'rename' });

    assert.equal(result.status, 200);
    const html = result.html!;
    assert.ok(html.includes('renamed'));
    for (const key of keys) {
      assert.ok(isKept(html, `k:${key}`), `kept ${key}`);
    }
  });

  it('refuses an update holding more children than the cap', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const slots: ComponentHeldSlot[] = [];
    for (let index = 0; haveSlotsByteLength(slots) <= MAX_HAVE_SLOTS_BYTES; index += 1) {
      slots.push({ slot: `k:${index}`, component: 'card' });
    }

    const result = await updateBoard(runtime, board, slots);

    assert.equal(result.status, 400);
    assert.equal(result.kind, 'error');
    assert.equal(result.error, 'too_many_children');
  });

  it('refuses a malformed held slot', async () => {
    const fixture = childFixture();
    const runtime = makeRuntime(fixture.components);
    const board = await mountBoard(runtime);
    const malformed: unknown[] = [
      { slot: '', component: 'card' },
      { slot: 's'.repeat(MAX_SLOT_LENGTH + 1), component: 'card' },
      { slot: 'k:main' },
      { slot: 'k:main', component: 'card', snapshot: 'a.b' },
      'k:main',
    ];
    for (const entry of malformed) {
      const result = await updateBoard(runtime, board, [entry as ComponentHeldSlot]);
      assert.equal(result.status, 400);
      assert.equal(result.error, 'invalid_request');
    }
  });
});
