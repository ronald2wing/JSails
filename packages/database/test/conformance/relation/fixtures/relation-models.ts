/**
 * Models for the relation suites, every one tenant-scoped but the tag table,
 * so each load runs under the tenant policy: authors with a `hasOne` profile
 * and their posts; posts with comments, tags through a link table, and
 * polymorphic notes; comments with an optional author and notes of their
 * own; notes whose subject is a post or a comment. Authors also reach their
 * posts' comments through their posts (a through relation over a `hasMany`).
 * Each suite opens its own data source over them, so a file binds them once
 * at a time.
 */

import { column, defineModel, defineTable, type ModelTarget } from '../../../../src/model/index.js';
import { ApplicationRecord, type Relation } from '../../../../src/index.js';

/** A tag row (a global table), as loads return it. */
export interface TagRow {
  readonly id: number;
  readonly name: string;
}

export class Author extends ApplicationRecord {
  declare id: number;
  declare tenantId: number;
  declare name: string;
  declare posts: Relation<Post[]>;
  declare profile: Relation<Profile | null>;
  declare comments: Relation<Comment[]>;
}

export class Profile extends ApplicationRecord {
  declare id: number;
  declare tenantId: number;
  declare bio: string;
  declare authorId: number;
  declare author: Relation<Author>;
}

export class Post extends ApplicationRecord {
  declare id: number;
  declare tenantId: number;
  declare title: string;
  declare rank: number;
  declare authorId: number | null;
  declare author: Relation<Author | null>;
  declare comments: Relation<Comment[]>;
  declare tags: Relation<TagRow[]>;
  declare notes: Relation<Note[]>;
}

export class Comment extends ApplicationRecord {
  declare id: number;
  declare tenantId: number;
  declare body: string;
  declare score: number;
  declare approved: boolean;
  declare postId: number;
  declare authorId: number | null;
  declare post: Relation<Post>;
  declare author: Relation<Author | null>;
  declare notes: Relation<Note[]>;
}

export class Note extends ApplicationRecord {
  declare id: number;
  declare tenantId: number;
  declare text: string;
  declare subjectType: string | null;
  declare subjectId: number | null;
  declare subject: Relation<Post | Comment | null>;
}

const tenantId = column.integer();

defineModel(Author, {
  table: 'rl_authors',
  columns: { tenantId, name: column.string(60) },
  tenant: 'tenantId',
  relations: {
    posts: { kind: 'hasMany', target: () => Post, inverse: 'author' },
    profile: { kind: 'hasOne', target: () => Profile, inverse: 'author' },
    comments: { kind: 'hasMany', target: () => Comment, through: 'posts', source: 'comments' },
  },
});

defineModel(Profile, {
  table: 'rl_profiles',
  columns: { tenantId, bio: column.string(120) },
  tenant: 'tenantId',
  relations: { author: { kind: 'belongsTo', target: () => Author, onDelete: 'cascade' } },
});

defineModel(Post, {
  table: 'rl_posts',
  columns: { tenantId, title: column.string(120), rank: column.integer({ default: 0 }) },
  tenant: 'tenantId',
  relations: {
    author: { kind: 'belongsTo', target: () => Author, nullable: true, onDelete: 'set null' },
    comments: { kind: 'hasMany', target: () => Comment, inverse: 'post' },
    postTags: { kind: 'hasMany', target: () => PostTag, inverse: 'post' },
    tags: { kind: 'hasMany', target: () => Tag, through: 'postTags', source: 'tag' },
    notes: { kind: 'hasMany', target: () => Note, inverse: 'subject' },
  },
});

defineModel(Comment, {
  table: 'rl_comments',
  columns: {
    tenantId,
    body: column.string(120),
    score: column.integer({ default: 0 }),
    approved: column.boolean({ default: false }),
  },
  tenant: 'tenantId',
  relations: {
    post: { kind: 'belongsTo', target: () => Post, onDelete: 'cascade' },
    author: { kind: 'belongsTo', target: () => Author, nullable: true, onDelete: 'set null' },
    notes: { kind: 'hasMany', target: () => Note, inverse: 'subject' },
  },
});

defineModel(Note, {
  table: 'rl_notes',
  columns: { tenantId, text: column.string(120) },
  tenant: 'tenantId',
  relations: { subject: { kind: 'belongsTo', polymorphic: true, nullable: true } },
});

/** A global table. */
export const Tag = defineTable({
  table: 'rl_tags',
  columns: { name: column.string(40) },
  indexes: [{ columns: ['name'], unique: true }],
});

/** The tenant-scoped link between posts and tags. */
export const PostTag = defineTable({
  table: 'rl_post_tags',
  columns: { tenantId },
  tenant: 'tenantId',
  relations: {
    post: { kind: 'belongsTo', target: () => Post, onDelete: 'cascade' },
    tag: { kind: 'belongsTo', target: () => Tag, onDelete: 'cascade' },
  },
  indexes: [{ columns: ['tenantId', 'postId', 'tagId'], unique: true }],
});

/** Every model of the suites, in dependency order. */
export const RELATION_MODELS: readonly ModelTarget[] = Object.freeze([
  Author,
  Profile,
  Post,
  Comment,
  Note,
  Tag,
  PostTag,
]);
