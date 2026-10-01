/**
 * Tests for dashboard widgets: descriptor validation, the stat cards the
 * dashboard renders from each widget's trusted (escaped) `render` value, and
 * the progress/list widget kinds. A hostile widget value never reaches the
 * document raw, and a throwing widget renders empty without failing the page.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AdminDefinitionError,
  defineListWidget,
  defineProgressWidget,
  defineWidget,
  type AdminWidgetContext,
  type Widget,
} from '../src/index.js';
import { createAdminTestApp, SESSION } from './fixtures.js';

describe('admin widget descriptor validation', () => {
  it('rejects an empty name, empty label, or missing render', () => {
    assert.throws(
      () => defineWidget({ name: ' ', label: 'x', render: () => 1 }),
      AdminDefinitionError,
    );
    assert.throws(
      () => defineWidget({ name: 'x', label: ' ', render: () => 1 }),
      AdminDefinitionError,
    );
    assert.throws(
      () =>
        defineWidget({
          name: 'x',
          label: 'x',
          // @ts-expect-error — a missing `render` must be rejected at runtime.
          render: undefined,
        }),
      AdminDefinitionError,
    );
  });

  it('freezes a valid descriptor', () => {
    const widget = defineWidget({ name: 'count', label: 'Count', render: () => 1 });
    assert.equal(Object.isFrozen(widget), true);
  });
});

describe('admin dashboard widgets', () => {
  it('renders each widget label and its escaped value', async () => {
    const app = await createAdminTestApp({
      widgets: [
        defineWidget({ name: 'count', label: 'Articles', render: () => 42 }),
        defineWidget({ name: 'recent', label: 'Recent', render: () => 'First post' }),
      ],
    });

    const body = await (await app.request('/admin')).text();
    assert.match(body, /admin-widget/);
    assert.match(body, /Articles/);
    assert.match(body, />42</);
    assert.match(body, /Recent/);
    assert.match(body, /First post/);

    await app.close();
  });

  it('escapes a hostile widget value instead of emitting it raw', async () => {
    const app = await createAdminTestApp({
      widgets: [
        defineWidget({ name: 'evil', label: 'Evil', render: () => '<script>alert(1)</script>' }),
      ],
    });

    const body = await (await app.request('/admin')).text();
    assert.doesNotMatch(body, /<script>/);
    assert.match(body, /&lt;script>alert\(1\)&lt;\/script>/);

    await app.close();
  });

  it('renders an empty value when a widget render throws, without failing the page', async () => {
    const app = await createAdminTestApp({
      widgets: [
        defineWidget({
          name: 'broken',
          label: 'Broken',
          render: () => {
            throw new Error('boom');
          },
        }),
        defineWidget({ name: 'fine', label: 'Fine', render: () => 'ok' }),
      ],
    });

    const response = await app.request('/admin');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /Fine/);
    assert.match(body, />ok</);

    await app.close();
  });

  it('passes the session and panel path to the render callback', async () => {
    const seen: AdminWidgetContext[] = [];
    const app = await createAdminTestApp({
      widgets: [
        defineWidget({
          name: 'ctx',
          label: 'Context',
          render: (context) => {
            seen.push(context);
            return context.path;
          },
        }),
      ],
    });

    await (await app.request('/admin')).text();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.session.id, SESSION.id);
    assert.equal(seen[0]!.path, '/admin');

    await app.close();
  });

  it('rejects a non-array widgets value and duplicate widget names', () => {
    assert.throws(
      () => createAdminTestApp({ widgets: 'nope' as unknown as readonly Widget[] }),
      AdminDefinitionError,
    );
    const widgets = [
      defineWidget({ name: 'dup', label: 'A', render: () => 1 }),
      defineWidget({ name: 'dup', label: 'B', render: () => 2 }),
    ];
    assert.throws(() => createAdminTestApp({ widgets }), AdminDefinitionError);
  });
});

describe('widget kinds', () => {
  it('defineProgressWidget renders a bounded percentage', async () => {
    const w = defineProgressWidget({ name: 'p', label: 'P', value: () => 5, max: 10 });
    assert.equal(await w.render({ session: SESSION, path: '/admin' }), '50%');
  });

  it('defineListWidget renders a joined list', async () => {
    const w = defineListWidget({ name: 'l', label: 'L', items: () => ['a', 'b'] });
    assert.equal(await w.render({ session: SESSION, path: '/admin' }), 'a, b');
  });

  it('rejects a progress widget with a non-positive max', () => {
    assert.throws(
      () => defineProgressWidget({ name: 'p', label: 'P', value: () => 1, max: 0 }),
      AdminDefinitionError,
    );
  });
});
