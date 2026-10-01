/**
 * Models for the query and record suites: authors and their posts (a record
 * class with optimistic locking, a nullable timestamp, a self relation and a
 * tag set through a link table), comments, polymorphic attachments, and a
 * global tag table. Each suite opens its own data source over them, so a
 * file binds them once at a time.
 */

import { ApplicationRecord } from '../../../src/record/index.js';
import { column, defineModel, defineTable, type ModelTarget } from '../../../src/model/index.js';

export class Author extends ApplicationRecord {
  declare id: number;
  declare name: string;
}

export class Post extends ApplicationRecord {
  declare id: number;
  declare title: string;
  declare status: 'draft' | 'live';
  declare views: number;
  declare publishedAt: Date | null;
  declare authorId: number | null;
  declare parentId: number | null;
  declare lockVersion: number;

  /** A method, which `Where<Post>` and `ColumnKey<Post>` must leave out. */
  headline(): string {
    return this.title.toUpperCase();
  }
}

export class Comment extends ApplicationRecord {
  declare id: number;
  declare body: string;
  declare approved: boolean;
  declare postId: number;
}

export class Attachment extends ApplicationRecord {
  declare id: number;
  declare label: string;
  declare ownerType: string;
  declare ownerId: number;
}

defineModel(Author, {
  table: 'q_authors',
  columns: { name: column.string(100) },
  relations: { posts: { kind: 'hasMany', target: () => Post, inverse: 'author' } },
});

defineModel(Post, {
  table: 'q_posts',
  columns: {
    title: column.string(200),
    status: column.string(10, { enum: ['draft', 'live'], default: 'draft' }),
    views: column.integer({ default: 0 }),
    publishedAt: column.timestamp({ nullable: true }),
  },
  lockVersion: true,
  relations: {
    author: { kind: 'belongsTo', target: () => Author, nullable: true, onDelete: 'set null' },
    parent: { kind: 'belongsTo', target: () => Post, nullable: true, onDelete: 'set null' },
    children: { kind: 'hasMany', target: () => Post, inverse: 'parent' },
    comments: { kind: 'hasMany', target: () => Comment, inverse: 'post', dependent: 'destroy' },
    postTags: { kind: 'hasMany', target: () => PostTag, inverse: 'post', dependent: 'destroy' },
    tags: { kind: 'hasMany', target: () => Tag, through: 'postTags', source: 'tag' },
    attachments: { kind: 'hasMany', target: () => Attachment, inverse: 'owner' },
  },
});

defineModel(Comment, {
  table: 'q_comments',
  columns: { body: column.text(), approved: column.boolean({ default: false }) },
  relations: { post: { kind: 'belongsTo', target: () => Post } },
});

defineModel(Attachment, {
  table: 'q_attachments',
  columns: { label: column.string(60) },
  relations: { owner: { kind: 'belongsTo', polymorphic: true } },
});

/** A global table. */
export const Tag = defineTable({
  table: 'q_tags',
  columns: { name: column.string(40) },
  indexes: [{ columns: ['name'], unique: true }],
});

/** The link table between posts and tags. */
export const PostTag = defineTable({
  table: 'q_post_tags',
  columns: {},
  relations: {
    post: { kind: 'belongsTo', target: () => Post },
    tag: { kind: 'belongsTo', target: () => Tag },
  },
  indexes: [{ columns: ['postId', 'tagId'], unique: true }],
});

/** Every model of the suites, in dependency order. */
export const MODELS: readonly ModelTarget[] = Object.freeze([
  Author,
  Post,
  Comment,
  Attachment,
  Tag,
  PostTag,
]);
