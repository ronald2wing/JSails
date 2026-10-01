import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { JsailsDataSource } from '../../src/database/data-source.js';

@Entity('plugin_entity')
class PluginEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 100 })
  name!: string;
}

function dataSource(): JsailsDataSource {
  return new JsailsDataSource({
    type: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    username: 'placeholder',
    password: 'placeholder',
    database: 'placeholder',
    entities: [],
  });
}

describe('JsailsDataSource.addEntities', () => {
  it('adds plugin entities before metadata is built', async () => {
    const source = dataSource();
    source.addEntities([PluginEntity]);
    const schema = await source.getModelSchema();
    assert.ok(schema.tables.some((table) => table.name === 'plugin_entity'));
  });

  it('rejects adding entities after initialization', () => {
    const source = dataSource();
    Object.defineProperty(source, 'isInitialized', { value: true });
    assert.throws(() => source.addEntities([PluginEntity]), /initialized/);
  });
});
