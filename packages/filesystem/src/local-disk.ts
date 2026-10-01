/**
 * Local filesystem disk: a {@link Disk} backed by a directory on disk.
 *
 * `new LocalDisk({ root, maxBytes?, createRoot? })` stores files under `root`
 * addressed by relative POSIX keys. It is built for safety first:
 *
 * - **Key safety.** Every key is validated as a relative POSIX path, so a key
 *   can never lexically escape `root`.
 * - **Symlink safety.** `root` and each existing ancestor directory of a target
 *   are resolved through `realpath`; a symlink that would resolve outside the
 *   root (including a dangling one) fails closed with a value-free error.
 *   `list` never follows symlinks.
 * - **Atomic writes.** Data is written to a temp file in the same directory and
 *   `rename`d over the target, so a reader never observes a partial file and a
 *   failed write leaves the previous content intact.
 * - **Lazy root.** Creation never requires `root` to exist: it is created
 *   (`mkdir -p`, including parent directories of the key) on the first write,
 *   unless `createRoot: true` creates it eagerly.
 * - **No open handles.** Files are opened per operation and closed, so the disk
 *   needs no `close()` and cleanup is a no-op.
 *
 * All I/O failures surface as value-free {@link DiskError}s (never echoing a
 * path or the data); option mistakes surface as `TypeError` at construction.
 */

import { mkdirSync, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { isErrno } from 'jsails/plugin-sdk';
import { Encoding } from 'jsails/support';
import { DiskError, type Disk, type DiskData, type DiskPutOptions } from 'jsails/filesystem';
import {
  assertContentType,
  assertDiskKey,
  assertDiskPrefix,
  toDiskBytes,
  toDiskIoError,
  validateMaxBytes,
} from './disk-validation.js';

/** Options for {@link LocalDisk}. */
export interface LocalDiskOptions {
  /** The directory that owns the stored files. */
  readonly root: string;
  /** Optional cap on total stored bytes; exceeding it fails `put` before writing. */
  readonly maxBytes?: number;
  /** Create `root` eagerly at construction; default is lazy (on first write). */
  readonly createRoot?: boolean;
}

/** True for the errors that mean "nothing there" (`ENOENT`/`ENOTDIR`/`EISDIR`). */
function isNotFound(error: unknown): boolean {
  return isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') || isErrno(error, 'EISDIR');
}

/**
 * True when `candidate` is `root` or lives strictly inside it. The check is
 * segment-aware (`root-other` is outside `root`) and treats a relative path
 * that comes back absolute (a different Windows drive) as outside.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** The `not_found` failure every missing file surfaces as. */
function notFound(): DiskError {
  return new DiskError('not_found', 'file not found');
}

/**
 * A disk backed by a real directory. Construct with
 * `new LocalDisk({ root, maxBytes?, createRoot? })`: construction validates
 * options and (when `createRoot`) creates the root; it never reads or opens the
 * files otherwise.
 */
export class LocalDisk implements Disk {
  readonly #rootPath: string;
  readonly #maxBytes: number | undefined;
  #rootRealCache: string | undefined;
  #totalBytes: number | undefined;

  constructor(options: LocalDiskOptions) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('LocalDisk requires an options object');
    }
    if (typeof options.root !== 'string' || options.root.trim() === '') {
      throw new TypeError('root must be a non-empty string');
    }
    this.#maxBytes = validateMaxBytes(options.maxBytes);
    this.#rootPath = resolve(options.root);

    if (options.createRoot === true) {
      try {
        mkdirSync(this.#rootPath, { recursive: true });
      } catch (error) {
        throw toDiskIoError(error);
      }
    }
  }

  /**
   * Resolve the real root without creating it; `undefined` when it is absent.
   * The resolved real path is memoized once the root exists (lazily created on
   * the first write). Every target is derived from this real path, so a
   * symlinked root resolves to its target before any containment check.
   */
  async #resolveRootReal(): Promise<string | undefined> {
    if (this.#rootRealCache !== undefined) {
      return this.#rootRealCache;
    }
    try {
      this.#rootRealCache = await realpath(this.#rootPath);
      return this.#rootRealCache;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw toDiskIoError(error);
    }
  }

  /** Create the root (mkdir -p) and memoize its real path. */
  async #ensureRoot(): Promise<string> {
    if (this.#rootRealCache !== undefined) {
      return this.#rootRealCache;
    }
    try {
      await mkdir(this.#rootPath, { recursive: true });
      this.#rootRealCache = await realpath(this.#rootPath);
      return this.#rootRealCache;
    } catch (error) {
      throw toDiskIoError(error);
    }
  }

  /**
   * Resolve `target` and verify the result stays inside the root. A missing
   * target (including a dangling symlink) surfaces as `not_found` so callers
   * can apply their own policy; an escaping symlink is always refused.
   */
  async #resolveContained(root: string, target: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await realpath(target);
    } catch (error) {
      if (isNotFound(error)) {
        throw notFound();
      }
      throw toDiskIoError(error);
    }
    if (!isInsideRoot(root, resolved)) {
      throw new DiskError('invalid_key', 'disk path escapes the root directory through a symlink');
    }
    return resolved;
  }

  /**
   * Walk every existing ancestor directory of `target` and reject any symlink
   * that escapes the root. The final segment is handled by each operation, since
   * its semantics differ (rename replaces it, reads follow it, list skips it).
   */
  async #assertNoSymlinkEscape(root: string, target: string): Promise<void> {
    if (!isInsideRoot(root, target)) {
      throw new DiskError('invalid_key', 'disk path escapes the root directory');
    }
    const rel = relative(root, target);
    if (rel === '') {
      return;
    }
    const segments = rel.split(sep);
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      let stats: Stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if (isNotFound(error)) {
          return; // ancestor missing: nothing deeper can be symlinked
        }
        throw toDiskIoError(error);
      }
      if (stats.isSymbolicLink()) {
        try {
          await this.#resolveContained(root, current);
        } catch (error) {
          if (error instanceof DiskError && error.code === 'not_found') {
            return; // dangling symlink: nothing below it exists
          }
          throw error;
        }
      } else if (!stats.isDirectory()) {
        return; // a file where a directory is expected: nothing below it exists
      }
    }
  }

  /**
   * Resolve a key to its contained real path and stat it as a regular file.
   * Shared by `get` and `size`, so both apply the same symlink policy and the
   * same `not_found` for a directory or special file.
   */
  async #statRegularFile(root: string, key: string): Promise<{ path: string; stats: Stats }> {
    const target = join(root, key);
    await this.#assertNoSymlinkEscape(root, target);
    const path = await this.#resolveContained(root, target);
    let stats: Stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (isNotFound(error)) {
        throw notFound();
      }
      throw toDiskIoError(error);
    }
    if (!stats.isFile()) {
      throw notFound();
    }
    return { path, stats };
  }

  /**
   * Yield the full path of every regular file under `dir`, never following
   * symlinks. A directory or file that vanishes mid-walk is skipped; any other
   * I/O failure surfaces value-free.
   */
  async *#walkFiles(dir: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw toDiskIoError(error);
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.#walkFiles(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }

  /** The tracked total, lazily summed from disk when `maxBytes` is enforced. */
  async #getTotal(root: string): Promise<number> {
    if (this.#maxBytes === undefined) {
      return Number.POSITIVE_INFINITY;
    }
    if (this.#totalBytes === undefined) {
      let total = 0;
      for await (const file of this.#walkFiles(root)) {
        try {
          total += (await lstat(file)).size;
        } catch (error) {
          if (!isNotFound(error)) {
            throw toDiskIoError(error);
          }
          // A file that vanished mid-scan contributes nothing.
        }
      }
      this.#totalBytes = total;
    }
    return this.#totalBytes;
  }

  /** Best-effort temp-file cleanup; the primary write error always wins. */
  async #unlinkQuietly(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // Ignored: a leftover temp file is harmless; the failing operation's error
      // is what matters and must propagate unchanged.
    }
  }

  async put(key: string, data: DiskData, options?: DiskPutOptions): Promise<void> {
    assertDiskKey(key);
    assertContentType(options?.contentType);
    const bytes = toDiskBytes(data);
    const root = await this.#ensureRoot();
    const target = join(root, key);
    await this.#assertNoSymlinkEscape(root, target);

    let existingSize = 0;
    try {
      const stats = await lstat(target);
      if (stats.isDirectory()) {
        throw new DiskError('io_failed', 'disk entry is a directory');
      }
      if (stats.isSymbolicLink()) {
        // Rename would replace the link without writing through it, but a link
        // pointing outside the root is refused regardless. A dangling link has
        // no target to escape to, so it is simply replaced.
        try {
          await this.#resolveContained(root, target);
        } catch (error) {
          if (!(error instanceof DiskError && error.code === 'not_found')) {
            throw error;
          }
        }
      } else {
        existingSize = stats.size;
      }
    } catch (error) {
      if (error instanceof DiskError) {
        throw error;
      }
      if (!isNotFound(error)) {
        throw toDiskIoError(error);
      }
    }

    const total = await this.#getTotal(root);
    if (this.#maxBytes !== undefined && total - existingSize + bytes.length > this.#maxBytes) {
      throw new DiskError('too_large', 'disk capacity exceeded');
    }

    const parent = dirname(target);
    const temp = join(parent, `.${Encoding.hex(Encoding.randomBytes(6))}.tmp`);
    try {
      await mkdir(parent, { recursive: true });
      await writeFile(temp, bytes);
      await rename(temp, target);
    } catch (error) {
      await this.#unlinkQuietly(temp);
      throw toDiskIoError(error);
    }

    if (this.#maxBytes !== undefined) {
      this.#totalBytes = total - existingSize + bytes.length;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    assertDiskKey(key);
    const root = await this.#resolveRootReal();
    if (root === undefined) {
      throw notFound();
    }
    const { path } = await this.#statRegularFile(root, key);
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if (isNotFound(error)) {
        throw notFound();
      }
      throw toDiskIoError(error);
    }
  }

  async exists(key: string): Promise<boolean> {
    assertDiskKey(key);
    const root = await this.#resolveRootReal();
    if (root === undefined) {
      return false;
    }
    const target = join(root, key);
    await this.#assertNoSymlinkEscape(root, target);
    try {
      await this.#resolveContained(root, target);
      return true;
    } catch (error) {
      if (error instanceof DiskError && error.code === 'not_found') {
        return false;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertDiskKey(key);
    const root = await this.#resolveRootReal();
    if (root === undefined) {
      return; // idempotent
    }
    const target = join(root, key);
    await this.#assertNoSymlinkEscape(root, target);

    let existingSize = 0;
    try {
      const stats = await lstat(target);
      if (stats.isDirectory()) {
        throw new DiskError('io_failed', 'disk entry is a directory');
      }
      existingSize = stats.isFile() ? stats.size : 0;
    } catch (error) {
      if (error instanceof DiskError) {
        throw error;
      }
      if (isNotFound(error)) {
        return; // idempotent
      }
      throw toDiskIoError(error);
    }

    const totalBefore = this.#maxBytes === undefined ? undefined : await this.#getTotal(root);
    try {
      await unlink(target);
    } catch (error) {
      if (isNotFound(error)) {
        return; // raced away; still a no-op
      }
      throw toDiskIoError(error);
    }
    if (totalBefore !== undefined) {
      this.#totalBytes = totalBefore - existingSize;
    }
  }

  async list(prefix?: string): Promise<readonly string[]> {
    assertDiskPrefix(prefix);
    const root = await this.#resolveRootReal();
    if (root === undefined) {
      return [];
    }

    let base: string;
    if (prefix === undefined || prefix === '') {
      base = root;
    } else {
      const candidate = join(root, prefix);
      await this.#assertNoSymlinkEscape(root, candidate);
      try {
        base = await this.#resolveContained(root, candidate);
      } catch (error) {
        if (error instanceof DiskError && error.code === 'not_found') {
          return [];
        }
        throw error;
      }
    }

    const keys: string[] = [];
    for await (const file of this.#walkFiles(base)) {
      keys.push(relative(root, file).split(sep).join('/'));
    }
    keys.sort();
    return keys;
  }

  async size(key: string): Promise<number> {
    assertDiskKey(key);
    const root = await this.#resolveRootReal();
    if (root === undefined) {
      throw notFound();
    }
    const { stats } = await this.#statRegularFile(root, key);
    return stats.size;
  }
}
