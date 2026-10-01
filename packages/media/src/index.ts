/**
 * Media library (`@jsails/media`): an upload/list/update/remove surface over
 * the `Disk` seam, a database-backed asset index, and pure
 * editor-selection helpers.
 *
 * - **Admin** — `@jsails/media/admin` mounts the library as an admin page; a
 *   resource `file` field can also write through the same library by resolving
 *   the field's disk and calling `upload`.
 * - **Editor** — `selectMedia`/`toMediaRef` project library assets into the
 *   content model's media references and the picker's search/ordering.
 */

export {
  createMediaLibrary,
  createMemoryMediaIndex,
  MediaLibraryError,
  type MediaAsset,
  type MediaContent,
  type MediaLibraryErrorCode,
  type MediaIndex,
  type MediaLibrary,
  type MediaLibraryOptions,
  type MediaPatch,
  type MediaUploadInput,
} from './library.js';

export {
  paginateMedia,
  selectMedia,
  toMediaRef,
  type MediaPageQuery,
  type MediaRef,
  type MediaSelectionPage,
  type MediaSelectionQuery,
} from './selection.js';

export { createDatabaseMediaIndex, type DatabaseMediaIndexOptions } from './database-index.js';
export { JsailsMediaAsset, mediaEntities } from './entities.js';
