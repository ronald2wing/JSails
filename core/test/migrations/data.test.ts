import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MigrationError } from '../../src/migrations/schema-types.js';
import {
  type DataMigration,
  defineDataMigration,
  createDataMigrationRegistry,
  orderDataMigrations,
} from '../../src/migrations/data.js';

// ---------------------------------------------------------------------------
// defineDataMigration
// ---------------------------------------------------------------------------

describe('defineDataMigration', () => {
  it('creates a data migration with up and down handlers', () => {
    const dm = defineDataMigration({
      name: 'backfill',
      up: async () => {},
      down: async () => {},
    });
    assert.equal(dm.name, 'backfill');
    assert.equal(typeof dm.up, 'function');
    assert.equal(typeof dm.down, 'function');
  });

  it('stores dependency and transaction options', () => {
    const dm = defineDataMigration({
      name: 'child',
      dependencies: ['parent'],
      transactional: false,
      up: async () => {},
      down: async () => {},
    });
    assert.deepEqual(dm.dependencies, ['parent']);
    assert.equal(dm.transactional, false);
  });

  it('rejects a self-dependency', () => {
    assert.throws(
      () =>
        defineDataMigration({
          name: 'self',
          dependencies: ['self'],
          up: async () => {},
          down: async () => {},
        }),
      /cannot depend on itself/,
    );
  });

  it('rejects a duplicate dependency', () => {
    assert.throws(
      () =>
        defineDataMigration({
          name: 'child',
          dependencies: ['parent', 'parent'],
          up: async () => {},
          down: async () => {},
        }),
      /twice/,
    );
  });

  it('rejects invalid identifiers', () => {
    assert.throws(
      () =>
        defineDataMigration({
          name: 'bad name',
          up: async () => {},
          down: async () => {},
        }),
      MigrationError,
    );
  });
});

// ---------------------------------------------------------------------------
// createDataMigrationRegistry
// ---------------------------------------------------------------------------

describe('createDataMigrationRegistry', () => {
  it('validates and indexes data migrations by name', () => {
    const a = defineDataMigration({
      name: 'a',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    const b = defineDataMigration({
      name: 'b',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    const registry = createDataMigrationRegistry({ a, b });
    assert.equal(registry.size, 2);
  });

  it('orders dependencies before dependents and keeps declaration order otherwise', () => {
    const a = defineDataMigration({
      name: 'a',
      dependencies: ['b'],
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    const b = defineDataMigration({
      name: 'b',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    const c = defineDataMigration({
      name: 'c',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    const registry = createDataMigrationRegistry({ a, b, c });
    assert.deepEqual([...registry.keys()], ['b', 'a', 'c']);
  });

  it('rejects an unknown dependency', () => {
    const a = defineDataMigration({
      name: 'a',
      dependencies: ['missing'],
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    assert.throws(() => createDataMigrationRegistry({ a }), /unknown migration/);
  });

  it('rejects a dependency cycle', () => {
    const a = defineDataMigration({
      name: 'a',
      dependencies: ['b'],
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    const b = defineDataMigration({
      name: 'b',
      dependencies: ['a'],
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    assert.throws(() => createDataMigrationRegistry({ a, b }), /dependency cycle/);
  });

  it('orderDataMigrations also validates a caller-supplied map', () => {
    const a = defineDataMigration({
      name: 'a',
      dependencies: ['missing'],
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    assert.throws(() => orderDataMigrations(new Map([['a', a]])), /unknown migration/);
  });

  it('rejects a key that does not match the migration name', () => {
    const a = defineDataMigration({
      name: 'real',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    assert.throws(() => createDataMigrationRegistry({ wrong: a }), /does not match/);
  });

  it('rejects duplicate names', () => {
    const a = defineDataMigration({
      name: 'dup',
      up: () => Promise.resolve(),
      down: () => Promise.resolve(),
    });
    // Use a type assertion so we can supply entries with different keys but the
    // same DataMigration object; the duplicate check fires on the name before
    // the key/name mismatch check.
    assert.throws(() => createDataMigrationRegistry({ dup: a, other_key: a }), /duplicate/);
  });

  it('rejects a migration without an up function', () => {
    assert.throws(
      () =>
        createDataMigrationRegistry({
          bad: { name: 'bad', down: () => Promise.resolve() } as unknown as DataMigration,
        }),
      /"up" function/,
    );
  });

  it('rejects a migration without a down function', () => {
    assert.throws(
      () =>
        createDataMigrationRegistry({
          bad: { name: 'bad', up: () => Promise.resolve() } as unknown as DataMigration,
        }),
      /"down" function/,
    );
  });
});
