/**
 * Record behaviour as `defineModel` takes it: hooks and validation are
 * checked and frozen on the definition (an unknown hook, a hook that is not a
 * function, or a validator without `safeParse` is refused), a table never
 * carries behaviour, and `runsRecordLogic` says which operations a model's
 * behaviour concerns (validation counts for saves, `afterCommit` for every
 * operation).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { column, defineModel, modelDefinition } from '../../src/model/index.js';
import { checkBehavior, runsRecordLogic } from '../../src/record/hooks.js';

const SPEC = { table: 'hk_things', columns: { name: column.string(20) } };

describe('record behaviour', () => {
  it('is checked and frozen on the definition', () => {
    class Thing {
      declare id: number;
      declare name: string;
    }
    const beforeSave = (): void => undefined;
    const validate = z.object({ name: z.string() });
    defineModel(Thing, SPEC, { hooks: { beforeSave }, validate });
    const behavior = modelDefinition(Thing)?.behavior;
    assert.ok(behavior !== undefined);
    assert.equal(behavior.hooks.beforeSave, beforeSave);
    assert.equal(behavior.validate, validate);
    assert.ok(Object.isFrozen(behavior) && Object.isFrozen(behavior.hooks));

    class Plain {}
    defineModel(Plain, { ...SPEC, table: 'hk_plain' });
    assert.equal(modelDefinition(Plain)?.behavior, undefined);
  });

  it('refuses unknown hooks, non-functions and validators without safeParse', () => {
    const cases: readonly [unknown, string][] = [
      [null, 'behavior'],
      [{ hook: {} }, 'hook'],
      [{ hooks: [] }, 'hooks'],
      [{ hooks: { afterLoad: () => undefined } }, 'hooks.afterLoad'],
      [{ hooks: { beforeSave: 'slugify' } }, 'hooks.beforeSave'],
      [{ validate: { parse: () => true } }, 'validate'],
      [{ validate: () => true }, 'validate'],
    ];
    for (const [behavior, field] of cases) {
      assert.throws(() => checkBehavior(behavior, 'Thing'), {
        code: 'invalid_spec',
        context: { model: 'Thing', field },
      });
    }
    assert.deepEqual(checkBehavior({ hooks: { afterSave: undefined } }, 'Thing').hooks, {});
  });

  it('says which operations it concerns', () => {
    const validated = checkBehavior({ validate: z.object({}) }, 'Thing');
    assert.deepEqual(
      (['insert', 'update', 'delete'] as const).map((op) => runsRecordLogic(validated, op)),
      [true, true, false],
    );
    const committed = checkBehavior({ hooks: { afterCommit: () => undefined } }, 'Thing');
    assert.ok(
      (['insert', 'update', 'delete'] as const).every((op) => runsRecordLogic(committed, op)),
    );
    const deleting = checkBehavior({ hooks: { beforeDelete: () => undefined } }, 'Thing');
    assert.deepEqual(
      (['insert', 'update', 'delete'] as const).map((op) => runsRecordLogic(deleting, op)),
      [false, false, true],
    );
    assert.equal(runsRecordLogic(undefined, 'insert'), false);
  });
});
