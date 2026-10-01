/**
 * Tests for defineIsland and <Island>: an island id is a bounded path that is no prototype member and is fixed once defined; <Island> renders the marker element with the id, the props as JSON and the island's render from the decoded props, with no style attribute (ISLAND_STYLE, a stylesheet rule, lays it out with display: contents), renders a nested island inline, and refuses a component that is not an island and props that cannot cross as JSON.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Window } from 'happy-dom';
import { createElement } from 'preact';
import { renderToString } from 'preact-render-to-string';

import {
  defineIsland,
  Island,
  IslandErrors,
  ISLAND_STYLE,
  type ComponentChild,
} from '../../src/view/index.js';
import { islandIdOf } from '../../src/view/island.js';

function throwsCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => IslandErrors.is(error) && error.code === `island.${code}`);
}

describe('defineIsland', () => {
  it('names the component with its id, as a non-enumerable property', () => {
    const Counter = defineIsland('admin/counter', (props: { start: number }) => props.start);
    assert.equal(Counter.islandId, 'admin/counter');
    assert.equal(islandIdOf(Counter), 'admin/counter');
    assert.deepEqual(Object.keys(Counter), []);
  });

  it('refuses an id the registry and the markup could not hold', () => {
    for (const id of [
      '',
      '/a',
      'a/',
      'a//b',
      'a b',
      'a"b',
      '__proto__',
      'toString',
      'x'.repeat(201),
    ]) {
      throwsCode(() => defineIsland(id, () => null), 'invalid_id');
    }
  });

  it('keeps an id once defined', () => {
    const component = (): ComponentChild => null;
    const first = defineIsland('kept', component);
    assert.equal(defineIsland('kept', component), first);
    throwsCode(() => defineIsland('other', component), 'redefined');
  });

  it('gives no id to a plain function or a non-function', () => {
    assert.equal(
      islandIdOf(() => null),
      undefined,
    );
    assert.equal(islandIdOf({ islandId: 'x' }), undefined);
  });
});

describe('Island', () => {
  const Counter = defineIsland('counter', (props: { start: number; label: string }) =>
    createElement('button', null, `${props.label} ${props.start}`),
  );

  it('renders the marker element around the server render', () => {
    const html = renderToString(
      createElement(Island<{ start: number; label: string }>, {
        component: Counter,
        props: { start: 2, label: 'a<b' },
      }),
    );
    assert.equal(
      html,
      '<jsails-island data-jsails-island="counter" data-jsails-props="{&quot;start&quot;:2,&quot;label&quot;:&quot;a&lt;b&quot;}"><button>a&lt;b 2</button></jsails-island>',
    );
  });

  it('writes no style attribute, which a CSP nonce cannot allow, and ISLAND_STYLE lays the marker out', async () => {
    const html = renderToString(
      createElement(Island<{ start: number; label: string }>, {
        component: Counter,
        props: { start: 0, label: 'a' },
      }),
    );
    assert.doesNotMatch(html, /style=/);
    const window = new Window({ url: 'http://localhost/' });
    try {
      window.document.write(
        `<!doctype html><html><head><style>${ISLAND_STYLE}</style></head><body><div>${html}</div></body></html>`,
      );
      const marker = window.document.querySelector('[data-jsails-island="counter"]');
      assert.ok(marker !== null);
      assert.equal(window.getComputedStyle(marker).display, 'contents');
    } finally {
      await window.happyDOM.close();
    }
  });

  it('renders from the props the browser will decode', () => {
    const When = defineIsland('when', (props: { at: string }) =>
      createElement('i', null, typeof props.at),
    );
    // A Date the types refuse still reaches the server as its JSON string.
    const at = new Date(0) as unknown as string;
    const html = renderToString(
      createElement(Island<{ at: string }>, { component: When, props: { at } }),
    );
    assert.match(html, /<i>string<\/i>/);
  });

  it('renders an island inside another island inline', () => {
    const Outer = defineIsland('outer', () =>
      createElement(Island<{ start: number; label: string }>, {
        component: Counter,
        props: { start: 1, label: 'in' },
      }),
    );
    const html = renderToString(
      createElement(Island<Record<never, never>>, { component: Outer, props: {} }),
    );
    assert.equal(
      html,
      '<jsails-island data-jsails-island="outer" data-jsails-props="{}"><button>in 1</button></jsails-island>',
    );
  });

  it('refuses a component that is not a defined island', () => {
    const plain = (() => null) as unknown as typeof Counter;
    throwsCode(
      () =>
        renderToString(
          createElement(Island<{ start: number; label: string }>, {
            component: plain,
            props: { start: 1, label: '' },
          }),
        ),
      'not_defined',
    );
  });

  it('refuses props that cannot cross as JSON', () => {
    const Big = defineIsland('big', (_props: { n: number }) => null);
    throwsCode(
      () =>
        renderToString(
          createElement(Island<{ n: number }>, {
            component: Big,
            props: { n: 1n } as unknown as { n: number },
          }),
        ),
      'props_unserializable',
    );
  });
});
