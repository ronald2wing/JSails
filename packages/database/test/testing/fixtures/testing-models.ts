/**
 * Models for the testing surface's suites: authors and their posts (with a
 * counter cache and a hook, so a set write must acknowledge it), a global
 * tag table and a tenant-scoped link table between posts and tags, and a
 * self-referencing category tree whose foreign key restricts deletes, so
 * emptying tables cannot rely on an order.
 */

import { column, defineModel, defineTable, type ModelTarget } from '../../../src/model/index.js';
import { ApplicationRecord } from '../../../src/record/index.js';

export class Author extends ApplicationRecord {
  declare id: number;
  declare tenantId: number;
  declare name: string;
  declare postsCount: number;
}

export class Post extends ApplicationRecord {
  declare id: number;
  declare tenantId: number;
  declare authorId: number;
  declare title: string;
}

export class Category extends ApplicationRecord {
  declare id: number;
  declare name: string;
  declare parentId: number | null;
}

/** The ids of the posts whose `afterSave` hook ran. */
export const SAVED_POSTS: number[] = [];

const tenantId = column.integer();

defineModel(Author, {
  table: 'ts_authors',
  columns: {
    tenantId,
    name: column.string(60),
    postsCount: column.integer({ default: 0 }),
  },
  tenant: 'tenantId',
  indexes: [{ columns: ['tenantId', 'name'], unique: true }],
  relations: {
    posts: { kind: 'hasMany', target: () => Post, inverse: 'author', dependent: 'destroy' },
  },
});

defineModel(
  Post,
  {
    table: 'ts_posts',
    columns: { tenantId, title: column.string(60) },
    tenant: 'tenantId',
    relations: {
      author: { kind: 'belongsTo', target: () => Author, counterCache: 'postsCount' },
    },
  },
  {
    hooks: {
      afterSave: ({ record }) => {
        SAVED_POSTS.push(record.id);
      },
    },
  },
);

defineModel(Category, {
  table: 'ts_categories',
  columns: { name: column.string(60) },
  relations: {
    parent: { kind: 'belongsTo', target: () => Category, nullable: true },
  },
});

/** A global table. */
export const Tag = defineTable({
  table: 'ts_tags',
  columns: { name: column.string(40) },
  indexes: [{ columns: ['name'], unique: true }],
});

/** The tenant-scoped link between posts and tags. */
export const PostTag = defineTable({
  table: 'ts_post_tags',
  columns: { tenantId },
  tenant: 'tenantId',
  relations: {
    post: { kind: 'belongsTo', target: () => Post, onDelete: 'cascade' },
    tag: { kind: 'belongsTo', target: () => Tag, onDelete: 'cascade' },
  },
  indexes: [{ columns: ['tenantId', 'postId', 'tagId'], unique: true }],
});

/** Every model of the suites, parents first. */
export const TESTING_MODELS: readonly ModelTarget[] = Object.freeze([
  Author,
  Post,
  Category,
  Tag,
  PostTag,
]);
