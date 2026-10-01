/**
 * Reading asset roots from disk: resolving the roots, walking them, and
 * hashing what the walk found.
 *
 * The walk never follows a symbolic link: it reads directory entries and
 * descends only into real directories, so every file it yields lies inside
 * its root without a containment check. A symlink, a special file (a FIFO, a
 * socket, a device) and an entry whose URL path {@link validateAssetPath}
 * refuses are left out and counted as refused; a hidden entry (`.env`,
 * `.git`), which was never servable, is left out silently. Files are opened
 * with `O_NOFOLLOW` where the platform has it, so a file swapped for a link
 * between the walk and the read is not read through the link.
 *
 * A failed filesystem call is taken one of three ways
 * ({@link readFailureOf}): the entry is gone (removed, or swapped for a link,
 * since the walk), which leaves it out; the process may not read it (a
 * root-owned file a deploy left behind), which leaves it out and counts it
 * as unreadable, so one stray file never stops the app; any other failure
 * (an I/O error, no descriptors left) throws `asset.read_failed`, which
 * names the URL path, never the filesystem location. The root directory
 * itself is the exception: one the process cannot list is `read_failed`,
 * since the app would otherwise serve none of it without saying why.
 *
 * A content hash is SHA-256, base64url, cut to 16 characters: the form the
 * build pass's manifest records, so a walked index and a built one agree.
 */

import { createHash, type Hash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { isErrno } from '../errors/inspect.js';
import { AssetErrors, pathSlot } from './asset-errors.js';
import { validateAssetPath } from './asset-path.js';

/**
 * A directory whose files the index serves under `prefix`.
 *
 * @public
 */
export interface AssetRoot {
  /** The directory. A missing one serves nothing. */
  readonly dir: string;
  /** The URL path its files are served under: `/` (the default) or an asset path. */
  readonly prefix?: string;
  /** Who provides the files: `app` (the default) or a plugin's name. */
  readonly owner?: string;
}

/**
 * An {@link AssetRoot} as the index uses it: its directory absolute.
 *
 * @public
 */
export interface ResolvedAssetRoot {
  readonly dir: string;
  readonly prefix: string;
  readonly owner: string;
}

/** A file a walk found. */
export interface WalkedFile {
  /** Its URL path, decoded. */
  readonly path: string;
  /** Its absolute location. */
  readonly file: string;
  readonly owner: string;
}

/** What one walk of every root found. */
export interface Walk {
  readonly files: readonly WalkedFile[];
  /** Entries left out that are not hidden: links, special files, refused names. */
  readonly refused: number;
  /** Directories below a root the process may not list. */
  readonly unreadable: number;
}

/** How a failed filesystem call on an asset is taken: see the module header. */
export type ReadFailure = 'gone' | 'unreadable' | 'failed';

/** Classify `error`, thrown by a filesystem call on an asset. */
export function readFailureOf(error: unknown): ReadFailure {
  if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') || isErrno(error, 'ELOOP')) {
    return 'gone';
  }
  if (isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) return 'unreadable';
  return 'failed';
}

/** The value-free error of a read of the asset at `path` that failed with `cause`. */
export function readFailedError(path: string, cause: unknown): Error {
  return new AssetErrors.Error('read_failed', { path: pathSlot(path) }, { cause });
}

/**
 * `error` as {@link readFailureOf} takes it when the entry may be left out:
 * `gone` or `unreadable`; anything else throws `asset.read_failed`.
 */
function leftOut(error: unknown, path: string): 'gone' | 'unreadable' {
  const failure = readFailureOf(error);
  if (failure === 'failed') throw readFailedError(path, error);
  return failure;
}

/** Bytes read per step when a file is hashed or streamed. */
export const READ_CHUNK_BYTES: number = 64 * 1024;

/** The flags every asset is opened with: read-only, and not through a final symlink. */
export const OPEN_FLAGS: number = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** The content hash of `digest`'s input: SHA-256, base64url, 16 characters. */
export function hashOf(digest: Hash): string {
  return digest.digest('base64url').slice(0, 16);
}

/**
 * Validate and resolve `roots`: each prefix `/` or an asset path, each
 * directory absolute. A root that does not exist is dropped.
 *
 * @throws `asset.invalid_prefix` for a malformed prefix, `asset.invalid_root`
 *   for a root that is a symbolic link or not a directory.
 */
export function resolveRoots(roots: readonly AssetRoot[]): readonly ResolvedAssetRoot[] {
  const resolved: ResolvedAssetRoot[] = [];
  for (const root of roots) {
    const prefix = root.prefix ?? '/';
    if (prefix !== '/' && (!validateAssetPath(prefix) || prefix.endsWith('/'))) {
      throw new AssetErrors.Error('invalid_prefix');
    }
    if (typeof root.dir !== 'string' || root.dir === '') {
      throw new AssetErrors.Error('invalid_root');
    }
    const dir = resolve(root.dir);
    let stat;
    try {
      stat = lstatSync(dir);
    } catch (error) {
      // A root that does not exist, or under a file, serves nothing; one that
      // cannot be inspected is a misconfigured root, not a missing one.
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) continue;
      throw readFailedError(prefix, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AssetErrors.Error('invalid_root');
    resolved.push(Object.freeze({ dir, prefix, owner: root.owner ?? 'app' }));
  }
  return Object.freeze(resolved);
}

/** The URL path of `segments` under `prefix`. */
function urlPath(prefix: string, segments: readonly string[]): string {
  return `${prefix === '/' ? '' : prefix}/${segments.join('/')}`;
}

/**
 * Walk every root, in order, each directory's entries sorted by name.
 *
 * @throws `asset.duplicate_asset` when two roots yield the same URL path,
 *   `asset.read_failed` when a root cannot be listed or a directory fails to.
 */
export function walkRoots(roots: readonly ResolvedAssetRoot[]): Walk {
  const files: WalkedFile[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  let refused = 0;
  let unreadable = 0;
  for (const root of roots) {
    const pending: (readonly string[])[] = [[]];
    while (pending.length > 0) {
      const segments = pending.pop() ?? [];
      let dirents;
      try {
        dirents = readdirSync(join(root.dir, ...segments), { withFileTypes: true });
      } catch (error) {
        const directory = segments.length === 0 ? root.prefix : urlPath(root.prefix, segments);
        const failure = readFailureOf(error);
        // A directory removed while it is walked (a bundler emptying its output) holds nothing.
        if (failure === 'gone') continue;
        if (failure === 'unreadable' && segments.length > 0) {
          unreadable += 1;
          continue;
        }
        throw readFailedError(directory, error);
      }
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const subdirectories: (readonly string[])[] = [];
      for (const dirent of dirents) {
        const entrySegments = [...segments, dirent.name];
        const path = urlPath(root.prefix, entrySegments);
        if (!validateAssetPath(path)) {
          if (!dirent.name.startsWith('.')) refused += 1;
          continue;
        }
        if (dirent.isDirectory()) {
          subdirectories.push(entrySegments);
        } else if (dirent.isFile()) {
          if (seen.has(path)) duplicates.push(path);
          seen.add(path);
          files.push({ path, file: join(root.dir, ...entrySegments), owner: root.owner });
        } else {
          refused += 1;
        }
      }
      // Pushed in reverse so the directories are walked in name order.
      for (let index = subdirectories.length - 1; index >= 0; index -= 1) {
        pending.push(subdirectories[index] ?? []);
      }
    }
  }
  if (duplicates.length > 0) {
    duplicates.sort();
    throw new AssetErrors.Error('duplicate_asset', {
      count: duplicates.length,
      path: pathSlot(duplicates[0] ?? '/'),
    });
  }
  return { files, refused, unreadable };
}

/** A file's bytes as read for its hash: the hash, the size read, and the bytes when kept. */
export interface ReadFile {
  readonly hash: string;
  readonly size: number;
  readonly bytes?: Uint8Array<ArrayBuffer>;
}

/**
 * Hash `file` (the asset at URL path `path`), keeping its bytes when it is at
 * most `keepUpTo` bytes long. `gone` when it is no longer a regular file,
 * `unreadable` when the process may not read it.
 *
 * @throws `asset.read_failed` for any other failure.
 */
export async function readForIndex(
  file: string,
  path: string,
  keepUpTo: number,
): Promise<ReadFile | 'gone' | 'unreadable'> {
  let handle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch (error) {
    return leftOut(error, path);
  }
  try {
    return await hashHandle(handle, keepUpTo);
  } catch (error) {
    return leftOut(error, path);
  } finally {
    await handle.close();
  }
}

/** Hash the open `handle`, keeping its bytes when it is at most `keepUpTo` bytes long. */
async function hashHandle(handle: FileHandle, keepUpTo: number): Promise<ReadFile | 'gone'> {
  const stat = await handle.stat();
  if (!stat.isFile()) return 'gone';
  const digest = createHash('sha256');
  if (stat.size <= keepUpTo) {
    const read = await handle.readFile();
    const bytes = new Uint8Array(read.byteLength);
    bytes.set(read);
    digest.update(bytes);
    return { hash: hashOf(digest), size: bytes.byteLength, bytes };
  }
  const buffer = new Uint8Array(READ_CHUNK_BYTES);
  let size = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, size);
    if (bytesRead === 0) break;
    digest.update(buffer.subarray(0, bytesRead));
    size += bytesRead;
  }
  return { hash: hashOf(digest), size };
}

/**
 * The `lstat` of `file` (the asset at URL path `path`), or `gone` /
 * `unreadable` as {@link readFailureOf} takes the failure.
 *
 * @throws `asset.read_failed` for any other failure.
 */
export function lstatForIndex(file: string, path: string): BigIntStats | 'gone' | 'unreadable' {
  try {
    return lstatSync(file, { bigint: true });
  } catch (error) {
    return leftOut(error, path);
  }
}

/**
 * Hash `file` (the asset at URL path `path`) synchronously: the development
 * index hashes on first use. `gone` when it is no longer a regular file,
 * `unreadable` when the process may not read it.
 *
 * @throws `asset.read_failed` for any other failure.
 */
export function readForIndexSync(file: string, path: string): ReadFile | 'gone' | 'unreadable' {
  let fd: number;
  try {
    fd = openSync(file, OPEN_FLAGS);
  } catch (error) {
    return leftOut(error, path);
  }
  try {
    if (!fstatSync(fd).isFile()) return 'gone';
    const digest = createHash('sha256');
    const buffer = new Uint8Array(READ_CHUNK_BYTES);
    let size = 0;
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.byteLength, size);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { hash: hashOf(digest), size };
  } catch (error) {
    return leftOut(error, path);
  } finally {
    closeSync(fd);
  }
}
