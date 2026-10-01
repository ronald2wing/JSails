/**
 * Prop descriptors and the resolution engine against the Inertia v3 protocol.
 *
 * Clause ids number the H2 sections of
 * <https://inertiajs.com/docs/v3/core-concepts/the-protocol> (checked
 * 2026-11-19): P-7 The Page Object, P-8 Prop Evaluation Model, P-9 Partial
 * Reloads, P-10 Deferred and Optional Props, P-11 Merging Props, P-12 Once
 * Props, P-14 Infinite Scroll, P-17 Validation Errors. Where the page defers
 * to the reference adapter, the row names the inertia-laravel test it is
 * transcribed from (`tests/ResponseTest.php`, `tests/MiddlewareTest.php`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  always,
  buildInertiaPage,
  defer,
  InertiaError,
  isInertiaProp,
  merge,
  once,
  optional,
  scroll,
  shapeErrorBags,
  type InertiaPropContext,
} from '../../src/index.js';
import { propSpec } from '../../src/props.js';
import { resolveProps } from '../../src/resolve-props.js';
import { partialHeaders, request, resolveWith } from './visit-fixture.js';

const INERTIA = { 'X-Inertia': 'true' } as const;

function code(expected: string): (error: unknown) => boolean {
  return (error) => error instanceof InertiaError && error.code === expected;
}

/** A resolver that records each call. */
function tracked<T>(value: T): { readonly resolve: () => T; readonly calls: () => number } {
  let calls = 0;
  return {
    resolve: () => {
      calls += 1;
      return value;
    },
    calls: () => calls,
  };
}

describe('prop descriptors', () => {
  it('are frozen, branded objects that look-alike data is never mistaken for', () => {
    const prop = defer(() => 1, { group: 'sidebar' });
    assert.equal(prop.kind, 'defer');
    assert.ok(Object.isFrozen(prop));
    assert.ok(isInertiaProp(prop));
    assert.equal(isInertiaProp({ kind: 'defer' }), false);
    assert.equal(propSpec(prop)?.group, 'sidebar');
  });

  it('reject invalid options when built, value-free', () => {
    const cases: readonly (() => unknown)[] = [
      () => defer('not a function' as unknown as () => number),
      () => optional(42 as unknown as () => number),
      () => defer(() => 1, { group: '' }),
      () => defer(() => 1, { group: 'a,b' }),
      () => defer(() => 1, { group: '__proto__' }),
      () => once(1, { expiresAt: 10, ttlMs: 10 }),
      () => once(1, { ttlMs: 0 }),
      () => once(1, { ttlMs: 1.5 }),
      () => once(1, { expiresAt: Number.NaN }),
      () => once(1, { key: 'x,y' }),
      () => merge([1], { matchOn: '' }),
      () => merge([1], { mode: 'sideways' as 'append' }),
      () =>
        scroll({ data: [], currentPage: 1, previousPage: null, nextPage: null }, { pageName: '' }),
      () => always(once(1)),
    ];
    for (const build of cases) {
      assert.throws(build, (error: unknown) => {
        assert.ok(error instanceof InertiaError);
        assert.equal(error.code, 'invalid_options');
        assert.equal(error.message, 'Inertia options are invalid');
        return true;
      });
    }
  });
});

describe('P-8 full visit', () => {
  it('resolves regular, lazy, and always props; leaves optional out unannounced', async () => {
    const lazy = tracked('lazy value');
    const opt = tracked('optional value');
    const { props, metadata } = await resolveWith('Users', {
      users: [],
      lazy: lazy.resolve,
      kept: always(() => 'always value'),
      optional: optional(opt.resolve),
    });
    assert.deepEqual(props, {
      errors: {},
      users: [],
      lazy: 'lazy value',
      kept: 'always value',
    });
    assert.deepEqual(metadata, {});
    assert.equal(opt.calls(), 0);
  });

  it('puts errors first and defaults it to an empty object (P-7)', async () => {
    const { props } = await resolveWith('Users', { a: 1 }, {}, { errors: { name: 'Required' } });
    assert.deepEqual(Object.keys(props), ['errors', 'a']);
    assert.deepEqual(props.errors, { name: 'Required' });
  });

  it('reserves the errors key in props and shared props', async () => {
    await assert.rejects(resolveWith('Users', { errors: {} }), code('invalid_prop_key'));
    await assert.rejects(
      resolveWith('Users', {}, {}, { shared: { errors: {} } }),
      code('invalid_prop_key'),
    );
  });

  it('walks literal objects to nested descriptors (PropsResolverTest test_nested_defer_prop_is_excluded_from_initial_load)', async () => {
    const { props, metadata } = await resolveWith('Dash', {
      auth: { user: { name: 'Ada' }, permissions: defer(() => ['admin'], { group: 'auth' }) },
    });
    assert.deepEqual(props, { errors: {}, auth: { user: { name: 'Ada' } } });
    assert.deepEqual(metadata.deferredProps, { auth: ['auth.permissions'] });
  });
});

describe('P-10 deferred and optional props', () => {
  it('announces deferred props by group without resolving them (test_server_response_with_deferred_prop_and_multiple_groups)', async () => {
    const comments = tracked(['c']);
    const { props, metadata } = await resolveWith('Posts/Index', {
      user: { name: 'Jonathan' },
      comments: defer(comments.resolve),
      relatedPosts: defer(() => [], { group: 'sidebar' }),
      analytics: defer(() => ({})),
    });
    assert.deepEqual(props, { errors: {}, user: { name: 'Jonathan' } });
    assert.deepEqual(metadata.deferredProps, {
      default: ['comments', 'analytics'],
      sidebar: ['relatedPosts'],
    });
    assert.equal(comments.calls(), 0);
  });

  it('resolves a deferred group on its partial reload and never announces it there', async () => {
    const { props, metadata } = await resolveWith(
      'Posts/Index',
      {
        user: { name: 'Jonathan' },
        comments: defer(() => ['c']),
        relatedPosts: defer(() => ['r'], { group: 'sidebar' }),
      },
      partialHeaders('Posts/Index', { only: 'comments' }),
    );
    assert.deepEqual(props, { errors: {}, comments: ['c'] });
    assert.equal(metadata.deferredProps, undefined);
  });

  it('rescues a failing rescue-enabled deferred prop: omitted, listed, reported', async () => {
    const failure = new Error('permissions backend down');
    const reported: unknown[] = [];
    const { props, metadata } = await resolveWith(
      'Users/Index',
      {
        permissions: defer(
          () => {
            throw failure;
          },
          { rescue: true },
        ),
        roles: defer(() => ['admin']),
      },
      partialHeaders('Users/Index', { only: 'permissions,roles' }),
      { report: (error, path) => reported.push(error, path) },
    );
    assert.deepEqual(props, { errors: {}, roles: ['admin'] });
    assert.deepEqual(metadata.rescuedProps, ['permissions']);
    assert.deepEqual(reported, [failure, 'permissions']);
  });

  it('never rescues a failure caused by the request aborting, and reports nothing', async () => {
    const client = new AbortController();
    const reported: unknown[] = [];
    const { facts, visit } = request(
      '/page',
      partialHeaders('Users/Index', { only: 'permissions' }),
      { signal: client.signal },
    );
    const resolution = resolveProps({
      component: 'Users/Index',
      facts,
      visit,
      props: {
        permissions: defer(
          ({ signal }) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
          { rescue: true },
        ),
      },
      report: (error, path) => reported.push(error, path),
    });
    client.abort();
    await assert.rejects(resolution, (error) => error === client.signal.reason);
    assert.deepEqual(reported, []);
  });

  it('sends a selected lazy prop that resolves to undefined as null, so the client sees the key', async () => {
    const { props } = await resolveWith(
      'Dashboard',
      {
        stats: defer(() => undefined),
        bare: () => undefined,
        later: optional(async () => undefined),
      },
      partialHeaders('Dashboard', { only: 'stats,bare,later' }),
    );
    assert.deepEqual(props, { errors: {}, stats: null, bare: null, later: null });
  });

  it('fails the resolution for a failing deferred prop without rescue and aborts its siblings', async () => {
    const failure = new Error('boom');
    let siblingSignal: AbortSignal | undefined;
    await assert.rejects(
      resolveWith(
        'Users/Index',
        {
          permissions: defer(() => Promise.reject(failure)),
          roles: defer(async ({ signal }) => {
            siblingSignal = signal;
            await new Promise((resolve) => setTimeout(resolve, 5));
            return [];
          }),
        },
        partialHeaders('Users/Index', { only: 'permissions,roles' }),
      ),
      (error) => error === failure,
    );
    assert.equal(siblingSignal?.aborted, true);
  });

  it('resolves optional props on a partial reload that selects them (test_optional_props_are_included_in_partial_reload)', async () => {
    const { props } = await resolveWith(
      'Users',
      { users: [], optional: optional(() => 'An optional value') },
      partialHeaders('Users', { only: 'optional' }),
    );
    assert.deepEqual(props, { errors: {}, optional: 'An optional value' });
  });
});

describe('P-11 merging props', () => {
  it('labels append, prepend, and deep merges with matchPropsOn (protocol example)', async () => {
    const { metadata } = await resolveWith('Feed/Index', {
      user: { name: 'Jonathan' },
      posts: merge([{ id: 1, title: 'First Post' }], { matchOn: 'id' }),
      notifications: merge([{ id: 2 }], { mode: 'prepend', matchOn: 'id' }),
      conversations: merge({ data: [] }, { mode: 'deep', matchOn: 'data.id' }),
    });
    assert.deepEqual(metadata, {
      mergeProps: ['posts'],
      prependProps: ['notifications'],
      deepMergeProps: ['conversations'],
      matchPropsOn: ['posts.id', 'notifications.id', 'conversations.data.id'],
    });
  });

  it('labels a deferred merge prop on the full visit (test_server_response_with_defer_and_merge_props)', async () => {
    const { props, metadata } = await resolveWith('Feed', {
      posts: defer(() => [], { merge: true }),
      threads: defer(() => ({}), { merge: { mode: 'deep' }, group: 'side' }),
    });
    assert.deepEqual(props, { errors: {} });
    assert.deepEqual(metadata, {
      mergeProps: ['posts'],
      deepMergeProps: ['threads'],
      deferredProps: { default: ['posts'], side: ['threads'] },
    });
  });

  it('labels only merge props a partial reload selects (test_exclude_merge_props_from_partial_except_response)', async () => {
    const { props, metadata } = await resolveWith(
      'User/Edit',
      { user: { name: 'Jonathan' }, foo: merge('foo value'), bar: merge('bar value') },
      partialHeaders('User/Edit', { except: 'foo' }),
    );
    assert.deepEqual(props, { errors: {}, user: { name: 'Jonathan' }, bar: 'bar value' });
    assert.deepEqual(metadata.mergeProps, ['bar']);
  });

  it('drops the merge label of a reset prop (P-9 Resetting Props, test_exclude_merge_props_when_passed_in_reset_header)', async () => {
    const { props, metadata } = await resolveWith(
      'User/Edit',
      { foo: merge(['new']), bar: merge(['b']) },
      partialHeaders('User/Edit', { only: 'foo', reset: 'foo' }),
    );
    assert.deepEqual(props, { errors: {}, foo: ['new'] });
    assert.equal(metadata.mergeProps, undefined);
  });
});

describe('P-12 once props', () => {
  it('resolves a once prop on first use and lists it (protocol example)', async () => {
    const { props, metadata } = await resolveWith(
      'Billing/Plans',
      { plans: once(() => [{ id: 1, name: 'Basic' }]) },
      INERTIA,
    );
    assert.deepEqual(props, { errors: {}, plans: [{ id: 1, name: 'Basic' }] });
    assert.deepEqual(metadata.onceProps, { plans: { prop: 'plans', expiresAt: null } });
  });

  it('skips a once prop the client holds on a full Inertia visit but keeps listing it', async () => {
    const plans = tracked([]);
    const { props, metadata } = await resolveWith(
      'Billing/Upgrade',
      { plans: once(plans.resolve), currentPlan: { id: 1 } },
      { ...INERTIA, 'X-Inertia-Except-Once-Props': 'plans' },
    );
    assert.deepEqual(props, { errors: {}, currentPlan: { id: 1 } });
    assert.deepEqual(metadata.onceProps, { plans: { prop: 'plans', expiresAt: null } });
    assert.equal(plans.calls(), 0);
  });

  it('ignores except-once on a full page load, which has no X-Inertia', async () => {
    const { props } = await resolveWith(
      'Billing/Plans',
      { plans: once(() => ['p']) },
      { 'X-Inertia-Except-Once-Props': 'plans' },
    );
    assert.deepEqual(props, { errors: {}, plans: ['p'] });
  });

  it('resolves a fresh once prop even when the client holds it (test_fresh_props_are_resolved_even_when_in_except_once_props_header)', async () => {
    const { props } = await resolveWith(
      'Billing/Plans',
      { plans: once(() => ['new'], { fresh: true }) },
      { ...INERTIA, 'X-Inertia-Except-Once-Props': 'plans' },
    );
    assert.deepEqual(props, { errors: {}, plans: ['new'] });
  });

  it('tracks a custom key, and the client names that key (test_once_props_are_resolved_with_a_custom_key_and_ttl_value)', async () => {
    const now = () => 1_000_000;
    const fresh = await resolveWith(
      'Billing/Plans',
      { plans: once(() => ['p'], { key: 'billing-plans', ttlMs: 60_000 }) },
      INERTIA,
      { now },
    );
    assert.deepEqual(fresh.metadata.onceProps, {
      'billing-plans': { prop: 'plans', expiresAt: 1_060_000 },
    });
    const held = await resolveWith(
      'Billing/Plans',
      { plans: once(() => ['p'], { key: 'billing-plans' }) },
      { ...INERTIA, 'X-Inertia-Except-Once-Props': 'billing-plans' },
    );
    assert.deepEqual(held.props, { errors: {} });
  });

  it('reports an absolute expiry as epoch milliseconds', async () => {
    const { metadata } = await resolveWith('P', {
      a: once(1, { expiresAt: new Date('2030-01-01T00:00:00Z') }),
    });
    assert.deepEqual(metadata.onceProps, {
      a: { prop: 'a', expiresAt: Date.UTC(2030, 0, 1) },
    });
  });

  it('ignores except-once on a partial reload that requests the prop (test_once_props_are_resolved_on_partial_requests_when_included_in_only_headers)', async () => {
    const { props, metadata } = await resolveWith(
      'User/Edit',
      { foo: once(() => 'bar'), baz: once(() => 'qux') },
      partialHeaders('User/Edit', { only: 'foo', exceptOnce: 'foo' }),
    );
    assert.deepEqual(props, { errors: {}, foo: 'bar' });
    assert.deepEqual(metadata.onceProps, { foo: { prop: 'foo', expiresAt: null } });
  });

  it('does not announce a deferred once prop the client holds (test_defer_props_that_are_once_and_already_loaded_are_excluded)', async () => {
    const { props, metadata } = await resolveWith(
      'User/Edit',
      { defer: defer(() => 'value', { once: true }) },
      { ...INERTIA, 'X-Inertia-Except-Once-Props': 'defer' },
    );
    assert.deepEqual(props, { errors: {} });
    assert.equal(metadata.deferredProps, undefined);
    assert.deepEqual(metadata.onceProps, { defer: { prop: 'defer', expiresAt: null } });
  });

  it('lists an optional once prop on the full visit without resolving it', async () => {
    const { props, metadata } = await resolveWith('P', {
      opt: optional(() => 1, { once: true }),
    });
    assert.deepEqual(props, { errors: {} });
    assert.deepEqual(metadata.onceProps, { opt: { prop: 'opt', expiresAt: null } });
  });
});

describe('P-14 infinite scroll', () => {
  const page = { data: [{ id: 1 }, { id: 2 }], currentPage: 1, previousPage: null, nextPage: 2 };

  it('sends data, the merge label at <path>.data, and the pagination state (protocol example)', async () => {
    const { props, metadata } = await resolveWith('Posts/Index', { posts: scroll(page) });
    assert.deepEqual(props, { errors: {}, posts: { data: [{ id: 1 }, { id: 2 }] } });
    assert.deepEqual(metadata, {
      mergeProps: ['posts.data'],
      scrollProps: {
        posts: { pageName: 'page', previousPage: null, nextPage: 2, currentPage: 1, reset: false },
      },
    });
  });

  it('prepends per the merge-intent header and matches items by field', async () => {
    const { metadata } = await resolveWith(
      'Posts/Index',
      { posts: scroll(() => page, { pageName: 'p', matchOn: 'id' }) },
      { ...INERTIA, 'X-Inertia-Infinite-Scroll-Merge-Intent': 'prepend' },
    );
    assert.deepEqual(metadata.prependProps, ['posts.data']);
    assert.deepEqual(metadata.matchPropsOn, ['posts.data.id']);
    assert.equal(metadata.scrollProps?.posts?.pageName, 'p');
  });

  it('sets reset and drops the merge label on a reset reload (test_server_response_with_scroll_props)', async () => {
    const { metadata } = await resolveWith(
      'Posts/Index',
      { posts: scroll(page) },
      partialHeaders('Posts/Index', { only: 'posts', reset: 'posts' }),
    );
    assert.equal(metadata.mergeProps, undefined);
    assert.equal(metadata.scrollProps?.posts?.reset, true);
  });

  it('emits no scrollProps for a deferred scroll prop on the full visit', async () => {
    const { props, metadata } = await resolveWith('Posts/Index', {
      posts: scroll(() => page, { defer: true }),
    });
    assert.deepEqual(props, { errors: {} });
    assert.deepEqual(metadata, {
      mergeProps: ['posts.data'],
      deferredProps: { default: ['posts'] },
    });
  });

  it('rejects a resolved value that is not a scroll page', async () => {
    await assert.rejects(
      resolveWith('Posts/Index', {
        posts: scroll(() => ({ items: [] }) as unknown as typeof page),
      }),
      code('invalid_props'),
    );
  });
});

describe('shared props', () => {
  it('merges shared props under page props and reports their top-level keys', async () => {
    const { props, metadata } = await resolveWith(
      'Dash',
      { title: 'Page title', stats: [1] },
      {},
      { shared: { appName: 'JSails', title: 'Shared title', auth: () => ({ id: 7 }) } },
    );
    assert.deepEqual(props, {
      errors: {},
      appName: 'JSails',
      title: 'Page title',
      auth: { id: 7 },
      stats: [1],
    });
    assert.deepEqual(metadata.sharedProps, ['appName', 'title', 'auth']);
  });
});

describe('resolver context and concurrency', () => {
  it('passes the request facts and a live signal to every resolver', async () => {
    let seen: InertiaPropContext | undefined;
    const controller = new AbortController();
    const fixture = request('/users?page=2', { 'X-Test': 'yes' }, { signal: controller.signal });
    const page = await buildInertiaPage({
      component: 'Users',
      version: 'v1',
      facts: fixture.facts,
      visit: fixture.visit,
      props: {
        users: (context: InertiaPropContext) => {
          seen = context;
          return [];
        },
      },
    });
    assert.equal(page.url, '/users?page=2');
    assert.equal(seen?.component, 'Users');
    assert.equal(seen?.method, 'GET');
    assert.equal(seen?.url.searchParams.get('page'), '2');
    assert.equal(seen?.headers.get('X-Test'), 'yes');
    assert.equal(seen?.signal.aborted, false);
    controller.abort();
    assert.equal(seen?.signal.aborted, true);
  });

  it('runs selected resolvers concurrently', async () => {
    let releaseA: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const stall = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('resolvers ran one after another')), 1000).unref();
    });
    const { props } = await resolveWith('P', {
      a: async () => {
        await Promise.race([gate, stall]);
        return 'a';
      },
      b: () => {
        releaseA();
        return 'b';
      },
    });
    assert.deepEqual(props, { errors: {}, a: 'a', b: 'b' });
  });

  it('rejects a resolver that returns a descriptor', async () => {
    await assert.rejects(
      resolveWith('P', { a: () => defer(() => 1) }),
      (error) => error instanceof InertiaError && error.code === 'unserializable_prop',
    );
  });
});

describe('prop keys', () => {
  it('rejects prototype keys anywhere in the walked tree', async () => {
    const tainted = JSON.parse('{"profile":{"__proto__":{"admin":true}}}') as Record<
      string,
      unknown
    >;
    await assert.rejects(resolveWith('P', tainted), (error: unknown) => {
      assert.ok(error instanceof InertiaError);
      assert.equal(error.code, 'invalid_prop_key');
      assert.deepEqual(error.context, { path: 'profile.__proto__' });
      return true;
    });
  });

  it('rejects dotted and comma keys on the path to a resolver or descriptor', async () => {
    await assert.rejects(resolveWith('P', { 'a.b': defer(() => 1) }), code('invalid_prop_key'));
    await assert.rejects(resolveWith('P', { 'a,b': { c: () => 1 } }), code('invalid_prop_key'));
  });

  it('allows dotted keys in plain data', async () => {
    const { props } = await resolveWith('P', {
      translations: { 'nav.home': 'Home' },
      emails: { 'ada@example.test': 1 },
    });
    assert.deepEqual(props.translations, { 'nav.home': 'Home' });
  });
});

describe('P-7 page object', () => {
  it('emits optional fields only when set, in reference order', async () => {
    const fixture = request('/feed/', INERTIA);
    const page = await buildInertiaPage({
      component: 'Feed',
      version: '',
      facts: fixture.facts,
      visit: fixture.visit,
      props: { posts: merge([1]) },
      flash: {},
      encryptHistory: false,
      clearHistory: true,
      preserveFragment: false,
    });
    assert.deepEqual(page, {
      component: 'Feed',
      props: { errors: {}, posts: [1] },
      url: '/feed/',
      version: '',
      mergeProps: ['posts'],
      clearHistory: true,
    });
    const flashed = await buildInertiaPage({
      component: 'Feed',
      version: 'v',
      facts: fixture.facts,
      visit: fixture.visit,
      props: {},
      flash: { notice: 'Saved' },
      encryptHistory: true,
      preserveFragment: true,
    });
    assert.deepEqual(
      { flash: flashed.flash, encrypt: flashed.encryptHistory, fragment: flashed.preserveFragment },
      { flash: { notice: 'Saved' }, encrypt: true, fragment: true },
    );
  });

  it('rejects a bad component before any resolver runs', async () => {
    const users = tracked([]);
    const fixture = request('/');
    for (const component of ['', '   ', 'Users\nInjected']) {
      await assert.rejects(
        buildInertiaPage({
          component,
          version: '',
          facts: fixture.facts,
          visit: fixture.visit,
          props: { users: users.resolve },
        }),
        code('invalid_component'),
      );
    }
    assert.equal(users.calls(), 0);
  });
});

describe('P-17 error bags (MiddlewareTest)', () => {
  const defaultBag = { name: 'The name field is required.' };

  it('sends the default bag unwrapped without a bag header (test_validation_errors_are_registered_as_of_default)', () => {
    assert.deepEqual(shapeErrorBags({ default: defaultBag }, null), defaultBag);
  });

  it('wraps the default bag under the header bag (test_validation_errors_are_scoped_to_error_bag_header)', () => {
    assert.deepEqual(shapeErrorBags({ default: defaultBag }, 'example'), { example: defaultBag });
  });

  it('sends named bags under their names when there is no default bag (test_validation_errors_with_named_error_bags_are_scoped)', () => {
    const bags = { example: defaultBag, other: { email: 'Bad' } };
    assert.deepEqual(shapeErrorBags(bags, null), bags);
    assert.deepEqual(shapeErrorBags(bags, 'example'), bags);
  });

  it('sends nothing for no bags (test_validation_errors_can_be_empty)', () => {
    assert.deepEqual(shapeErrorBags({}, 'example'), {});
  });

  it('treats a prototype-key bag header as absent', () => {
    const shaped = shapeErrorBags({ default: defaultBag }, '__proto__');
    assert.deepEqual(shaped, defaultBag);
    assert.equal(Object.getPrototypeOf(shaped), Object.prototype);
  });
});
