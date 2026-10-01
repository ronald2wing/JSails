import 'reflect-metadata';

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  BaseEntity,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { JsailsDataSource } from '../../src/database/data-source.js';
import type { SchemaState } from '../../src/migrations/schema-types.js';

@Entity('naming_users')
class User extends BaseEntity {
  @PrimaryGeneratedColumn() id!: number;
}

@Entity('naming_profiles')
class Profile extends BaseEntity {
  @PrimaryGeneratedColumn() id!: number;

  @OneToOne(() => User)
  @JoinColumn()
  user!: User;
}

@Entity('naming_posts')
class Post extends BaseEntity {
  @PrimaryGeneratedColumn() id!: number;

  @ManyToOne(() => User)
  @JoinColumn()
  author!: User;
}

@Entity('naming_comments')
class Comment extends BaseEntity {
  @PrimaryGeneratedColumn() id!: number;

  @ManyToOne(() => User)
  author!: User;
}

@Entity('naming_settings')
class Settings extends BaseEntity {
  @PrimaryGeneratedColumn() id!: number;

  @OneToOne(() => User)
  @JoinColumn({ name: 'owner_key' })
  user!: User;
}

const root = mkdtempSync(join(tmpdir(), 'jsails-naming-'));
let schema: SchemaState;

before(async () => {
  const dataSource = new JsailsDataSource({
    type: 'sqljs',
    location: join(root, 'naming.sqlite'),
    entities: [User, Profile, Post, Comment, Settings],
  });
  schema = await dataSource.getModelSchema();
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function columnsOf(table: string): string[] {
  return (
    schema.tables.find((candidate) => candidate.name === table)?.columns.map((c) => c.name) ?? []
  );
}

describe('JsailsNamingStrategy', () => {
  it('names a bare one-to-one join column <relation>_<referenced column>', () => {
    assert.deepEqual(columnsOf('naming_profiles'), ['id', 'user_id']);
  });

  it('names a bare many-to-one join column the same way', () => {
    assert.deepEqual(columnsOf('naming_posts'), ['id', 'author_id']);
  });

  it('names an implicit many-to-one join column without @JoinColumn', () => {
    assert.deepEqual(columnsOf('naming_comments'), ['id', 'author_id']);
  });

  it('keeps an explicit @JoinColumn name', () => {
    assert.deepEqual(columnsOf('naming_settings'), ['id', 'owner_key']);
  });
});
