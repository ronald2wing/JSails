/**
 * Models for the statement and codec suites: two tenant-scoped tables with a
 * relation between them, a tenant-scoped link table to a global table, a
 * global table, and a table whose tenant column is a string, so the policy
 * meets every position a tenant reference can take and both tenant encodings.
 */

import {
  column,
  defineModel,
  defineTable,
  type ColumnDataContract,
  type ModelTarget,
} from '../../../src/model/index.js';

/** A data contract shaped like `jsails/data`'s: `{ theme: 'light' | 'dark', size?: number }`. */
export const PREFERENCES: ColumnDataContract = Object.freeze({
  name: 'Preferences',
  schema: {
    safeParse(input: unknown) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { success: false };
      }
      const { theme, size, ...rest } = input as Record<string, unknown>;
      if (Object.keys(rest).length > 0) return { success: false };
      if (theme !== 'light' && theme !== 'dark') return { success: false };
      if (size !== undefined && (typeof size !== 'number' || !Number.isInteger(size))) {
        return { success: false };
      }
      // The contract's output applies a default, as a Zod default would.
      return { success: true, data: { theme, size: size ?? 12 } };
    },
  },
});

export class Author {
  declare id: number;
  declare name: string;
}

export class Post {
  declare id: number;
  declare title: string;
  declare slug: string;
  declare status: 'draft' | 'live';
  declare views: number;
  declare tenantId: number;
  declare authorId: number | null;
  declare publishedAt: Date | null;
  declare preferences: { theme: 'light' | 'dark'; size: number } | null;
  declare body: string | null;
}

export class Comment {
  declare id: number;
  declare body: string;
  declare tenantId: number;
  declare postId: number;
}

defineModel(Author, {
  table: 'st_authors',
  columns: { name: column.string(100) },
});

defineModel(Post, {
  table: 'st_posts',
  columns: {
    title: column.string(200),
    slug: column.string(60),
    status: column.string(10, { enum: ['draft', 'live'], default: 'draft' }),
    views: column.integer({ default: 0 }),
    tenantId: column.integer(),
    publishedAt: column.timestamp({ nullable: true }),
    preferences: column.json({ nullable: true, data: PREFERENCES }),
    body: column.text({ nullable: true }),
  },
  tenant: 'tenantId',
  relations: {
    author: { kind: 'belongsTo', target: () => Author, nullable: true, onDelete: 'set null' },
    comments: { kind: 'hasMany', target: () => Comment, inverse: 'post', dependent: 'destroy' },
  },
  indexes: [{ columns: ['tenantId', 'slug'], unique: true }],
});

defineModel(Comment, {
  table: 'st_comments',
  columns: { body: column.text(), tenantId: column.integer() },
  tenant: 'tenantId',
  relations: { post: { kind: 'belongsTo', target: () => Post } },
});

/** A global table. */
export const Tag = defineTable({
  table: 'st_tags',
  columns: { name: column.string(40) },
  indexes: [{ columns: ['name'], unique: true }],
});

/** A tenant-scoped link table between posts and the global tags. */
export const PostTag = defineTable({
  table: 'st_post_tags',
  columns: { tenantId: column.integer() },
  tenant: 'tenantId',
  relations: {
    post: { kind: 'belongsTo', target: () => Post },
    tag: { kind: 'belongsTo', target: () => Tag },
  },
  indexes: [{ columns: ['tenantId', 'postId', 'tagId'], unique: true }],
});

/** A tenant-scoped table keyed by a string tenant. */
export const Note = defineTable({
  table: 'st_notes',
  columns: { org: column.string(40), text: column.string(200) },
  tenant: 'org',
});

/** Every model of the suites, in dependency order. */
export const MODELS: readonly ModelTarget[] = Object.freeze([
  Author,
  Post,
  Comment,
  Tag,
  PostTag,
  Note,
]);
