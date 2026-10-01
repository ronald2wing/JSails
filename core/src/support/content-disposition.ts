/**
 * `contentDisposition`: the `Content-Disposition` header builder, part of the
 * `Url` namespace, in its own module so a file response (a server-component
 * download) does not load the query-string parser with it.
 */

import { assertString } from '../validation/primitives.js';
import { UrlErrors, urlError } from './url-errors.js';

/**
 * Build a `Content-Disposition` header value for a download or inline file.
 *
 * The ASCII `filename` fallback escapes quotes and backslashes; non-ASCII
 * names are also emitted in RFC 5987 `filename*=UTF-8''...` form.
 */
export function contentDisposition(
  filename: string,
  options?: { type?: 'attachment' | 'inline' },
): string {
  assertString(filename, 'Url.contentDisposition', urlError);

  const type = options?.type ?? 'attachment';
  if (type !== 'attachment' && type !== 'inline') {
    throw new UrlErrors.Error('invalid_disposition');
  }
  if (filename === '') return type;

  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '\\$&');
  const header = `${type}; filename="${ascii}"`;

  if (!/[^\x20-\x7e]/.test(filename)) return header;

  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${header}; filename*=UTF-8''${encoded}`;
}
