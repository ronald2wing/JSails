/**
 * The version 2 update pipeline end to end on a real runtime: `unchanged`
 * replies, when a token is re-signed, the render tag's identity, and the
 * size of what a client sends and receives.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import type { RequestContext } from '../../src/contracts/http.js';
import { createServiceRegistry } from '../../src/extensions/services.js';
import {
  defineAction,
  defineServerComponent,
  redirect,
  type ServerComponentDefinition,
} from '../../src/server-components/component.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';
import { defineNestedComponent, renderNested } from '../../src/server-components/nested.js';
import {
  COMPONENT_RENDER_ATTRIBUTE,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  REFRESH_ACTION,
} from '../../src/server-components/protocol.js';
import { componentRegistryFromMap } from '../../src/server-components/registry.js';
import {
  createServerComponentsRuntime,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime/index.js';
import { HmacComponentSigner } from '../../src/server-components/snapshot.js';
import { callUpdate, updateBody, type LaneAnswer } from './lane-calls.js';

const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';
const HOUR = 60 * 60 * 1000;

const counter = defineServerComponent<{ count: number; note: string }>({
  name: 'counter',
  stateSchema: z.object({ count: z.number(), note: z.string() }).strict(),
  writableKeys: ['note'],
  initialState: () => ({ count: 0, note: '' }),
  authorize: () => true,
  actions: {
    increment: defineAction({
      run(state) {
        state.count += 1;
      },
    }),
    leave: defineAction({
      run() {
        return redirect('/elsewhere');
      },
    }),
  },
  // `note` is state the markup never shows.
  render: (state) => <span class="count">{state.count}</span>,
});

const card = defineServerComponent<{ count: number }>({
  name: 'card',
  stateSchema: z.object({ count: z.number() }).strict(),
  initialState: () => ({ count: 0 }),
  authorize: () => true,
  render: (state) => <span>{state.count}</span>,
});

const board = defineServerComponent<{ title: string }>({
  name: 'board',
  stateSchema: z.object({ title: z.string() }).strict(),
  initialState: () => ({ title: 'board' }),
  authorize: () => true,
  async render(state, { context }) {
    const keyed = defineNestedComponent({ name: 'section', component: 'card', key: 'main' });
    return (
      <div>
        <h2>{state.title}</h2>
        {await renderNested(keyed, context)}
        {await renderNested('card', context)}
      </div>
    );
  },
});

interface Fixture {
  readonly runtime: ServerComponentsRuntime;
  readonly signer: HmacComponentSigner;
  /** The signer's clock and the number of tokens it signed. */
  readonly stats: { now: number; signs: number };
}

function fixture(components: Record<string, ServerComponentDefinition<any>>): Fixture {
  const stats = { now: 0, signs: 0 };
  const signer = new HmacComponentSigner({ key: KEY, now: () => stats.now, ttlMs: HOUR });
  const counting = {
    subjectFor: (id: string | null) => signer.subjectFor(id),
    verify: signer.verify.bind(signer),
    renewalDue: signer.renewalDue.bind(signer),
    sign: (payload: Parameters<typeof signer.sign>[0]) => {
      stats.signs += 1;
      return signer.sign(payload);
    },
  };
  const runtime = createServerComponentsRuntime({
    components: componentRegistryFromMap(components),
    signer: counting,
  });
  return { runtime, signer, stats };
}

function context(runtime: ServerComponentsRuntime, post = false): RequestContext {
  const url = new URL('/', ORIGIN);
  const registry = createServiceRegistry();
  registry.registrar.provide(serverComponentsToken, runtime);
  registry.seal();
  return {
    request: !post
      ? new Request(url)
      : new Request(url, {
          method: 'POST',
          headers: { origin: ORIGIN },
        }),
    url,
    params: {},
    session: null,
    services: registry.services,
  };
}

function attr(html: string, name: string): string {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(match, `expected ${name}`);
  return match[1]!;
}

interface Mounted {
  readonly html: string;
  readonly snapshot: string;
  readonly render: string;
}

async function mount(f: Fixture, name: string): Promise<Mounted> {
  const html = await f.runtime.render(name, context(f.runtime));
  return {
    html,
    snapshot: attr(html, COMPONENT_SNAPSHOT_ATTRIBUTE),
    render: attr(html, COMPONENT_RENDER_ATTRIBUTE),
  };
}

async function refresh(
  f: Fixture,
  root: { snapshot: string },
  render: string | null,
  fields: Partial<Parameters<typeof updateBody>[0]> = {},
): Promise<{ answer: LaneAnswer; bytes: number }> {
  const request = updateBody({
    snapshot: root.snapshot,
    action: { name: REFRESH_ACTION },
    render,
    ...fields,
  });
  const answer = await callUpdate(f.runtime, request, context(f.runtime, true));
  return { answer, bytes: Buffer.byteLength(JSON.stringify(answer.body)) };
}

describe('unchanged replies', () => {
  it('answers an idle refresh unchanged in under 200 bytes, keeping the token', async () => {
    const f = fixture({ counter });
    const root = await mount(f, 'counter');
    f.stats.signs = 0;

    const { answer, bytes } = await refresh(f, root, root.render);

    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { kind: 'unchanged', sequence: 1 });
    assert.ok(bytes < 200, `${bytes} bytes`);
    assert.equal(f.stats.signs, 0, 'an unchanged state is not re-signed');
  });

  it('hands back the presented token byte for byte when only the DOM is stale', async () => {
    const f = fixture({ counter });
    const root = await mount(f, 'counter');

    const { answer } = await refresh(f, root, 'stale-tag');

    assert.equal(answer.body.kind, 'render');
    assert.equal(answer.body.snapshot, root.snapshot);
    assert.equal(answer.body.render, root.render);
  });

  it('renders when the state changed, re-signing the token', async () => {
    const f = fixture({ counter });
    const root = await mount(f, 'counter');

    const { answer } = await refresh(f, root, root.render, { action: { name: 'increment' } });

    assert.equal(answer.body.kind, 'render');
    assert.notEqual(answer.body.snapshot, root.snapshot);
    assert.notEqual(answer.body.render, root.render);
    assert.match(answer.body.html!, />1</);
  });

  it('renders for a client edit even when the markup does not change', async () => {
    const f = fixture({ counter });
    const root = await mount(f, 'counter');

    const { answer } = await refresh(f, root, root.render, {
      updates: { note: 'typed' },
      action: { name: REFRESH_ACTION },
    });

    assert.equal(answer.body.kind, 'render');
    assert.notEqual(answer.body.render, root.render, 'the state is part of the render tag');
  });

  it('renders when the action raised an effect', async () => {
    const f = fixture({ counter });
    const root = await mount(f, 'counter');

    const { answer } = await refresh(f, root, root.render, { action: { name: 'leave' } });

    assert.equal(answer.body.kind, 'render');
    assert.equal(answer.body.effects?.redirect, '/elsewhere');
  });

  it('keeps a polled component alive past its TTL, re-signing only when renewal is due', async () => {
    const f = fixture({ counter });
    const mounted = await mount(f, 'counter');
    let root: { snapshot: string } = mounted;
    let renewals = 0;

    // Poll every 10 minutes for five hours: five times the one-hour TTL.
    for (let minute = 10; minute <= 300; minute += 10) {
      f.stats.now = minute * 60 * 1000;
      const { answer } = await refresh(f, root, mounted.render);
      assert.equal(answer.status, 200, `poll at minute ${minute}: ${JSON.stringify(answer.body)}`);
      assert.equal(answer.body.kind, 'unchanged');
      if (answer.body.snapshot !== undefined) {
        renewals += 1;
        root = { snapshot: answer.body.snapshot };
      }
    }

    // Renewed only once more than half the TTL was spent: at the first poll
    // under 30 minutes from expiry, every 40 minutes, not on every poll.
    assert.equal(renewals, 7);
    assert.ok(f.signer.verify(root.snapshot).expiresAt > f.stats.now);
  });
  it('keeps a parent holding stateful children unchanged past its TTL, never rendering them', async () => {
    let cardRenders = 0;
    const countedCard = defineServerComponent<{ count: number }>({
      name: 'card',
      stateSchema: z.object({ count: z.number() }).strict(),
      initialState: () => ({ count: 0 }),
      authorize: () => true,
      render: (state) => {
        cardRenders += 1;
        return <span>{state.count}</span>;
      },
    });
    const f = fixture({ board, card: countedCard });
    const mounted = await mount(f, 'board');
    const slots = [
      { slot: 'k:main', component: 'card' },
      { slot: 'p:card:0', component: 'card' },
    ];
    assert.equal(cardRenders, 2);
    let root: { snapshot: string } = mounted;

    for (let minute = 10; minute <= 300; minute += 10) {
      f.stats.now = minute * 60 * 1000;
      const { answer } = await refresh(f, root, mounted.render, { slots });
      assert.equal(answer.body.kind, 'unchanged', `poll at minute ${minute}`);
      if (answer.body.snapshot !== undefined) {
        root = { snapshot: answer.body.snapshot };
      }
    }

    assert.equal(cardRenders, 2);
    assert.ok(f.signer.verify(root.snapshot).expiresAt > f.stats.now);
  });
});

describe('render tag', () => {
  it('is stable for one instance and state, and differs between instances', async () => {
    const f = fixture({ counter });
    const root = await mount(f, 'counter');
    const other = await mount(f, 'counter');

    const { answer } = await refresh(f, root, null);

    assert.equal(answer.body.render, root.render);
    assert.notEqual(other.render, root.render);
  });

  it('is the same whether the children were kept or mounted fresh', async () => {
    const f = fixture({ board, card });
    const root = await mount(f, 'board');

    const fresh = await refresh(f, root, null);
    const kept = await refresh(f, root, null, {
      slots: [
        { slot: 'k:main', component: 'card' },
        { slot: 'p:card:0', component: 'card' },
      ],
    });

    assert.equal(fresh.answer.body.render, root.render);
    assert.equal(kept.answer.body.render, root.render);
    assert.notEqual(fresh.answer.body.html, kept.answer.body.html);
  });
});

describe('unchanged replies with nested children', () => {
  const held = [
    { slot: 'k:main', component: 'card' },
    { slot: 'p:card:0', component: 'card' },
  ];

  it('answers a poll that holds every child unchanged', async () => {
    const f = fixture({ board, card });
    const root = await mount(f, 'board');

    const { answer } = await refresh(f, root, root.render, { slots: held });

    assert.deepEqual(answer.body, { kind: 'unchanged', sequence: 1 });
  });

  it('sends the render when a child the client left out was mounted fresh', async () => {
    // A blocked child is left out of `have.slots`; the parent's state and tag
    // did not change, but the client needs the fresh child it mounted.
    let mounts = 0;
    const countedCard = defineServerComponent<{ count: number }>({
      name: 'card',
      stateSchema: z.object({ count: z.number() }).strict(),
      initialState: () => {
        mounts += 1;
        return { count: 41 + mounts };
      },
      authorize: () => true,
      render: (state) => <span class="card">{state.count}</span>,
    });
    const f = fixture({ board, card: countedCard });
    const root = await mount(f, 'board');
    mounts = 0;

    const { answer } = await refresh(f, root, root.render, { slots: [held[0]!] });

    assert.equal(mounts, 1, 'only the child left out is mounted');
    assert.equal(answer.body.kind, 'render');
    assert.equal(answer.body.render, root.render);
    assert.equal(answer.body.snapshot, root.snapshot, 'the parent is not re-signed');
    assert.match(answer.body.html!, /<span class="card">42<\/span>/);
  });

  it('sends the render when a reported child is held with another component', async () => {
    const f = fixture({ board, card });
    const root = await mount(f, 'board');

    const { answer } = await refresh(f, root, root.render, {
      slots: [held[0]!, { slot: 'p:card:0', component: 'other' }],
    });

    assert.equal(answer.body.kind, 'render');
  });
});

describe('render tag across children', () => {
  it('changes with the set of children', async () => {
    let second = true;
    const varying = defineServerComponent({
      name: 'varying',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize: () => true,
      async render(_state, { context: requestContext }) {
        return (
          <div>
            {await renderNested('card', requestContext)}
            {second ? await renderNested('card', requestContext) : null}
          </div>
        );
      },
    });
    const f = fixture({ varying, card });
    const root = await mount(f, 'varying');
    second = false;

    const { answer } = await refresh(f, root, root.render);

    assert.equal(answer.body.kind, 'render');
    assert.notEqual(answer.body.render, root.render);
  });
});

describe('render tag (seeded property)', () => {
  const RUNS = 60;
  const SEED = 0x7a65_0006;
  type Scalar = string | number | boolean | null;

  /** mulberry32: a small deterministic PRNG; one seed, one sequence. */
  function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const bag = defineServerComponent<{ data: Record<string, Scalar> }>({
    name: 'bag',
    stateSchema: z
      .object({
        data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
      })
      .strict(),
    writableKeys: ['data'],
    initialState: () => ({ data: {} }),
    authorize: () => true,
    // The markup shows only the size, so a state change need not change it.
    render: (state) => <span>{Object.keys(state.data).length}</span>,
  });

  it('is equal for equal states whatever their key order, and differs otherwise', async () => {
    const f = fixture({ bag });
    const root = await mount(f, 'bag');
    const next = mulberry32(SEED);
    const int = (max: number): number => Math.floor(next() * (max + 1));
    const scalar = (): Scalar => {
      switch (int(3)) {
        case 0:
          return int(1000) - 500;
        case 1:
          return 'v'.repeat(int(3)) + String.fromCharCode(0x61 + int(25), 0xe9, 0x4e2d);
        case 2:
          return int(1) === 1;
        default:
          return null;
      }
    };
    const tagFor = async (data: Record<string, Scalar>): Promise<string> => {
      const { answer } = await refresh(f, root, null, { updates: { data } });
      assert.equal(answer.body.kind, 'render');
      return answer.body.render!;
    };

    for (let run = 0; run < RUNS; run += 1) {
      const entries: [string, Scalar][] = [];
      for (let count = 1 + int(6); count > 0; count -= 1) {
        entries.push([`k${int(40)}${String.fromCharCode(0x41 + int(25))}`, scalar()]);
      }
      const data = Object.fromEntries(entries);
      const keys = Object.keys(data);
      const shuffled: Record<string, Scalar> = {};
      for (const key of [...keys].sort(() => next() - 0.5)) shuffled[key] = data[key]!;
      const changedKey = keys[int(keys.length - 1)]!;
      const changed = { ...data, [changedKey]: `${String(data[changedKey])}!` };

      const tag = await tagFor(data);
      assert.equal(await tagFor(data), tag, `run ${run}: the same state twice`);
      assert.equal(await tagFor(shuffled), tag, `run ${run}: the same state reordered`);
      assert.notEqual(await tagFor(changed), tag, `run ${run}: another state`);
    }
  });
});

describe('request size', () => {
  it('keeps a request holding ten children within 1 KiB of its token', async () => {
    const f = fixture({ board, card });
    const root = await mount(f, 'board');
    const body = JSON.stringify(
      updateBody({
        snapshot: root.snapshot,
        sequence: 12,
        action: { name: REFRESH_ACTION },
        render: root.render,
        slots: Array.from({ length: 10 }, (_, index) => ({
          slot: `p:task-card:${index}`,
          component: 'task-card',
        })),
      }),
    );
    assert.ok(body.length - root.snapshot.length <= 1024, `${body.length - root.snapshot.length}`);
  });
});
