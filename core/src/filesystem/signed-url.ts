/**
 * Time-limited URLs: an optional capability of the {@link Disk} contract.
 *
 * An object store can hand a client a short-lived signed URL that reads one
 * stored file directly, so a download or preview never passes through the app
 * process. A {@link UrlDisk} adds `url(key, options)` for that; callers that
 * accept any `Disk` check for it with {@link isUrlDisk}, or call
 * {@link diskUrl}, which refuses a disk without the capability with a
 * value-free `unsupported` {@link DiskError}.
 *
 * A signed URL is a bearer credential for one file until it expires, so the
 * lifetime is bounded: {@link DISK_URL_DEFAULT_EXPIRES_IN} (15 minutes) when
 * omitted and never more than {@link DISK_URL_MAX_EXPIRES_IN} (7 days, the
 * longest an S3 SigV4 presigned URL can live). Implementations reject a
 * lifetime outside `1..DISK_URL_MAX_EXPIRES_IN` rather than clamping it, so a
 * caller asking for "forever" learns it cannot have it.
 */

import { DiskError, type Disk } from './disk.js';

/** Lifetime of a disk URL when `expiresIn` is omitted: 15 minutes, in seconds. */
export const DISK_URL_DEFAULT_EXPIRES_IN = 900;

/** The longest lifetime a disk URL may have: 7 days, in seconds. */
export const DISK_URL_MAX_EXPIRES_IN = 604_800;

/** Options for {@link UrlDisk.url}. */
export interface DiskUrlOptions {
  /**
   * Lifetime in whole seconds, from 1 to {@link DISK_URL_MAX_EXPIRES_IN}.
   * Defaults to {@link DISK_URL_DEFAULT_EXPIRES_IN}.
   */
  readonly expiresIn?: number;
  /**
   * The `Content-Disposition` the store answers with: `inline` to display,
   * `attachment` to download. Omitted leaves the store's default.
   */
  readonly disposition?: 'inline' | 'attachment';
  /** Filename carried in the disposition; requires `disposition`. */
  readonly filename?: string;
  /** The `Content-Type` the store answers with, overriding the stored one. */
  readonly contentType?: string;
}

/** A disk that can issue time-limited URLs for its files. */
export interface UrlDisk extends Disk {
  /** A URL that reads the file at `relativePath` until it expires. */
  url(relativePath: string, options?: DiskUrlOptions): Promise<string>;
}

/** True when `disk` implements the {@link UrlDisk} capability. */
export function isUrlDisk(disk: Disk): disk is UrlDisk {
  return typeof (disk as Partial<UrlDisk>).url === 'function';
}

/**
 * Issue a time-limited URL for `relativePath` on `disk`. A disk without the
 * {@link UrlDisk} capability (a local directory, memory) raises a value-free
 * `unsupported` {@link DiskError}; serve those files through an app route.
 */
export async function diskUrl(
  disk: Disk,
  relativePath: string,
  options?: DiskUrlOptions,
): Promise<string> {
  if (!isUrlDisk(disk)) {
    throw new DiskError('unsupported', 'this disk cannot issue URLs');
  }
  return disk.url(relativePath, options);
}
