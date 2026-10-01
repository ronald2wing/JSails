/**
 * Tests for the kind table: each kind sfcKind derives has a spec, the function kinds differ exactly in name, props, context, await, slots, macros, serverOnly, live mounts, hooks and what an island tag becomes, the live kind takes its names from state, and the kind whose lowering has not landed says what it compiles to.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SFC_KINDS } from '../../../src/compiler/conventions.js';
import {
  isFunctionKind,
  kindSpec,
  LIVE_KIND,
  SFC_MACROS,
  type SfcKindSpec,
  type SfcLoweredSpec,
} from '../../../src/compiler/sfc/kinds.js';

function functionKind(kind: (typeof SFC_KINDS)[number]): SfcKindSpec {
  const spec = kindSpec(kind);
  assert.ok(isFunctionKind(spec), kind);
  return spec;
}

/** Every kind with a lowering, and its spec. */
function loweredSpecs(): [string, SfcLoweredSpec][] {
  return SFC_KINDS.flatMap((kind): [string, SfcLoweredSpec][] => {
    const spec = kindSpec(kind);
    return 'hooks' in spec ? [[kind, spec]] : [];
  });
}

describe('kindSpec', () => {
  it('has a spec for every kind, naming the kind', () => {
    for (const kind of SFC_KINDS) assert.equal(kindSpec(kind).kind, kind);
  });

  it('compiles the page tree, views and islands to functions, live components to definitions, and mails not yet', () => {
    assert.deepEqual(
      SFC_KINDS.filter((kind) => isFunctionKind(kindSpec(kind))),
      ['page', 'layout', 'error', 'not-found', 'island', 'view'],
    );
    assert.equal(kindSpec('live'), LIVE_KIND);
    const mail = kindSpec('mail');
    assert.ok(!isFunctionKind(mail) && 'compilesTo' in mail);
    assert.ok(mail.compilesTo.length > 0);
  });

  it('gives an island macro props, slots, events and hooks, and no context, await or mounts', () => {
    const island = functionKind('island');
    assert.equal(island.functionName, null);
    assert.equal(island.props, 'macro');
    assert.equal(island.context, false);
    assert.equal(island.mayAwait, false);
    assert.equal(island.slots, true);
    assert.deepEqual(island.macros, ['defineProps', 'defineSlots', 'defineEmits']);
    assert.equal(island.mountsLive, false);
    assert.equal(island.serverOnly, false);
  });

  it('allows hooks in islands only, and mounts island tags where the template renders on the server', () => {
    assert.deepEqual(
      loweredSpecs()
        .filter(([, spec]) => spec.hooks)
        .map(([kind]) => kind),
      ['island'],
    );
    assert.deepEqual(
      Object.fromEntries(loweredSpecs().map(([kind, spec]) => [kind, spec.islands])),
      {
        page: 'mount',
        layout: 'mount',
        error: 'mount',
        'not-found': 'mount',
        live: 'refuse',
        island: 'component',
        view: 'mount',
      },
    );
  });

  it('gives a live component state names, await, no slots and no mounts', () => {
    assert.equal(LIVE_KIND.props, 'state');
    assert.equal(LIVE_KIND.mayAwait, true);
    assert.equal(LIVE_KIND.slots, false);
    assert.deepEqual(LIVE_KIND.macros, []);
    assert.equal(LIVE_KIND.mountsLive, false);
    assert.equal(LIVE_KIND.serverOnly, false);
  });

  it('mounts live components in pages, layouts and the not-found page only', () => {
    assert.deepEqual(
      (['page', 'layout', 'error', 'not-found', 'view'] as const).filter(
        (kind) => functionKind(kind).mountsLive,
      ),
      ['page', 'layout', 'not-found'],
    );
  });

  it('reserves page-tree function names and names a view after its file', () => {
    assert.deepEqual(
      (['page', 'layout', 'error', 'not-found', 'view'] as const).map(
        (kind) => functionKind(kind).functionName,
      ),
      ['__Page', '__Layout', '__ErrorPage', '__NotFoundPage', null],
    );
  });

  it('gives page-tree kinds the request context and await, and views neither', () => {
    for (const kind of ['page', 'layout', 'error', 'not-found'] as const) {
      const spec = functionKind(kind);
      assert.equal(spec.context, true, kind);
      assert.equal(spec.mayAwait, true, kind);
    }
    const view = functionKind('view');
    assert.equal(view.context, false);
    assert.equal(view.mayAwait, false);
  });

  it('takes props from load, the error, or the macros', () => {
    assert.equal(functionKind('page').props, 'load');
    assert.equal(functionKind('not-found').props, 'load');
    assert.equal(functionKind('error').props, 'error');
    assert.equal(functionKind('layout').props, 'macro');
    assert.equal(functionKind('view').props, 'macro');
  });

  it('allows slots and the props macros only where a parent passes children', () => {
    for (const kind of ['page', 'error', 'not-found'] as const) {
      assert.equal(functionKind(kind).slots, false, kind);
      assert.deepEqual(functionKind(kind).macros, [], kind);
    }
    for (const kind of ['layout', 'view'] as const) {
      assert.equal(functionKind(kind).slots, true, kind);
      assert.deepEqual(functionKind(kind).macros, ['defineProps', 'defineSlots'], kind);
    }
    assert.equal(functionKind('layout').children, true);
    assert.equal(functionKind('view').children, false);
  });

  it('marks only pages SERVER_ONLY from their serverOnly export', () => {
    assert.deepEqual(
      (['page', 'layout', 'error', 'not-found', 'view'] as const).filter(
        (kind) => functionKind(kind).serverOnly,
      ),
      ['page', 'not-found'],
    );
  });

  it('lists every macro', () => {
    assert.deepEqual(SFC_MACROS, ['defineProps', 'defineSlots', 'defineEmits', 'defineLive']);
  });
});
