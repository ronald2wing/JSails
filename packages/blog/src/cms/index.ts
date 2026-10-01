/**
 * Tenant-free blog CMS core: the persisted shapes (Zod schemas + inferred
 * types), the `BlogRepository` contract, and its in-memory implementation.
 *
 * The rich-text document contract itself is core's `jsails/rich-text`.
 */

export {
  blogTermSchema,
  contentStatusSchema,
  jsonValueSchema,
  menuItemSchema,
  menuSchema,
  pageSchema,
  pageSnapshotSchema,
  postSchema,
  postSnapshotSchema,
  revisionSchema,
  settingSchema,
  type BlogContentStatus,
  type BlogMenu,
  type BlogMenuCreateInput,
  type BlogMenuItem,
  type BlogMenuUpdateInput,
  type BlogPage,
  type BlogPageCreateInput,
  type BlogPageSnapshot,
  type BlogPageUpdateInput,
  type BlogPost,
  type BlogPostCreateInput,
  type BlogPostSnapshot,
  type BlogPostUpdateInput,
  type BlogRevision,
  type BlogRevisionInput,
  type BlogSetting,
  type BlogTerm,
  type BlogTermInput,
} from './model.js';

export { BlogContentError, type BlogContentErrorCode, type BlogRepository } from './repository.js';

export {
  createMemoryBlogRepository,
  type MemoryBlogRepositoryOptions,
} from './memory-repository.js';
