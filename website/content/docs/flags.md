---
title: Feature Flags
order: 33
section: Reference
---

# Feature Flags

`@jsails/flags` is a boolean gate the app flips without a deploy. It covers two
layers: the core boolean-gate store (in-memory or database-backed) for simple
on/off toggles, and the **flag-scope primitives** (`coverage`, `beforeAfter`,
`when`) for A/B testing and gradual rollouts.

A flag is identified by a non-empty `key` plus an optional `scope` (a string or
id). The global scope and each scoped namespace are independent — the same key
can be active for one scope and inactive elsewhere. Scoped flags are the
foundation for per-tenant, per-user, and per-session toggles.

The `@jsails/flags` package is imported explicitly
(`import { resolveFeature, coverage } from '@jsails/flags'`). Importing its
barrel (the index module that re-exports the public API) is inert: nothing
connects and no flag is read or written until a store or service method is
called.

Flags are independent of the presentation seams: see [Theme Tokens](/docs/theming)
and [Internationalization](/docs/i18n) for those.

## The boolean-gate store

### Memory store

`createMemoryFlagStore()` is the zero-config default for tests, demos, and
single-process deployments. It holds no external resources and scopes are
isolated namespaces — a flag set in one scope never leaks into another or the
global scope.

### Database store

`createDatabaseFlagStore({ dataSource })`, from the `@jsails/flags/database`
subpath, persists flags in the `jsails_feature_flag` table. It lives on its own
subpath so that `@jsails/flags`, the module a config lists, loads no TypeORM. The entity (`JsailsFeatureFlag`) maps four columns:
`key` (varchar 190), `scope` (varchar 190), `value` (boolean), and `updatedAt`
(datetime). Add `flagsEntities` to a `JsailsDataSource` `entities` and run
`jsails db:push` — the store reads and writes only through the injected data
source's repository (no raw SQL, no runtime DDL). A missing table fails with a
value-free `FeatureFlagError` (never echoes input, secrets, or raw values) pointing at that command.

```js
// jsails.database.js  (app-owned; plain ESM)
import { JsailsDataSource } from 'jsails';
import { flagsEntities } from '@jsails/flags/database';

export default new JsailsDataSource({
  type: 'mariadb',
  /* ... */
  entities: [...flagsEntities /* , your own models */],
});
```

```sh
jsails db:push --config jsails.database.js
```

`(scope, key)` is a unique index, and `set` writes with one atomic
`INSERT … ON CONFLICT` / `ON DUPLICATE KEY UPDATE`, so concurrent first writes
of a flag converge on one row. A table created before the index was unique may
hold duplicate rows; delete the duplicates (keep the newest `updatedAt` per
`(scope, key)`) before `db:push` adds the unique index.

### The `FeatureStore` contract

Every store implements the same contract:

```ts
interface FeatureStore {
  get(key: string, scope?: string): Promise<boolean | null>;
  set(key: string, value: boolean, scope?: string): Promise<void>;
  delete(key: string, scope?: string): Promise<void>;
  all(scope?: string): Promise<Record<string, boolean>>;
}
```

`get` returns `null` when a flag is unset — "explicitly off" and "never set"
stay distinguishable at the store level even though both resolve to inactive
through the service. This contract is ORM-free: a custom store can persist flags
anywhere.

## The service

The `flags` plugin exposes a `FeatureFlags` service under the typed `flagsToken`
service token:

```ts
interface FeatureFlags {
  isActive(key: string, scope?: string): Promise<boolean>;
  activate(key: string, scope?: string): Promise<void>;
  deactivate(key: string, scope?: string): Promise<void>;
  all(scope?: string): Promise<Record<string, boolean>>;
}
```

`isActive` returns true only when the stored value is exactly `true`; absent or
`false` both resolve to inactive.

### Through the plugin

```js
// jsails.app.js  (app-owned; plain ESM, compiled JS)
export default {
  plugins: {
    use: [
      '@jsails/cache', // the read cache and its tag tokens
      '@jsails/flags', // the in-memory default store
    ],
  },
};
```

`flagsPlugin` is a `definePlugin` plugin: its options are data, checked when
the factory is called, so a malformed set fails with `config.invalid_options`
before anything runs. A store is therefore never passed in. Another plugin
provides it under `featureStoreToken`, and `store` names that token. The
flags plugin then requires the service, so the runner sets up the provider
first and refuses to start without it:

```js
// jsails.app.js
import { featureStoreToken } from '@jsails/flags';
import { createDatabaseFlagStore } from '@jsails/flags/database';
import { definePlugin } from 'jsails/kernel';
import { dataSource } from './jsails.database.js';

const flagStore = definePlugin({
  name: 'flag-store',
  provides: [featureStoreToken],
  setup({ services }) {
    services.provide(featureStoreToken, createDatabaseFlagStore({ dataSource }));
  },
});

export default {
  extensions: [flagStore()],
  plugins: {
    use: ['@jsails/cache', ['@jsails/flags', { store: featureStoreToken }]],
  },
};
```

The provided store is used verbatim and the flags plugin never closes it.
Without `store`, the plugin owns a zero-config memory store. Setup is
inert: nothing connects and no flag is read or written until a service
method is called. The service is `flagsToken`'s, which the admin page
resolves from the application each request runs in.

The service reads a scope's whole flag set at once (`store.all(scope)`)
through a [defined cache](/docs/services#defined-caches) (`FLAGS_CACHE`:
in-process, one entry per scope, at most 1 000 scopes, tagged `flags`) and
evaluates every check in memory, so a warm `isActive` issues no query. Every
`activate`/`deactivate` through the service invalidates the `flags` tag after
the store write, in every process of the app (at once over the Valkey tag bus,
within the tag table's `syncMs` otherwise); a write that bypasses the service
is seen once the entry's 60 s TTL lapses. The plugin binds the cache in
`setup`, so the app needs `@jsails/cache` too; the `jsails-flags` manifest
declares it as a plugin dependency, so `jsails plugins check` reports it
missing.

### Branch resolution

`resolveFeature(flags, key, scope?)` returns an `{ active, inactive }` branch
helper that reads the store lazily on the first branch call:

```ts
import { resolveFeature } from '@jsails/flags';

const feature = resolveFeature(flags, 'new-checkout', session.userId);

// Compose with ?? to select one branch:
return (await feature.active(newUi())) ?? (await feature.inactive(oldUi()));
```

The key and scope are validated eagerly (synchronously); the store is read only
when `active()` or `inactive()` is called.

## Flag scopes (A/B testing)

`@jsails/flags` exports a set of pure, browser-safe scope primitives: functions
that map a `scope` string to a boolean, determining whether a variant is active
for that scope. They are deterministic — the same scope always resolves the same
way, never flapping between variants.

Scopes compose with the boolean-gate store via `resolveFeature` (for persisted
toggles) or the pure `when()` helper (for in-memory branch selection).

### How bucketing works

Every scope function derives its answer from a deterministic **FNV-1a** hash of
`key + "\0" + scope` (over UTF-16 code units), finished with the murmur3
`fmix32` avalanche step. The hash produces a stable integer in `[0, 2^32)`, so
the same scope always lands in the same bucket — a user's A/B cohort is stable
across requests and sessions. The finalizer spreads sequential ids (`1000`,
`1001`, …) across cohorts instead of assigning whole id ranges to one side. An
empty scope string always returns `false`.

Upgrading from a release without the finalizer re-buckets every scope once;
start running experiments fresh (or change their `key`) after the upgrade.

### `coverage(percent, key)`

Activate a variant for a stable percentage of scopes. `percent` is in `[0, 100]`;
a scope whose bucketed hash falls under that percentage is in.

```ts
import { coverage } from '@jsails/flags';

// 20% of users see the new checkout.
const scope = coverage(20, 'new-checkout-exp');
scope('user-abc'); // might be true or false, but always the same for 'user-abc'
```

### `everyone(key)` and `nobody(key)`

`everyone(key)` is `coverage(100, key)` — activate for every scope.
`nobody(key)` is `coverage(0, key)` — activate for no scope.

### `beforeAfter(key, before, step?)`

Pick a variant by an ordered rollout step. `before` is the total number of
buckets; `step` (default `1`) selects which bucket is "after" (the new variant).
Buckets are split evenly across `[0, 2^32)`, so `step = 1` of `10` means the
first 10% of scopes see the new variant.

```ts
import { beforeAfter } from '@jsails/flags';

const scope = beforeAfter('search-v2-rollout', 10, 2);
// After two steps of a 10-step rollout: 20% of scopes see the new variant.
```

### `shipped`

A scope that is always active — the final step of a rollout where the feature is
permanently on for everyone.

```ts
import { shipped } from '@jsails/flags';

const scope = shipped;
scope('any-user'); // always true
```

### `when(scope, scopeValue, active, inactive)`

A synchronous branch helper: returns `active` when the scope resolves true for
`scopeValue`, else `inactive`. The unused branch is never evaluated — pass thunks
for expensive values.

```ts
import { when, coverage } from '@jsails/flags';

const scope = coverage(50, 'pricing-experiment');

const price = when(
  scope,
  'user-42',
  () => computeNewPrice(), // only called when scope resolves true
  () => computeOldPrice(),
);
```

## Error handling

`FeatureFlagError` is value-free — a key, scope, or backend detail is never
echoed. Validation rejects:

- A key that is not a non-empty string within `FLAG_KEY_MAX_LENGTH` (190 chars).
- A scope that is not `undefined` or a non-empty string within
  `FLAG_SCOPE_MAX_LENGTH` (190 chars).
- A `coverage` percent not in `[0, 100]`.
- A `beforeAfter` `before` not a positive integer, or `step` not in
  `[0, before]`.

## Honest limits

- **No real-time scope updates.** The `coverage`/`beforeAfter` primitives are
  pure functions — they derive their answer from a hash of the key + scope. To
  change the coverage percentage mid-experiment, change the `key` (or accept
  that existing scopes will re-bucket). This is deliberate: a pure-function
  primitive has no mutable state and no store dependency.
- **Scopes are strings only.** A scope value must be a string — no numeric or
  object scopes. This keeps the hashing simple and reproducible.
- **No auto-rollout manager.** There is no framework-owned rollout state machine
  that advances `step` automatically. The `beforeAfter` step is a parameter the
  caller updates in code.
- **The `FeatureStore` contract has no batch operations.** `set` and `delete`
  are single-key. Bulk toggles require multiple calls.

## Next steps

- [Theme Tokens](/docs/theming) and [Internationalization](/docs/i18n) — the other
  presentation seams.
- [Extending JSails](/docs/extending) — consume `flagsToken` from your own
  extension via `requires: [flagsToken]`.
