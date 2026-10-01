/**
 * Audit regressions for server components (CNT-01): each test states the
 * correct behaviour for one audited defect or critic prediction. Those that
 * fail today are listed, with the failure they show, in
 * `scripts/expected-failures/content.json`.
 *
 * `components/keyed-slot-switch` is a critic prediction that does not
 * reproduce: a keyed slot whose component changes mounts the new component
 * fresh, because the restore path verifies the offered token's component. It
 * stays as a passing test so the protocol rewrite (CNT-06), which stops
 * uploading child tokens, must keep the (slot, component) identity.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod';

import type { RequestContext } from '../../src/contracts/http.js';
import { createServiceRegistry } from '../../src/extensions/services.js';
import {
  defineAction,
  defineServerComponent,
  type ServerComponentDefinition,
} from '../../src/server-components/component.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';
import { defineNestedComponent, renderNested } from '../../src/server-components/nested.js';
import {
  COMPONENT_CSRF_ATTRIBUTE,
  COMPONENT_CSRF_HEADER,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
  NESTED_SLOT_ATTRIBUTE,
} from '../../src/server-components/protocol.js';
import {
  clearComponentRegistry,
  registerComponent,
  registeredComponents,
} from '../../src/server-components/registry.js';
import {
  createServerComponentsRuntime,
  type ServerComponentsRuntime,
} from '../../src/server-components/runtime/index.js';
import { HmacComponentSigner } from '../../src/server-components/snapshot.js';
import { auditCase } from '../../src/testing/index.js';

const KEY = '0123456789abcdef0123456789abcdef';
const ORIGIN = 'http://localhost';

function context(runtime: ServerComponentsRuntime, csrf?: string): RequestContext {
  const url = new URL('/', ORIGIN);
  const controller = createServiceRegistry();
  controller.registrar.provide(serverComponentsToken, runtime);
  controller.seal();
  return {
    request:
      csrf === undefined
        ? new Request(url)
        : new Request(url, {
            method: 'POST',
            headers: { origin: ORIGIN, [COMPONENT_CSRF_HEADER]: csrf },
          }),
    url,
    params: {},
    session: null,
    services: controller.services,
  };
}

function attr(html: string, name: string): string {
  const match = html.match(new RegExp(`${name}="([^"]*)"`));
  assert.ok(match, `expected ${name} in ${html.slice(0, 200)}`);
  return match[1]!;
}

/** The snapshot and CSRF of the component root after the wrapper for `slot`. */
function slotRoot(html: string, slot: string): { snapshot: string; csrf: string; html: string } {
  const start = html.indexOf(`${NESTED_SLOT_ATTRIBUTE}="${slot}"`);
  assert.ok(start !== -1, `expected slot ${slot}`);
  const rest = html.slice(start);
  return {
    snapshot: attr(rest, COMPONENT_SNAPSHOT_ATTRIBUTE),
    csrf: attr(rest, COMPONENT_CSRF_ATTRIBUTE),
    html: rest,
  };
}

function runtimeOf(
  components: Record<string, ServerComponentDefinition<any>>,
  now: () => number = () => 0,
): ServerComponentsRuntime {
  return createServerComponentsRuntime({
    components,
    signer: new HmacComponentSigner({ key: KEY, now }),
  });
}

function counter(name: string) {
  return defineServerComponent<{ count: number }>({
    name,
    stateSchema: z.object({ count: z.number() }).strict(),
    initialState: () => ({ count: 0 }),
    authorize: () => true,
    actions: {
      increment: defineAction({
        run(state) {
          state.count += 1;
        },
      }),
    },
    render: (state) => (
      <span class={name}>
        {name}:{state.count}
      </span>
    ),
  });
}

async function increment(
  runtime: ServerComponentsRuntime,
  root: { snapshot: string; csrf: string },
): Promise<string> {
  const result = await runtime.update(
    { snapshot: root.snapshot, updates: {}, sequence: 1, action: { name: 'increment' } },
    context(runtime, root.csrf),
  );
  assert.equal(result.status, 200);
  return result.body.snapshot!;
}

test(
  ...auditCase(
    'components/duplicate-name',
    'registering a second component under a taken name is refused',
  ),
  (t) => {
    t.after(() => clearComponentRegistry());
    registerComponent(counter('audit-widget'));
    const impostor = { ...counter('audit-widget'), authorize: () => true };
    assert.throws(
      () => registerComponent(impostor),
      'a second definition silently replaced the first and took over its snapshots',
    );
    assert.notEqual(registeredComponents()['audit-widget'], impostor);
  },
);

test(
  ...auditCase(
    'components/issued-at-clock-skew',
    'a snapshot from an instance whose clock runs a second ahead still verifies',
  ),
  () => {
    const ahead = new HmacComponentSigner({ key: KEY, now: () => 1_000_000 + 1000 });
    const behind = new HmacComponentSigner({ key: KEY, now: () => 1_000_000 });
    const token = ahead.sign({
      v: 1,
      component: 'audit-widget',
      id: 'c1',
      state: {},
      page: { path: '/', params: {} },
      origin: ORIGIN,
      subject: null,
      revision: 0,
    });
    assert.doesNotThrow(
      () => behind.verify(token),
      'one second of clock skew between instances rejects every snapshot',
    );
  },
);

test(
  ...auditCase(
    'components/keyed-slot-switch',
    'a keyed slot whose component changes mounts the new component fresh',
  ),
  async () => {
    let showAlpha = true;
    const host = defineServerComponent<{ step: number }>({
      name: 'host',
      stateSchema: z.object({ step: z.number() }).strict(),
      writableKeys: ['step'],
      initialState: () => ({ step: 0 }),
      authorize: () => true,
      async render(_state, { context: requestContext }) {
        const slot = defineNestedComponent({
          name: 'section',
          component: showAlpha ? 'alpha' : 'beta',
          key: 'main',
        });
        return <div>{await renderNested(slot, requestContext)}</div>;
      },
    });
    const runtime = runtimeOf({ host, alpha: counter('alpha'), beta: counter('beta') });
    const mounted = await runtime.render('host', context(runtime));
    const alphaToken = await increment(runtime, slotRoot(mounted, 'k:main'));
    showAlpha = false;
    const result = await runtime.update(
      {
        snapshot: attr(mounted, COMPONENT_SNAPSHOT_ATTRIBUTE),
        updates: { step: 1 },
        sequence: 1,
        children: [{ slot: 'k:main', snapshot: alphaToken }],
      },
      context(runtime, attr(mounted, COMPONENT_CSRF_ATTRIBUTE)),
    );
    assert.equal(result.status, 200);
    const slot = slotRoot(result.body.html!, 'k:main').html;
    assert.match(slot, /beta:0/, "beta mounted with alpha's state or not at all");
  },
);

test(
  ...auditCase(
    'components/children-over-cap',
    'a parent update keeps the state of every child, not only the first 64',
  ),
  async () => {
    const count = 70;
    const grid = defineServerComponent<{ step: number }>({
      name: 'grid',
      stateSchema: z.object({ step: z.number() }).strict(),
      writableKeys: ['step'],
      initialState: () => ({ step: 0 }),
      authorize: () => true,
      async render(_state, { context: requestContext }) {
        const cells = [];
        for (let index = 0; index < count; index += 1) {
          const slot = defineNestedComponent({
            name: 'section',
            component: 'cell',
            key: `c${index}`,
          });
          cells.push(await renderNested(slot, requestContext));
        }
        return <div>{cells}</div>;
      },
    });
    const runtime = runtimeOf({ grid, cell: counter('cell') });
    const mounted = await runtime.render('grid', context(runtime));
    const children = [];
    for (let index = 0; index < count; index += 1) {
      const slot = `k:c${index}`;
      children.push({ slot, snapshot: await increment(runtime, slotRoot(mounted, slot)) });
    }
    const result = await runtime.update(
      {
        snapshot: attr(mounted, COMPONENT_SNAPSHOT_ATTRIBUTE),
        updates: { step: 1 },
        sequence: 1,
        children,
      },
      context(runtime, attr(mounted, COMPONENT_CSRF_ATTRIBUTE)),
    );
    assert.equal(result.status, 200, `a parent with ${count} children could not update`);
    const kept = (result.body.html!.match(/cell:1/g) ?? []).length;
    assert.equal(kept, count, `${count - kept} children lost their state`);
  },
);

test(
  ...auditCase(
    'components/child-errors-lost-on-parent-update',
    "a child's validation errors survive an update of its parent",
  ),
  async () => {
    const field = defineServerComponent<{ email: string }>({
      name: 'field',
      stateSchema: z.object({ email: z.string().email() }).strict(),
      writableKeys: ['email'],
      initialState: () => ({ email: 'ada@example.com' }),
      authorize: () => true,
      render: (_state, { errors }) => (
        <label>{errors.email === undefined ? 'ok' : <em class="error">invalid</em>}</label>
      ),
    });
    const form = defineServerComponent<{ step: number }>({
      name: 'form',
      stateSchema: z.object({ step: z.number() }).strict(),
      writableKeys: ['step'],
      initialState: () => ({ step: 0 }),
      authorize: () => true,
      async render(_state, { context: requestContext }) {
        const slot = defineNestedComponent({ name: 'section', component: 'field', key: 'email' });
        return <div>{await renderNested(slot, requestContext)}</div>;
      },
    });
    const runtime = runtimeOf({ form, field });
    const mounted = await runtime.render('form', context(runtime));
    const child = slotRoot(mounted, 'k:email');
    const rejected = await runtime.update(
      { snapshot: child.snapshot, updates: { email: 'not-an-email' }, sequence: 1 },
      context(runtime, child.csrf),
    );
    assert.equal(rejected.status, 422);
    assert.match(rejected.body.html!, /class="error"/);
    const polled = await runtime.update(
      {
        snapshot: attr(mounted, COMPONENT_SNAPSHOT_ATTRIBUTE),
        updates: { step: 1 },
        sequence: 1,
        children: [{ slot: 'k:email', snapshot: rejected.body.snapshot ?? child.snapshot }],
      },
      context(runtime, attr(mounted, COMPONENT_CSRF_ATTRIBUTE)),
    );
    assert.equal(polled.status, 200);
    assert.match(
      slotRoot(polled.body.html!, 'k:email').html,
      /class="error"/,
      "the parent's update wiped the child's validation error",
    );
  },
);
