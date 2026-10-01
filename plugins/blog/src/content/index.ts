/**
 * Tenant-free blog content core (`jsails/blog/content`): the persisted shapes
 * (Zod schemas + inferred types) and an in-memory {@link ContentRepository}.
 *
 * The surface is re-exported from the public `jsails/blog` barrel. The
 * rich-text document contract itself lives under `jsails/editor` as the
 * framework-owned {@link RichTextDocument}. `blogPlugin` and `blogAdmin`
 * resolve one `ContentRepository` behind the same service token, so the HTTP
 * and admin surfaces share state.
 */

export {
  categorySchema,
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
  tagSchema,
  type Category,
  type CategoryInput,
  type ContentStatus,
  type JsonValue,
  type Menu,
  type MenuCreateInput,
  type MenuItem,
  type MenuUpdateInput,
  type Page,
  type PageCreateInput,
  type PageUpdateInput,
  type PageSnapshot,
  type Post,
  type PostCreateInput,
  type PostUpdateInput,
  type PostSnapshot,
  type Revision,
  type RevisionInput,
  type Setting,
  type Tag,
  type TagInput,
} from './model.js';

export {
  ContentError,
  createContentRepository,
  type ContentErrorCode,
  type ContentRepository,
  type ContentRepositoryOptions,
} from './repository.js';

export { markdownToRichText } from './markdown.js';
