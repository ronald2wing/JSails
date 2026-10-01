/**
 * Media library (`jsails/media`): an upload/list/update/remove surface over the
 * {@link Disk} seam plus pure editor-selection helpers.
 *
 * The surface is re-exported from the public `jsails/media` barrel. Integration
 * points for the remaining wiring:
 *
 * - **Admin file field** — `createMediaLibrary` stores bytes through the same
 *   `Disk` contract an admin resource's `resolveFileDisk` resolver returns
 *   (`src/admin/resource/resource-descriptor.ts`), so a `file` field can write
 *   through the library by resolving the field's disk and calling `upload`.
 * - **Editor** — `selectMedia`/`toMediaRef` project library assets into the
 *   content model's media references and the picker's search/ordering.
 */

export {
  createMediaLibrary,
  createMemoryMediaIndex,
  DEFAULT_ALLOWED_MEDIA_TYPES,
  DEFAULT_MAX_MEDIA_BYTES,
  MediaError,
  mimeMatches,
  type MediaAsset,
  type MediaContent,
  type MediaErrorCode,
  type MediaIndex,
  type MediaLibrary,
  type MediaLibraryOptions,
  type MediaPatch,
  type MediaUploadInput,
} from './library.js';

export { selectMedia, toMediaRef, type MediaRef, type MediaSelectionQuery } from './selection.js';

export { createDatabaseMediaIndex, type DatabaseMediaIndexOptions } from './persistence/index.js';
export {
  JsailsMediaAsset,
  MEDIA_ASSET_TABLE,
  MEDIA_FILENAME_COLUMN_LENGTH,
  MEDIA_ID_COLUMN_LENGTH,
  MEDIA_PATH_COLUMN_LENGTH,
  mediaEntities,
} from './persistence/entities.js';
