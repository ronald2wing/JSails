/**
 * Type conformance of the page object with the pinned client's `Page`
 * (@inertiajs/core 3.11.0 `types/types.d.ts`).
 *
 * `WirePage` is what the client accepts off the wire: `Page` without its
 * client-side fields, with `flash` and `rescuedProps` optional because the
 * client fills them in (`dist/index.js` 1358 for the first page, 2950 for
 * responses), read-only because the wire object is never mutated, and with
 * `errors` typed as either shape the client reads (a flat map, or bags it
 * indexes by `X-Inertia-Error-Bag`, core `dist/index.js` 3343 and 3944;
 * `Errors & ErrorBag` upstream is an intersection no value with string
 * leaves can inhabit), in either `ErrorValue` mode.
 *
 * The declarations are read from the pinned install by path: the package
 * entry's extensionless re-exports do not resolve under NodeNext, so a
 * consumer on NodeNext sees none of the client's types (a JSails app's
 * client code needs `moduleResolution: bundler`).
 *
 * Compile-time checks: a page the engine builds with every optional field is
 * assignable to `WirePage`, every `Page` field is either produced or listed
 * as deliberately out, and the engine produces no field `Page` lacks. A new
 * upstream field therefore fails the build of a pin bump until it is mapped.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// The package entry re-exports its types through extensionless relative
// specifiers (`export * from './types'`), which NodeNext resolution cannot
// follow, so the declarations are read by path from the hoisted install. The
// identifier type is imported directly because `types.d.ts` reaches it the
// same unresolvable way, which would otherwise leave it `any`.
import type { InfiniteScrollPageIdentifier } from '../../../../node_modules/@inertiajs/core/types/infiniteScroll/data.js';
import type {
  ErrorBag,
  Errors,
  Page,
} from '../../../../node_modules/@inertiajs/core/types/types.js';

import {
  buildInertiaPage,
  type InertiaScrollMeta,
  defer,
  merge,
  once,
  readInertiaVisit,
  scroll,
  type InertiaPageObject,
} from '../../src/index.js';

/** Set by the client, never sent by a server. */
type ClientSide =
  'rememberedState' | 'queryMethodData' | 'optimisticUpdatedAt' | 'initialDeferredProps';

/** Sent by servers this package does not implement: live props (Reverb channels). */
type DeliberatelyOut = 'liveProps';

/** Defaulted by the client when absent. */
type ClientDefaulted = 'flash' | 'rescuedProps';

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * `ErrorValue` is `string` by default and `string[]` for an app that declares
 * `errorValueType` (the server's `allMessages` mode); a server serves both.
 */
type ErrorValueMode = Errors[string] | string[];
type ErrorsIn<V> = { [K in keyof Errors]: V };
type ErrorBagIn<V> = { [K in keyof ErrorBag]: ErrorsIn<V> };

/** The page object as the client accepts it from a server. */
export type WirePage = DeepReadonly<
  Omit<Page, ClientSide | DeliberatelyOut | ClientDefaulted | 'props'> &
    Partial<Pick<Page, ClientDefaulted>> & {
      props: Omit<Page['props'], 'errors'> & {
        errors: ErrorsIn<ErrorValueMode> | ErrorBagIn<ErrorValueMode>;
      };
    }
>;

type Expect<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;

/** Every `Page` field is produced by the engine or listed above. */
export type EveryFieldMapped = Expect<
  IsNever<Exclude<keyof Page, keyof InertiaPageObject | ClientSide | DeliberatelyOut>>
>;

/** The engine produces no field the client does not know. */
export type NoUnknownField = Expect<IsNever<Exclude<keyof InertiaPageObject, keyof Page>>>;

/** Scroll metadata pages are exactly the client's page identifiers. */
export type ScrollPagesMatch = Expect<
  [InertiaScrollMeta['currentPage'], InfiniteScrollPageIdentifier] extends [
    InfiniteScrollPageIdentifier,
    InertiaScrollMeta['nextPage'],
  ]
    ? true
    : false
>;

/** Compile-time assignability: a built page is accepted where `WirePage` is expected. */
function onTheWire(page: InertiaPageObject): WirePage {
  return page;
}

describe('page object types', () => {
  it('builds a page with every optional field that the client type accepts', async () => {
    const headers = new Headers();
    const page = await buildInertiaPage({
      component: 'Feed',
      facts: {
        method: 'GET',
        url: new URL('https://example.test/feed'),
        headers,
        signal: new AbortController().signal,
      },
      visit: readInertiaVisit(headers),
      props: {
        posts: scroll({ data: [1, 2], currentPage: 1, previousPage: null, nextPage: 2 }),
        stats: defer(() => 3, { group: 'stats' }),
        tags: merge(['a'], { mode: 'prepend' }),
        plans: once(() => ['free'], { ttlMs: 1000 }),
      },
      shared: { user: 'ada' },
      errors: { name: 'Name is required' },
      report: () => undefined,
      now: () => 0,
      version: 'v1',
      flash: { message: 'Saved' },
      encryptHistory: true,
      clearHistory: true,
      preserveFragment: true,
    });
    const wire = onTheWire(page);
    assert.equal(wire.component, 'Feed');
    assert.deepEqual(wire.deferredProps, { stats: ['stats'] });
    assert.deepEqual(wire.sharedProps, ['user']);
    assert.equal(wire.flash?.message, 'Saved');
  });
});
