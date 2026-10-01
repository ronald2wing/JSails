/**
 * Tests for a server component's static-export root (`runtime/static-render.ts`):
 * `staticFallback` renders without state; `staticRender: 'initial'` renders the
 * component's own `render` over its initial state with inert tools, only when
 * `authorize` returns exactly `true` for the static context, without the
 * `mount` hook, a snapshot, signing or an instance id, and with its bound
 * forms checked as a live render checks them; a nested chain under a static
 * form keeps the depth bound and renders static; any failure of a static form
 * is a `component_static.render_failed` refusal; and a component with
 * neither form fails closed with `component_static.missing_fallback`. The two
 * static forms are exclusive at definition time.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import type { RenderChild } from '../../src/contracts/component.js';
import type { RequestContext } from '../../src/contracts/http.js';
import { createServiceRegistry } from '../../src/extensions/services.js';
import {
  defineServerComponent,
  ServerComponentDefinitionError,
  type ServerComponentDefinition,
  type ServerComponentRenderTools,
} from '../../src/server-components/component.js';
import { defineLiveComponent, serverAction } from '../../src/server-components/authoring/index.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';
import {
  MAX_NESTING_DEPTH,
  NestedComponentError,
  renderNested,
} from '../../src/server-components/nested.js';
import {
  COMPONENT_ATTRIBUTE,
  COMPONENT_SNAPSHOT_ATTRIBUTE,
} from '../../src/server-components/protocol.js';
import { componentRegistryFromMap } from '../../src/server-components/registry.js';
import {
  ComponentAuthorizeErrors,
  ComponentStaticErrors,
  createServerComponentsRuntime,
  ServerComponentRuntimeError,
} from '../../src/server-components/runtime/index.js';
import { HmacComponentSigner } from '../../src/server-components/snapshot.js';

const KEY = 'static-render-test-key-0123456789abcdef';

function staticContext(): RequestContext {
  const url = new URL('http://localhost/');
  return {
    request: new Request(url),
    url,
    params: {},
    session: null,
    renderMode: 'static',
  };
}

/**
 * Render the static form of the first of `components`, with every one
 * registered and the runtime on the context, as `jsails build` provides it.
 */
function render(...components: ServerComponentDefinition<any>[]): Promise<string> {
  const runtime = createServerComponentsRuntime({
    components: componentRegistryFromMap(
      Object.fromEntries(components.map((component) => [component.name, component])),
    ),
    signer: new HmacComponentSigner({ key: KEY }),
  });
  const controller = createServiceRegistry();
  controller.registrar.provide(serverComponentsToken, runtime);
  controller.seal();
  const context = { ...staticContext(), services: controller.services };
  return runtime.render(components[0]!.name, context, { staticMode: true });
}

/** Assert `error` is a `render_failed` refusal naming `component`, and return its cause. */
function renderFailure(error: unknown, component: string): unknown {
  assert.ok(ComponentStaticErrors.is(error, 'render_failed'));
  assert.deepEqual(error.context, { component });
  return error.cause;
}

const stateSchema = z
  .object({ title: z.string().max(40), count: z.number().int(), open: z.boolean() })
  .strict();

/** A component whose initial render uses every tool, with probes on its hooks. */
function initial(authorize: () => unknown, probes: { mounted: number } = { mounted: 0 }) {
  return defineLiveComponent(
    'initial',
    stateSchema,
  )({
    initialState: () => ({ title: 'Hello', count: 2, open: false }),
    authorize: authorize as () => boolean,
    staticRender: 'initial',
    mount() {
      probes.mounted += 1;
    },
    actions: {
      save: serverAction({ input: z.object({ at: z.number() }), run() {} }),
    },
    derived: { double: (state) => state.count * 2 },
    render(state, tools) {
      return (
        <form {...tools.submit('save', { at: 1 })} {...tools.loadingTarget()}>
          <input {...tools.bind('title', { trim: true, debounceMs: 100 })} />
          <input {...tools.bind('open')} />
          <p {...tools.text('title')} {...tools.show('open')} {...tools.confirm('Sure?')}>
            {state.title} {tools.derived('double')}
          </p>
          <button {...tools.call('save', { at: 2 })} {...tools.ref('b')} {...tools.ignore()}>
            Save
          </button>
          <div {...tools.intersect('save')} {...tools.poll({ intervalMs: 1000 })} />
          <th {...tools.sort('title')}>t</th>
        </form>
      );
    },
  });
}

describe('static form: staticFallback', () => {
  it('renders the fallback in a marker-only root', async () => {
    const html = await render(
      defineServerComponent({
        name: 'fallback',
        stateSchema: z.object({}).strict(),
        initialState: () => ({}),
        authorize: () => false,
        render: () => <p>live</p>,
        staticFallback: () => <p>static</p>,
      }),
    );
    assert.equal(
      html,
      '<div data-jsails-component="fallback" data-jsails-component-name="fallback"><p>static</p></div>',
    );
  });
});

describe("static form: staticRender: 'initial'", () => {
  it('renders the initial state with inert tools in a marker-only root, without mount', async () => {
    const probes = { mounted: 0 };
    const html = await render(initial(() => true, probes));
    assert.equal(probes.mounted, 0);
    assert.match(html, new RegExp(`^<div ${COMPONENT_ATTRIBUTE}="initial"`));
    assert.match(html, /<form method="dialog">/);
    assert.match(html, /<input value="Hello"\/>/);
    assert.match(html, /<input\/>/);
    assert.match(html, /<p>Hello 4<\/p>/);
    assert.match(html, /<button>Save<\/button>/);
    assert.doesNotMatch(html, /data-jsails-(?!component)/);
    assert.equal(html.includes(COMPONENT_SNAPSHOT_ATTRIBUTE), false);
    assert.equal(html.includes('id="'), false);
  });

  it('renders only when authorize returns exactly true for the static context', async () => {
    for (const verdict of [false, 'yes', 1, undefined]) {
      await assert.rejects(render(initial(() => verdict)), (error: unknown) =>
        ComponentStaticErrors.is(error, 'initial_denied'),
      );
    }
  });

  it('refuses a throwing authorize as render_failed, its cause the authorize fault', async () => {
    await assert.rejects(
      render(
        initial(() => {
          throw new Error('policy store down');
        }),
      ),
      (error: unknown) =>
        ComponentAuthorizeErrors.is(renderFailure(error, 'initial'), 'component_failed'),
    );
  });

  it('refuses a throwing render or staticFallback as render_failed', async () => {
    const fault = new Error('no database at build time');
    const throwingRender = defineServerComponent({
      name: 'throwing-render',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize: () => true,
      staticRender: 'initial',
      render: () => {
        throw fault;
      },
    });
    await assert.rejects(
      render(throwingRender),
      (error: unknown) => renderFailure(error, 'throwing-render') === fault,
    );
    const throwingFallback = defineServerComponent({
      name: 'throwing-fallback',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize: () => true,
      render: () => <p>x</p>,
      staticFallback: () => Promise.reject(fault),
    });
    await assert.rejects(
      render(throwingFallback),
      (error: unknown) => renderFailure(error, 'throwing-fallback') === fault,
    );
  });

  it('refuses a bound form whose author makes it navigate, as a live render does', async () => {
    const overrides: Record<string, (tools: ServerComponentRenderTools) => RenderChild> = {
      method: (tools) => (
        <form {...tools.submit('save')} method="get" action="/search">
          <input {...tools.bind('q')} />
        </form>
      ),
      action: (tools) => (
        <form {...tools.submit('save')} action="/search">
          <input {...tools.bind('q')} />
        </form>
      ),
      formaction: (tools) => (
        <form {...tools.submit('save')}>
          <input {...tools.bind('q')} />
          <button formaction="/search">Go</button>
        </form>
      ),
    };
    for (const [name, body] of Object.entries(overrides)) {
      const component = defineServerComponent({
        name: `override-${name}`,
        stateSchema: z.object({ q: z.string() }).strict(),
        initialState: () => ({ q: 'secret-typed' }),
        authorize: () => true,
        staticRender: 'initial',
        actions: { save: { input: z.object({}).strict(), run() {} } },
        render: (_state, tools) => body(tools),
      });
      await assert.rejects(render(component), (error: unknown) => {
        const cause = renderFailure(error, `override-${name}`);
        assert.ok(cause instanceof ServerComponentRuntimeError, name);
        assert.equal(cause.code, 'invalid_definition', name);
        return true;
      });
    }
  });

  it('keeps an unbound form with a formaction submitter, and strips the check marker', async () => {
    const html = await render(
      defineServerComponent({
        name: 'unbound',
        stateSchema: z.object({}).strict(),
        initialState: () => ({}),
        authorize: () => true,
        staticRender: 'initial',
        actions: { save: { input: z.object({}).strict(), run() {} } },
        render: (_state, tools) => (
          <div>
            <form {...tools.submit('save')} />
            <form method="get" action="/search">
              <button formaction="/find">Find</button>
            </form>
          </div>
        ),
      }),
    );
    assert.match(html, /<form method="dialog"><\/form>/);
    assert.match(html, /<form method="get" action="\/search">/);
    assert.doesNotMatch(html, /data-jsails-(?!component)/);
  });

  it('still validates action args and the initial state', async () => {
    const badArgs = defineServerComponent({
      name: 'bad-args',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize: () => true,
      staticRender: 'initial',
      actions: {
        save: { input: z.object({ at: z.number() }).strict(), run() {} },
      },
      render: (_state, tools) => <form {...tools.submit('save', { at: 'x' })} />,
    });
    await assert.rejects(render(badArgs), (error: unknown) => {
      assert.ok(renderFailure(error, 'bad-args') instanceof ServerComponentRuntimeError);
      return true;
    });
    const badState = defineServerComponent({
      name: 'bad-state',
      stateSchema: z.object({ n: z.number() }).strict(),
      initialState: () => ({ n: 'x' }) as unknown as { n: number },
      authorize: () => true,
      staticRender: 'initial',
      render: () => <p>x</p>,
    });
    await assert.rejects(render(badState), (error: unknown) => {
      const cause = renderFailure(error, 'bad-state');
      assert.ok(cause instanceof ServerComponentRuntimeError);
      assert.equal(cause.code, 'invalid_state');
      return true;
    });
  });
});

describe('static form: nesting', () => {
  /** A component whose every static form nests itself, counting its renders. */
  function selfNesting(form: 'initial' | 'fallback', probes: { renders: number }) {
    const nest = async (context: RequestContext) => {
      probes.renders += 1;
      return <section>{await renderNested('thread', context)}</section>;
    };
    return defineServerComponent({
      name: 'thread',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize: () => true,
      render: (_state, tools) => nest(tools.context),
      ...(form === 'initial'
        ? { staticRender: 'initial' as const }
        : { staticFallback: (context: RequestContext) => nest(context) }),
    });
  }

  it('stops a self-nesting chain at the depth bound, as a live render does', async () => {
    for (const form of ['initial', 'fallback'] as const) {
      const probes = { renders: 0 };
      await assert.rejects(render(selfNesting(form, probes)), (error: unknown) => {
        const cause = renderFailure(error, 'thread');
        assert.ok(cause instanceof NestedComponentError, form);
        assert.equal(cause.code, 'too_deep', form);
        return true;
      });
      assert.equal(probes.renders, MAX_NESTING_DEPTH + 1, form);
    }
  });

  it('renders a nested child static and inline, and lets its refusal pass unchanged', async () => {
    const child = defineServerComponent({
      name: 'child',
      stateSchema: z.object({ n: z.number() }).strict(),
      initialState: () => ({ n: 7 }),
      authorize: () => true,
      staticRender: 'initial',
      render: (state) => <b>{state.n}</b>,
    });
    const parent = defineServerComponent({
      name: 'parent',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize: () => true,
      staticRender: 'initial',
      render: async (_state, tools) => <main>{await renderNested('child', tools.context)}</main>,
    });
    assert.equal(
      await render(parent, child),
      '<div data-jsails-component="parent" data-jsails-component-name="parent"><main><div>' +
        '<div data-jsails-component="child" data-jsails-component-name="child"><b>7</b></div>' +
        '</div></main></div>',
    );
    const bare = defineServerComponent({
      name: 'child',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize: () => true,
      render: () => <b>x</b>,
    });
    await assert.rejects(render(parent, bare), (error: unknown) => {
      assert.ok(ComponentStaticErrors.is(error, 'missing_fallback'));
      assert.deepEqual(error.context, { component: 'child' });
      return true;
    });
  });

  it('checks a child submitter against the bound form of its parent', async () => {
    const child = defineServerComponent({
      name: 'child',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize: () => true,
      staticFallback: () => <button formaction="/elsewhere">Go</button>,
      render: () => <b>x</b>,
    });
    const parent = defineServerComponent({
      name: 'parent',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize: () => true,
      staticRender: 'initial',
      actions: { save: { input: z.object({}).strict(), run() {} } },
      render: async (_state, tools) => (
        <form {...tools.submit('save')}>{await renderNested('child', tools.context)}</form>
      ),
    });
    await assert.rejects(render(parent, child), (error: unknown) => {
      const cause = renderFailure(error, 'parent');
      assert.ok(cause instanceof ServerComponentRuntimeError);
      assert.equal(cause.code, 'invalid_definition');
      return true;
    });
  });
});

describe('static form: none', () => {
  it('fails closed with missing_fallback, naming the component', async () => {
    const component = defineServerComponent({
      name: 'bare',
      stateSchema: z.object({}).strict(),
      initialState: () => ({}),
      authorize: () => true,
      render: () => <p>x</p>,
    });
    await assert.rejects(render(component), (error: unknown) => {
      assert.ok(ComponentStaticErrors.is(error, 'missing_fallback'));
      assert.deepEqual(error.context, { component: 'bare' });
      return true;
    });
  });
});

describe('static form: definition', () => {
  const base = {
    name: 'both',
    stateSchema: z.object({}).strict(),
    initialState: () => ({}),
    authorize: () => true,
    render: () => <p>x</p>,
  };

  it('rejects staticRender with staticFallback, and any other staticRender value', () => {
    assert.throws(
      () =>
        defineServerComponent({
          ...base,
          staticRender: 'initial',
          staticFallback: () => <p>y</p>,
        }),
      ServerComponentDefinitionError,
    );
    assert.throws(
      () => defineServerComponent({ ...base, staticRender: 'always' as 'initial' }),
      ServerComponentDefinitionError,
    );
  });
});
