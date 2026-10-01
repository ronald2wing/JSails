import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BaseEntity, DataSource } from 'typeorm';
import { z } from 'zod';

import { JsailsDataSource } from '../../src/database/data-source.js';
import { createEntitySubscriber } from '../../src/database/entity-subscribers.js';
import { EntityValidationError } from '../../src/database/entity-validation.js';
import { clearModelRegistry, registeredModels } from '../../src/database/model-registry.js';
import { defineData, defineDataList, type DataValue } from '../../src/data/define-data.js';
import { jsails } from '../../src/internal/jsails-namespace.js';
import { defineModel } from '../../src/models/define-model.js';

const Preferences = defineData({
  name: 'Preferences',
  description: 'Display preferences.',
  properties: {
    theme: z.enum(['light', 'dark']),
    density: z.enum(['comfortable', 'compact']),
  },
});

const PreferencesList = defineDataList(Preferences, { name: 'PreferencesList' });

afterEach(() => {
  clearModelRegistry();
});

function hooksFor(entity: Function) {
  const model = registeredModels().find((candidate) => candidate.entity === entity);
  assert.ok(model);
  return model.hooks;
}

describe('data-backed JSON model fields', () => {
  it('derives the field type from the contract', () => {
    const preferences: DataValue<typeof Preferences> = {
      theme: 'dark',
      density: 'compact',
    };
    const history: DataValue<typeof PreferencesList> = [preferences];
    assert.deepEqual(history, [{ theme: 'dark', density: 'compact' }]);
  });

  it('marks the column as json and validates the contract on insert', async () => {
    class User extends BaseEntity {
      declare id: number;
      declare preferences: { theme: 'light' | 'dark'; density: 'comfortable' | 'compact' };
    }
    jsails.data(Preferences)(User.prototype, 'preferences');

    defineModel(User, {
      table: 'user',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'preferences', type: 'json' }],
      relations: [],
    });

    const schema = await new JsailsDataSource({
      type: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      username: 'x',
      password: 'x',
      database: 'x',
      entities: [User],
    }).getModelSchema();
    assert.equal(schema.tables[0]?.columns.find((c) => c.name === 'preferences')?.type, 'json');

    const hooks = hooksFor(User);
    const insert = hooks.find((hook) => hook.hooks.beforeInsert)?.hooks.beforeInsert;
    assert.ok(insert);
    await insert({ data: { preferences: { theme: 'dark', density: 'compact' } } } as never);
    await assert.rejects(
      async () => {
        await insert({ data: { preferences: { theme: 'neon', density: 'compact' } } } as never);
      },
      (error: unknown) => {
        assert.ok(error instanceof EntityValidationError);
        assert.equal(error.errors[0]?.field, 'preferences.theme');
        return true;
      },
    );
  });

  it('validates during a real save and returns the stored object on load', async () => {
    class User extends BaseEntity {
      declare id: number;
      declare preferences: { theme: 'light' | 'dark'; density: 'comfortable' | 'compact' };
    }
    jsails.data(Preferences)(User.prototype, 'preferences');

    defineModel(User, {
      table: 'json_user',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'preferences', type: 'json' }],
      relations: [],
    });

    const dataSource = new DataSource({
      type: 'sqljs',
      synchronize: true,
      entities: [User],
      subscribers: [createEntitySubscriber(...hooksFor(User))],
    });
    await dataSource.initialize();
    try {
      const repository = dataSource.getRepository(User);
      const saved = await repository.save(
        repository.create({ preferences: { theme: 'dark', density: 'compact' } }),
      );
      const loaded = await repository.findOneByOrFail({ id: saved.id });
      assert.deepEqual(loaded.preferences, { theme: 'dark', density: 'compact' });

      await assert.rejects(
        repository.save(
          repository.create({ preferences: { theme: 'neon', density: 'compact' } } as never),
        ),
        (error) => error instanceof EntityValidationError,
      );
      await assert.rejects(
        repository.save(
          repository.create({
            id: saved.id,
            preferences: { theme: 'neon', density: 'compact' },
          } as never),
        ),
        (error) => error instanceof EntityValidationError,
      );
    } finally {
      await dataSource.destroy();
    }
  });

  it('persists defaults and transforms from the contract', async () => {
    const Display = defineData({
      name: 'Display',
      properties: {
        theme: z.enum(['light', 'dark']).default('light'),
        label: z.string().trim(),
      },
    });

    class User extends BaseEntity {
      declare id: number;
      declare display: { theme: 'light' | 'dark'; label: string };
    }
    jsails.data(Display)(User.prototype, 'display');

    defineModel(User, {
      table: 'display_user',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'display', type: 'json' }],
      relations: [],
    });

    const insert = hooksFor(User).find((hook) => hook.hooks.beforeInsert)?.hooks.beforeInsert;
    assert.ok(insert);
    const values = { display: { label: '  compact  ' } };
    await insert({ data: values } as never);
    assert.deepEqual(values.display, { theme: 'light', label: 'compact' });
  });

  it('validates arrays through a list contract', async () => {
    class User extends BaseEntity {
      declare id: number;
      declare preferences: { theme: 'light' | 'dark'; density: 'comfortable' | 'compact' }[];
    }
    jsails.data(PreferencesList)(User.prototype, 'preferences');

    defineModel(User, {
      table: 'user',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'preferences', type: 'json' }],
      relations: [],
    });

    const insert = hooksFor(User).find((hook) => hook.hooks.beforeInsert)?.hooks.beforeInsert;
    assert.ok(insert);
    await insert({
      data: { preferences: [{ theme: 'light', density: 'comfortable' }] },
    } as never);
    await assert.rejects(
      async () => {
        await insert({ data: { preferences: [{ theme: 'light', density: 'huge' }] } } as never);
      },
      (error) => error instanceof EntityValidationError,
    );
  });

  it('skips an absent field on update but validates a present one', async () => {
    class User extends BaseEntity {
      declare id: number;
      declare preferences: { theme: 'light' | 'dark'; density: 'comfortable' | 'compact' };
    }
    jsails.data(Preferences)(User.prototype, 'preferences');

    defineModel(User, {
      table: 'user',
      primaryKey: { name: 'id', kind: 'integer' },
      columns: [{ name: 'preferences', type: 'json' }],
      relations: [],
    });

    const update = hooksFor(User).find((hook) => hook.hooks.beforeUpdate)?.hooks.beforeUpdate;
    assert.ok(update);
    await update({ data: { id: 1 } } as never);
    await assert.rejects(
      async () => {
        await update({ data: { preferences: { theme: 'neon', density: 'compact' } } } as never);
      },
      (error) => error instanceof EntityValidationError,
    );
  });
});
