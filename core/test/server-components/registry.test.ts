/**
 * Tests for the app-owned server-component registry: assembly from entries,
 * lookup, and the value-free assembly errors (duplicate id, malformed id, a
 * value that is not a definition, a name that disagrees with its id).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ComponentRegistryErrors,
  componentRegistryFromMap,
  createComponentRegistry,
  isComponentId,
} from '../../src/server-components/registry.js';

import type { ServerComponentDefinition } from '../../src/server-components/component.js';

function component(name: string): ServerComponentDefinition<any> {
  return { name, render: () => null } as unknown as ServerComponentDefinition<any>;
}

function assertCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(ComponentRegistryErrors.is(error), 'a component_registry error');
    assert.equal((error as { code: string }).code, `component_registry.${code}`);
    return true;
  });
}

describe('createComponentRegistry', () => {
  it('keys components by id, in entry order', () => {
    const alpha = component('alpha');
    const registry = createComponentRegistry([
      { id: 'alpha', definition: alpha },
      { id: 'admin/user-card', definition: component('admin/user-card') },
    ]);

    assert.deepEqual(registry.ids(), ['alpha', 'admin/user-card']);
    assert.equal(registry.get('alpha'), alpha);
    assert.equal(registry.get('missing'), undefined);
    assert.equal(registry.size, 2);
    assert.equal(Object.isFrozen(registry), true);
    assert.equal(Object.isFrozen(registry.entries()), true);
  });

  it('refuses a second entry under a taken id', () => {
    assertCode(
      () =>
        createComponentRegistry([
          { id: 'widget', definition: component('widget') },
          { id: 'widget', definition: component('widget') },
        ]),
      'duplicate_id',
    );
  });

  it('refuses a malformed id without echoing it', () => {
    assert.throws(
      () => createComponentRegistry([{ id: 'has space', definition: component('has space') }]),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'component_registry.invalid_id');
        assert.doesNotMatch((error as Error).message, /has space/);
        return true;
      },
    );
  });

  it('refuses a value that is not a component definition', () => {
    assertCode(
      () =>
        createComponentRegistry([
          { id: 'widget', definition: { name: 'widget' } as unknown as ServerComponentDefinition },
        ]),
      'invalid_definition',
    );
  });

  it('refuses a definition whose name differs from its id', () => {
    assertCode(
      () => createComponentRegistry([{ id: 'widget', definition: component('other') }]),
      'name_mismatch',
    );
  });

  it('refuses entries that are not a list of records', () => {
    assertCode(() => createComponentRegistry(42 as never), 'invalid_entries');
    assertCode(() => createComponentRegistry([null] as never), 'invalid_entries');
  });

  it('keeps two registries apart', () => {
    const one = componentRegistryFromMap({ alpha: component('alpha') });
    const two = componentRegistryFromMap({ beta: component('beta') });
    assert.deepEqual(one.ids(), ['alpha']);
    assert.deepEqual(two.ids(), ['beta']);
  });
});

describe('isComponentId', () => {
  it('accepts path-derived and package-scoped ids', () => {
    assert.equal(isComponentId('task-list'), true);
    assert.equal(isComponentId('admin/user-card'), true);
    assert.equal(isComponentId('@acme/blog:post-list'), true);
  });

  it('rejects empty, spaced, over-long, and non-string ids', () => {
    assert.equal(isComponentId(''), false);
    assert.equal(isComponentId('a b'), false);
    assert.equal(isComponentId('a'.repeat(129)), false);
    assert.equal(isComponentId(7), false);
  });
});
