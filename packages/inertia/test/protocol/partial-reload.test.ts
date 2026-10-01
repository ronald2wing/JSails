/**
 * Partial reloads against the Inertia v3 protocol (P-9 Partial Reloads; clause
 * numbering as in props.test.ts), the request-header parser, and a seeded
 * property test that compares the engine with a direct reference model of
 * P-8 and P-9 transcribed from inertia-laravel `PropsResolver`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { always, defer, optional, readInertiaVisit } from '../../src/index.js';
import { partialSelection, selectsMetadata, selectsPath } from '../../src/partial-reload.js';
import { partialHeaders, resolveWith } from './visit-fixture.js';

describe('request headers', () => {
  it('parse every v3 header the server reads', () => {
    const visit = readInertiaVisit(
      new Headers({
        'X-Inertia': 'true',
        'X-Inertia-Version': 'v2',
        'X-Inertia-Partial-Component': 'Users',
        'X-Inertia-Partial-Data': ' users , ,stats',
        'X-Inertia-Partial-Except': 'stats',
        'X-Inertia-Reset': 'users',
        'X-Inertia-Except-Once-Props': 'plans,countries',
        'X-Inertia-Error-Bag': ' createUser ',
        'X-Inertia-Infinite-Scroll-Merge-Intent': 'prepend',
        Purpose: 'prefetch',
      }),
    );
    assert.deepEqual(visit, {
      isInertia: true,
      version: 'v2',
      partial: { component: 'Users', only: ['users', 'stats'], except: ['stats'] },
      reset: ['users'],
      exceptOnce: ['plans', 'countries'],
      errorBag: 'createUser',
      mergeIntent: 'prepend',
      prefetch: true,
    });
  });

  it('read absent headers as the reference defaults', () => {
    assert.deepEqual(readInertiaVisit(new Headers()), {
      isInertia: false,
      version: '',
      partial: null,
      reset: [],
      exceptOnce: [],
      errorBag: null,
      mergeIntent: 'append',
      prefetch: false,
    });
    const visit = readInertiaVisit(
      new Headers({ 'X-Inertia-Partial-Component': 'Users', 'X-Inertia-Partial-Data': ' , ' }),
    );
    assert.deepEqual(visit.partial, { component: 'Users', only: null, except: null });
  });
});

describe('partial selection rules', () => {
  const selection = { only: ['auth.user', 'stats'], except: ['stats.secret'] };

  it('select a listed path, its descendants, and its ancestors', () => {
    assert.equal(selectsPath(selection, 'auth'), true);
    assert.equal(selectsPath(selection, 'auth.user'), true);
    assert.equal(selectsPath(selection, 'auth.user.name'), true);
    assert.equal(selectsPath(selection, 'auth.token'), false);
    assert.equal(selectsPath(selection, 'authx'), false);
    assert.equal(selectsPath(selection, 'stats.secret'), false);
    assert.equal(selectsPath(selection, 'stats.secret.deep'), false);
  });

  it('give metadata only to listed paths and descendants, not ancestors', () => {
    assert.equal(selectsMetadata(selection, 'auth'), false);
    assert.equal(selectsMetadata(selection, 'auth.user'), true);
    assert.equal(selectsMetadata({ only: null, except: ['a'] }, 'b'), true);
  });

  it('apply only to the same component', () => {
    const visit = readInertiaVisit(new Headers(partialHeaders('Users', { only: 'a' })));
    assert.deepEqual(partialSelection(visit, 'Users'), { only: ['a'], except: null });
    assert.equal(partialSelection(visit, 'Auth/Login'), null);
  });
});

describe('P-9 partial reloads', () => {
  it('returns only the requested props plus errors (protocol example)', async () => {
    const { props } = await resolveWith(
      'Events',
      { events: () => [{ id: 1 }], categories: () => ['x'] },
      partialHeaders('Events', { only: 'events' }),
    );
    assert.deepEqual(props, { errors: {}, events: [{ id: 1 }] });
  });

  it('answers a different component as a full visit, ignoring Data', async () => {
    const { props, metadata } = await resolveWith(
      'Auth/Login',
      { form: { email: '' }, tip: optional(() => 'tip'), news: defer(() => []) },
      partialHeaders('Users', { only: 'users' }),
    );
    assert.deepEqual(props, { errors: {}, form: { email: '' } });
    assert.deepEqual(metadata.deferredProps, { default: ['news'] });
  });

  it('narrows to Data, then removes Except; a prop in both is left out', async () => {
    const { props } = await resolveWith(
      'P',
      { a: 1, b: 2, c: 3 },
      partialHeaders('P', { only: 'a,b', except: 'b' }),
    );
    assert.deepEqual(props, { errors: {}, a: 1 });
  });

  it('keeps errors and always props whatever Data and Except say (test_always_props_are_included_on_partial_reload)', async () => {
    const { props } = await resolveWith(
      'P',
      { a: 1, auth: always(() => ({ id: 1 })), b: 2 },
      partialHeaders('P', { only: 'a', except: 'auth,errors' }),
      { errors: { name: 'Required' } },
    );
    assert.deepEqual(props, { errors: { name: 'Required' }, a: 1, auth: { id: 1 } });
  });

  it('applies dot paths inside literal objects (test_nested_partial_props)', async () => {
    const { props } = await resolveWith(
      'User/Edit',
      {
        auth: {
          user: optional(() => ({ name: 'Jonathan Reinink', email: 'jonathan@example.com' })),
          refresh_token: 'value',
          token: 'value',
        },
        shared: { flash: 'value' },
      },
      partialHeaders('User/Edit', { only: 'auth.user,auth.refresh_token' }),
    );
    assert.deepEqual(props, {
      errors: {},
      auth: {
        user: { name: 'Jonathan Reinink', email: 'jonathan@example.com' },
        refresh_token: 'value',
      },
    });
  });

  it('excludes a nested path inside a selected parent (test_exclude_nested_props_from_partial_response)', async () => {
    const { props } = await resolveWith(
      'User/Edit',
      {
        auth: { user: optional(() => ({ name: 'J' })), refresh_token: 'value' },
        shared: { flash: 'value' },
      },
      partialHeaders('User/Edit', { only: 'auth', except: 'auth.user' }),
    );
    assert.deepEqual(props, { errors: {}, auth: { refresh_token: 'value' } });
  });

  it('returns a lazy prop whole when a dot path points inside it', async () => {
    const { props } = await resolveWith(
      'User/Edit',
      { user: () => ({ name: 'Ada', email: 'ada@example.test' }), other: 1 },
      partialHeaders('User/Edit', { only: 'user.name' }),
    );
    assert.deepEqual(props, { errors: {}, user: { name: 'Ada', email: 'ada@example.test' } });
  });

  it('resolves optional and deferred props on an Except-only reload', async () => {
    const { props } = await resolveWith(
      'P',
      { a: optional(() => 'a'), b: defer(() => 'b'), c: 1 },
      partialHeaders('P', { except: 'c' }),
    );
    assert.deepEqual(props, { errors: {}, a: 'a', b: 'b' });
  });
});

// ---------------------------------------------------------------------------
// Reference-model property test
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG, so a failing case reproduces from its seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type ModelNode =
  | { readonly type: 'literal'; readonly value: unknown }
  | { readonly type: 'object'; readonly children: Readonly<Record<string, ModelNode>> }
  | { readonly type: 'lazy' | 'always' | 'optional' | 'defer'; readonly group: string };

const KEYS = ['a', 'b', 'c', 'd'] as const;
const GROUPS = ['default', 'side'] as const;

/** What the resolver at `path` returns: sometimes an object, to test whole returns. */
function resolvedValue(path: string): unknown {
  return path.length % 2 === 0 ? { at: path, nested: { deep: path } } : `value:${path}`;
}

function generateTree(random: () => number, depth: number): Record<string, ModelNode> {
  const tree: Record<string, ModelNode> = {};
  for (const key of KEYS) {
    if (random() < 0.3) continue;
    const roll = random();
    const group = GROUPS[Math.floor(random() * GROUPS.length)] ?? 'default';
    if (depth < 3 && roll < 0.25) {
      tree[key] = { type: 'object', children: generateTree(random, depth + 1) };
    } else if (roll < 0.4) {
      tree[key] = { type: 'literal', value: random() < 0.5 ? [1, 2] : `lit:${key}${depth}` };
    } else if (roll < 0.6) {
      tree[key] = { type: 'lazy', group };
    } else if (roll < 0.72) {
      tree[key] = { type: 'always', group };
    } else if (roll < 0.86) {
      tree[key] = { type: 'optional', group };
    } else {
      tree[key] = { type: 'defer', group };
    }
  }
  return tree;
}

/** Random dot paths over the key alphabet, existing or not. */
function generatePaths(random: () => number): string {
  const count = Math.floor(random() * 4);
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const length = 1 + Math.floor(random() * 3);
    const segments: string[] = [];
    for (let depth = 0; depth < length; depth += 1) {
      segments.push(KEYS[Math.floor(random() * KEYS.length)] ?? 'a');
    }
    paths.push(segments.join('.'));
  }
  return paths.join(',');
}

/** Build the engine's props tree, recording every resolver call. */
function toProps(
  tree: Readonly<Record<string, ModelNode>>,
  prefix: string,
  calls: Set<string>,
): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(tree)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const resolve = () => {
      calls.add(path);
      return resolvedValue(path);
    };
    switch (node.type) {
      case 'literal':
        props[key] = node.value;
        break;
      case 'object':
        props[key] = toProps(node.children, path, calls);
        break;
      case 'lazy':
        props[key] = resolve;
        break;
      case 'always':
        props[key] = always(resolve);
        break;
      case 'optional':
        props[key] = optional(resolve);
        break;
      case 'defer':
        props[key] = defer(resolve, { group: node.group });
        break;
    }
  }
  return props;
}

interface ModelResult {
  readonly props: Record<string, unknown>;
  readonly resolved: Set<string>;
  readonly deferred: Record<string, string[]>;
}

/**
 * The reference model: a sequential walk written straight from P-8/P-9 and
 * inertia-laravel `PropsResolver::resolveProps`, with arrays atomic.
 */
function referenceModel(
  tree: Readonly<Record<string, ModelNode>>,
  partial: { readonly only: string[] | null; readonly except: string[] | null } | null,
): ModelResult {
  const resolved = new Set<string>();
  const deferred: Record<string, string[]> = {};
  const under = (path: string, parent: string) => path === parent || path.startsWith(`${parent}.`);
  const selected = (path: string): boolean => {
    if (partial === null) return true;
    if (
      partial.only !== null &&
      !partial.only.some((entry) => under(path, entry)) &&
      !partial.only.some((entry) => entry.startsWith(`${path}.`))
    ) {
      return false;
    }
    return partial.except === null || !partial.except.some((entry) => under(path, entry));
  };
  const walk = (node: Readonly<Record<string, ModelNode>>, prefix: string) => {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (partial !== null && child.type !== 'always' && !selected(path)) continue;
      if (partial === null && (child.type === 'optional' || child.type === 'defer')) {
        if (child.type === 'defer') (deferred[child.group] ??= []).push(path);
        continue;
      }
      if (child.type === 'literal') out[key] = child.value;
      else if (child.type === 'object') out[key] = walk(child.children, path);
      else {
        resolved.add(path);
        out[key] = resolvedValue(path);
      }
    }
    return out;
  };
  return { props: { errors: {}, ...walk(tree, '') }, resolved, deferred };
}

describe('reference-model property test (P-8, P-9)', () => {
  it('matches the model and never calls an unselected resolver', async () => {
    const SEED = 0x1ae7_2026;
    const random = prng(SEED);
    for (let iteration = 0; iteration < 600; iteration += 1) {
      const tree = generateTree(random, 0);
      const componentRoll = random();
      const only = random() < 0.6 ? generatePaths(random) : undefined;
      const except = random() < 0.4 ? generatePaths(random) : undefined;
      const headers =
        componentRoll < 0.15
          ? {}
          : partialHeaders(componentRoll < 0.25 ? 'Other' : 'Page', {
              ...(only === undefined ? {} : { only }),
              ...(except === undefined ? {} : { except }),
            });
      const visit = readInertiaVisit(new Headers(headers));
      const selection = partialSelection(visit, 'Page');
      const expected = referenceModel(
        tree,
        selection === null
          ? null
          : {
              only: selection.only === null ? null : [...selection.only],
              except: selection.except === null ? null : [...selection.except],
            },
      );
      const calls = new Set<string>();
      const { props, metadata } = await resolveWith('Page', toProps(tree, '', calls), headers);
      const label = `seed ${SEED} iteration ${iteration} headers ${JSON.stringify(headers)}`;
      assert.deepEqual(props, expected.props, label);
      assert.deepEqual([...calls].sort(), [...expected.resolved].sort(), label);
      assert.deepEqual(metadata.deferredProps ?? {}, expected.deferred, label);
    }
  });
});
