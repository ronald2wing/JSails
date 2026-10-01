/**
 * The render-time inert-form check: a bound form renders `method="dialog"`
 * with no `action`, whatever the JSX spread order, and a `formaction` or
 * non-dialog `formmethod` submitter sits inside an unbound form of the same
 * render with no `form` attribute, so no submitter can override a bound form
 * it belongs to through containment, a `form` attribute, or a nested child.
 * Anything else fails the render closed, value-free.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { VNode } from 'preact';
import { z } from 'zod';

import type { RequestContext } from '../../src/contracts/http.js';
import { renderToString } from '../../src/jsx/render-to-string.js';
import {
  defineAction,
  defineServerComponent,
  type ServerComponentRenderTools,
} from '../../src/server-components/component.js';
import { createServiceRegistry } from '../../src/extensions/services.js';
import { serverComponentsToken } from '../../src/server-components/extension.js';
import { NestedComponentError, renderNested } from '../../src/server-components/nested.js';
import { componentRegistryFromMap } from '../../src/server-components/registry.js';
import { assertInertForms } from '../../src/server-components/runtime/inert-forms.js';
import {
  createServerComponentsRuntime,
  ServerComponentRuntimeError,
} from '../../src/server-components/runtime/index.js';
import { HmacComponentSigner } from '../../src/server-components/snapshot.js';

const BOUND = { 'data-jsails-submit': 'save', method: 'dialog' } as const;

function rejects(vnode: VNode): void {
  assert.throws(
    () => assertInertForms(renderToString(vnode)),
    (error: unknown) =>
      error instanceof ServerComponentRuntimeError &&
      error.code === 'invalid_definition' &&
      !error.message.includes('/elsewhere'),
  );
}

function accepts(vnode: VNode): void {
  assert.doesNotThrow(() => assertInertForms(renderToString(vnode)));
}

describe('assertInertForms', () => {
  it('accepts a bound dialog form, its plain submit button, and unbound forms', () => {
    accepts(
      <div>
        <form {...BOUND} class='a"b>c'>
          <input name="title" value={'a "quoted" > value'} />
          <button type="submit" formmethod="dialog">
            Save
          </button>
        </form>
        <form action="/search" method="get">
          <button formaction="/other">Plain forms are not ours</button>
        </form>
      </div>,
    );
    accepts(<p>data-jsails-submit is only text here</p>);
  });

  it('rejects a bound form whose method an author overrode after the spread', () => {
    rejects(<form {...BOUND} method="post" />);
    rejects(<form {...BOUND} method="get" />);
    rejects(<form data-jsails-submit="save" />);
  });

  it('rejects a bound form with an action', () => {
    rejects(<form {...BOUND} action="/elsewhere" />);
  });

  it('rejects a submitter that overrides the bound form', () => {
    rejects(
      <form {...BOUND}>
        <button formaction="/elsewhere">Go</button>
      </form>,
    );
    rejects(
      <form {...BOUND}>
        <input type="submit" formmethod="post" />
      </form>,
    );
  });

  it('rejects a submitter outside the bound form that targets it with a form attribute', () => {
    rejects(
      <div>
        <form id="edit" {...BOUND}>
          <input name="title" />
        </form>
        <footer>
          <button form="edit" formmethod="get">
            Save
          </button>
        </footer>
      </div>,
    );
  });

  it('rejects an override whose owner a form attribute names, since that is document-wide', () => {
    // The first element with the id in the whole page owns the submitter, and
    // that may be another component's bound form.
    rejects(
      <div>
        <form id="search" action="/search" />
        <button form="search" formaction="/elsewhere">
          Go
        </button>
      </div>,
    );
    rejects(
      <form action="/search">
        <button form="other" formaction="/elsewhere">
          Go
        </button>
      </form>,
    );
  });

  it('rejects an override outside any form: its owner is whatever form encloses the component', () => {
    rejects(<button formaction="/elsewhere">Go</button>);
    rejects(<input type="submit" formmethod="post" />);
    accepts(<button formmethod="dialog">Close</button>);
  });

  it('reads form ownership as the parser does: a nested form start tag is dropped', () => {
    // The inner form never exists after parsing, so its submitter belongs to
    // the bound form around it.
    rejects(
      <form {...BOUND}>
        <form action="/search">
          <button formaction="/elsewhere">Go</button>
        </form>
      </form>,
    );
    // After the bound form closes, a later unbound form owns its submitters.
    accepts(
      <div>
        <form {...BOUND} />
        <form action="/search">
          <button formaction="/other">Go</button>
        </form>
      </div>,
    );
  });

  it('checks every bound form, not only the first', () => {
    rejects(
      <div>
        <form {...BOUND} />
        <form {...BOUND} method="post" />
      </div>,
    );
  });

  it('skips a start tag it cannot read rather than guessing', () => {
    assert.doesNotThrow(() =>
      assertInertForms(`<form data-jsails-submit='save' method='post'></form>`),
    );
  });
});

describe('component render', () => {
  const KEY = '0123456789abcdef0123456789abcdef';
  const context: RequestContext = {
    request: new Request('http://localhost/page'),
    url: new URL('http://localhost/page'),
    params: {},
    session: null,
  };

  function runtimeFor(render: (tools: ServerComponentRenderTools<{}>) => VNode) {
    return createServerComponentsRuntime({
      components: componentRegistryFromMap({
        Form: defineServerComponent({
          name: 'Form',
          stateSchema: z.object({}).strict(),
          initialState: () => ({}),
          authorize: () => true,
          actions: { save: defineAction({ input: z.object({}), run() {} }) },
          render: (_state, tools) => render(tools),
        }),
      }),
      signer: new HmacComponentSigner({ key: KEY, now: () => 0 }),
    });
  }

  it('renders submit() forms inert', async () => {
    const html = await runtimeFor(({ submit }) => <form {...submit('save')} />).render(
      'Form',
      context,
    );
    assert.match(html, /<form data-jsails-submit="save" method="dialog" data-turbo="false"/);
  });

  describe('nested children', () => {
    function nestedRuntime(childRender: () => VNode, inParentForm: boolean) {
      const runtime = createServerComponentsRuntime({
        components: componentRegistryFromMap({
          Parent: defineServerComponent({
            name: 'Parent',
            stateSchema: z.object({}).strict(),
            initialState: () => ({}),
            authorize: () => true,
            actions: { save: defineAction({ input: z.object({}), run() {} }) },
            async render(_state, { submit, context: renderContext }) {
              const child = await renderNested('Child', renderContext);
              return inParentForm ? (
                <form {...submit('save')}>{child}</form>
              ) : (
                <div>
                  <form {...submit('save')} />
                  {child}
                </div>
              );
            },
          }),
          Child: defineServerComponent({
            name: 'Child',
            stateSchema: z.object({}).strict(),
            initialState: () => ({}),
            authorize: () => true,
            render: childRender,
          }),
        }),
        signer: new HmacComponentSigner({ key: KEY, now: () => 0 }),
      });
      const registry = createServiceRegistry();
      registry.registrar.provide(serverComponentsToken, runtime);
      registry.seal();
      return { runtime, context: { ...context, services: registry.services } };
    }

    const invalid = (error: unknown): boolean =>
      error instanceof ServerComponentRuntimeError && error.code === 'invalid_definition';

    it('fails a child override outside any form in the child render itself', async () => {
      // The child cannot see the parent's bound form, and a later refresh of
      // the child alone renders without the parent, so its own render refuses.
      const { runtime, context: nestedContext } = nestedRuntime(
        () => (
          <button formmethod="post" formaction="/elsewhere">
            Go
          </button>
        ),
        true,
      );
      await assert.rejects(
        runtime.render('Parent', nestedContext),
        (error: unknown) => error instanceof NestedComponentError && error.code === 'render_failed',
      );
      await assert.rejects(runtime.render('Child', nestedContext), invalid);
    });

    it('rejects a child form inside the parent bound form, which the parser drops', async () => {
      const { runtime, context: nestedContext } = nestedRuntime(
        () => (
          <form action="/search">
            <button formaction="/elsewhere">Go</button>
          </form>
        ),
        true,
      );
      await assert.rejects(runtime.render('Parent', nestedContext), invalid);
    });

    it('accepts a child override inside its own unbound form outside the parent bound form', async () => {
      const { runtime, context: nestedContext } = nestedRuntime(
        () => (
          <form action="/search">
            <button formaction="/other">Go</button>
          </form>
        ),
        false,
      );
      assert.match(await runtime.render('Parent', nestedContext), /formaction="\/other"/);
    });
  });

  it('fails the render closed when the spread order lets the form navigate', async () => {
    await assert.rejects(
      runtimeFor(({ submit }) => <form {...submit('save')} method="post" />).render(
        'Form',
        context,
      ),
      (error: unknown) =>
        error instanceof ServerComponentRuntimeError && error.code === 'invalid_definition',
    );
  });
});
