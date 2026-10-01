/**
 * The media admin page's `POST` mutations, dispatched on the `action` field:
 * `upload`, `update`, and `delete`. The admin panel has already enforced the
 * auth gate, a same-origin `Origin`, and a constant-time `_csrf` check, so
 * this module only applies the media library's own policy and its value-free
 * error responses.
 *
 * - `upload` takes the first file part of the multipart body and calls
 *   `library.upload`. Client-supplied size/width/height are ignored, and the
 *   declared MIME is only trusted as far as the library itself validates it.
 * - `update` calls `library.update(id, { alt, caption })`; a missing id is a
 *   404.
 * - `delete` calls `library.remove(id)`; `not_found` maps to 404, other media
 *   failures map to a value-free 400/500.
 *
 * A successful mutation redirects back to the list with a stable `?notice=`
 * code. Every error response is value-free: filenames, ids, MIME types, and
 * error details are never echoed.
 */

import {
  adminBadRequestResponse,
  adminNotFoundResponse,
  adminRedirectResponse,
  adminServerErrorResponse,
  readFormBodyAndFiles,
  type AdminPagePostContext,
  type UploadedFilePart,
} from '@jsails/admin';

import { MediaLibraryError, type MediaLibrary } from '../library.js';
import type { MediaAdminPageOptions } from './page.js';
import { NOTICE_DELETED, NOTICE_UPDATED, NOTICE_UPLOADED } from './render.js';

/** Dispatch the page POST on the submitted `action` field. */
export async function handleMediaPost(
  context: AdminPagePostContext,
  options: MediaAdminPageOptions,
): Promise<Response> {
  const { library } = options;
  const path = options.path ?? context.path;

  switch (context.body['action']) {
    case 'upload':
      return handleUpload(context, library, path);
    case 'update':
      return handleUpdate(context, library, path);
    case 'delete':
      return handleDelete(context, library, path);
    default:
      return adminBadRequestResponse();
  }
}

/** The redirect target after a successful mutation, carrying a stable notice. */
function redirectWithNotice(path: string, notice: string): Response {
  return adminRedirectResponse(`${path}/media?notice=${notice}`);
}

/** Handle `upload`: read the first file part and call `library.upload`. */
async function handleUpload(
  context: AdminPagePostContext,
  library: MediaLibrary,
  path: string,
): Promise<Response> {
  // The admin route parses the multipart body once and hands the file parts
  // through the post context. Direct callers of this handler can omit `files`;
  // in that case read a still-unconsumed request as a fallback.
  const files = context.files ?? (await readFormBodyAndFiles(context.request)).files;
  const file = firstFilePart(files);
  if (file === undefined) {
    return adminBadRequestResponse();
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return adminBadRequestResponse();
  }
  if (bytes.byteLength === 0) {
    return adminBadRequestResponse();
  }

  const alt = context.body['alt'];
  const caption = context.body['caption'];

  try {
    await library.upload({
      bytes,
      filename: file.name,
      mimeType: file.type === '' ? 'application/octet-stream' : file.type,
      ...(alt === undefined ? {} : { alt }),
      ...(caption === undefined ? {} : { caption }),
    });
  } catch (error) {
    return mapMediaFailure(error);
  }

  return redirectWithNotice(path, NOTICE_UPLOADED);
}

/** Handle `update`: patch alt/caption; a missing id is a 404. */
async function handleUpdate(
  context: AdminPagePostContext,
  library: MediaLibrary,
  path: string,
): Promise<Response> {
  const id = context.body['id'];
  if (id === undefined || id === '') {
    return adminBadRequestResponse();
  }
  const alt = context.body['alt'];
  const caption = context.body['caption'];

  try {
    const updated = await library.update(id, {
      ...(alt === undefined ? {} : { alt }),
      ...(caption === undefined ? {} : { caption }),
    });
    if (updated === undefined) {
      return adminNotFoundResponse();
    }
  } catch (error) {
    return mapMediaFailure(error);
  }

  return redirectWithNotice(path, NOTICE_UPDATED);
}

/** Handle `delete`: remove and map `not_found` (and other failures) value-free. */
async function handleDelete(
  context: AdminPagePostContext,
  library: MediaLibrary,
  path: string,
): Promise<Response> {
  const id = context.body['id'];
  if (id === undefined || id === '') {
    return adminBadRequestResponse();
  }

  try {
    await library.remove(id);
  } catch (error) {
    return mapMediaFailure(error);
  }

  return redirectWithNotice(path, NOTICE_DELETED);
}

/** The first file part from a parsed multipart body, or `undefined` when none. */
function firstFilePart(files: ReadonlyMap<string, UploadedFilePart>): UploadedFilePart | undefined {
  return files.values().next().value;
}

/** Map a media failure to a value-free response. Raw input is never echoed. */
function mapMediaFailure(error: unknown): Response {
  if (error instanceof MediaLibraryError) {
    switch (error.code) {
      case 'not_found':
        return adminNotFoundResponse();
      case 'too_large':
      case 'unsupported_content_type':
      case 'invalid_input':
      case 'path_rejected':
        return adminBadRequestResponse();
      case 'io_failed':
      case 'not_initialized':
      case 'missing_table':
        return adminServerErrorResponse();
    }
  }
  return adminServerErrorResponse();
}
