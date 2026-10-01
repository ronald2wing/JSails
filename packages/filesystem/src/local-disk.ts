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
 * - **Exact quota.** With `maxBytes`, every write and delete runs its check,
 *   I/O, and counter update as one serialized step, applying a delta to the
 *   live total, so concurrent uploads can neither both pass the check nor
 *   overwrite each other's accounting. `putStream` reads its source into the
 *   temp file before taking that step, so a slow upload never holds up other
 *   writes; only the final check and rename are serialized. The first total is summed once (shared
 *   by concurrent first callers, and started at construction with
 *   `createRoot`), and crash-leftover temp files are neither listed nor
 *   counted. The temp-file name pattern is therefore reserved for keys.
 * - **Streaming and ranges.** `stream` reads a file or a byte range without
 *   buffering it, and `putStream` writes from a stream through the same temp
 *   file and rename, enforcing a byte cap as the bytes arrive.
 *
 * All I/O failures surface as value-free {@link DiskError}s (never echoing a
 * path or the data); option mistakes surface as `TypeError` at construction.
 */

import { createReadStream, createWriteStream, mkdirSync, type Stats } from 'node:fs';
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { isErrno } from 'jsails/plugin-sdk';
import { Encoding } from 'jsails/support';
import { DiskError, type DiskData, type DiskPutOptions } from 'jsails/filesystem';
import {
  assertContentType,
  assertDiskKey,
  assertDiskPrefix,
  toDiskBytes,
  toDiskIoError,
  validateMaxBytes,
} from './disk-validation.js';
import {
  chunksOf,
  resolveRange,
  type DiskPutStreamOptions,
  type DiskReadStream,
  type DiskStreamOptions,
  type StreamingDisk,
} from './streaming.js';

/**
 * The name `put` gives its temp file. A crash between write and rename leaves
 * one behind; `list` and the quota total skip anything with this shape, and
 * `put` refuses a key whose last segment has it.
 */
const TEMP_FILE = /^\.[0-9a-f]{12}\.tmp$/;

function tempName(): string {
  return `.${Encoding.hex(Encoding.randomBytes(6))}.tmp`;
}

function assertNotTempKey(key: string): void {
  if (TEMP_FILE.test(basename(key))) {
    throw new DiskError('invalid_key', 'disk keys must not use the reserved temp-file name');
  }
}

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
export class LocalDisk implements StreamingDisk {
  readonly #rootPath: string;
  readonly #maxBytes: number | undefined;
  #rootRealCache: string | undefined;
  /** The summed total, memoized as a promise so concurrent first callers share one walk. */
  #total: Promise<number> | undefined;
  /** Serializes quota-bearing writes and deletes (see the module comment). */
  #quotaChain: Promise<void> = Promise.resolve();

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
      if (this.#maxBytes !== undefined) {
        // Warm the total now rather than inside the first upload's request. A
        // failure is not surfaced here: the first write retries the walk.
        void this.#ensureRoot()
          .then((root) => this.#getTotal(root))
          .catch(() => {});
      }
    }
  }

  /**
   * Run `step` alone when a quota is enforced. Without a quota there is no
   * shared counter to protect, so writes stay concurrent.
   */
  #withQuota<T>(step: () => Promise<T>): Promise<T> {
    if (this.#maxBytes === undefined) {
      return step();
    }
    const run = this.#quotaChain.then(step);
    this.#quotaChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
      if (entry.isFile() && TEMP_FILE.test(entry.name)) {
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
    this.#total ??= this.#sumTotal(root).catch((error: unknown) => {
      this.#total = undefined;
      throw error;
    });
    return this.#total;
  }

  async #sumTotal(root: string): Promise<number> {
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
    return total;
  }

  /** Apply a size change to the live total. Only called inside {@link #withQuota}. */
  #adjustTotal(delta: number): void {
    if (this.#total !== undefined) {
      this.#total = this.#total.then((total) => total + delta);
    }
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
    assertNotTempKey(key);
    assertContentType(options?.contentType);
    const bytes = toDiskBytes(data);
    await this.#withQuota(async () => {
      const { root, target, existingSize } = await this.#prepareWrite(key);
      await this.#assertCapacity(root, existingSize, bytes.length);
      const temp = join(dirname(target), tempName());
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(temp, bytes);
        await rename(temp, target);
      } catch (error) {
        await this.#unlinkQuietly(temp);
        throw toDiskIoError(error);
      }
      this.#adjustTotal(bytes.length - existingSize);
    });
  }

  async putStream(
    key: string,
    source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options?: DiskPutStreamOptions,
  ): Promise<number> {
    assertDiskKey(key);
    assertNotTempKey(key);
    assertContentType(options?.contentType);
    const cap = validateMaxBytes(options?.maxBytes);
    // The bytes are streamed into the temp file outside the quota lock: the
    // source is caller-supplied and may be slow or never end, and holding the
    // lock while reading it would stall every other write and delete on the
    // disk. The room checked here is only a pre-check that bounds how much is
    // read; the binding check runs under the lock, against the live total,
    // just before the rename.
    const { root, target, existingSize } = await this.#prepareWrite(key);
    const room =
      this.#maxBytes === undefined
        ? Number.POSITIVE_INFINITY
        : this.#maxBytes - (await this.#getTotal(root)) + existingSize;
    const limit = Math.min(cap ?? Number.POSITIVE_INFINITY, room);
    const temp = join(dirname(target), tempName());
    let written: number;
    try {
      await mkdir(dirname(target), { recursive: true });
      written = await this.#streamToTemp(temp, source, limit);
    } catch (error) {
      await this.#unlinkQuietly(temp);
      if (error instanceof DiskError) {
        throw error;
      }
      throw toDiskIoError(error);
    }
    return this.#withQuota(async () => {
      try {
        // Re-resolve: the target may have been replaced or removed while the
        // bytes were arriving, and its size is what the rename gives back.
        const current = await this.#prepareWrite(key);
        await this.#assertCapacity(current.root, current.existingSize, written);
        await rename(temp, current.target);
        this.#adjustTotal(written - current.existingSize);
        return written;
      } catch (error) {
        await this.#unlinkQuietly(temp);
        if (error instanceof DiskError) {
          throw error;
        }
        throw toDiskIoError(error);
      }
    });
  }

  /** Write `source` to a fresh `temp` file, refusing with `too_large` past `limit`. */
  async #streamToTemp(
    temp: string,
    source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    limit: number,
  ): Promise<number> {
    let written = 0;
    const sink = createWriteStream(temp, { flags: 'wx' });
    try {
      for await (const chunk of chunksOf(source)) {
        written += chunk.byteLength;
        if (written > limit) {
          throw new DiskError('too_large', 'disk capacity exceeded');
        }
        if (!sink.write(chunk)) {
          await new Promise<void>((resolve) => sink.once('drain', resolve));
        }
      }
      sink.end();
      await finished(sink);
    } catch (error) {
      // Wait for the handle to close, or the temp file could be created after
      // the caller's cleanup has already looked for it.
      sink.destroy();
      await finished(sink).catch(() => undefined);
      throw error;
    }
    return written;
  }

  /**
   * Resolve a write target, refuse a symlink escape or a directory in its
   * place, and report the size of the file it replaces.
   */
  async #prepareWrite(
    key: string,
  ): Promise<{ root: string; target: string; existingSize: number }> {
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
    return { root, target, existingSize };
  }

  async #assertCapacity(root: string, existingSize: number, incoming: number): Promise<void> {
    if (this.#maxBytes === undefined) {
      return;
    }
    const total = await this.#getTotal(root);
    if (total - existingSize + incoming > this.#maxBytes) {
      throw new DiskError('too_large', 'disk capacity exceeded');
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
      const buffer = await readFile(path);
      // A view over the Buffer's memory, not a copy of it.
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      if (isNotFound(error)) {
        throw notFound();
      }
      throw toDiskIoError(error);
    }
  }

  async stream(key: string, options?: DiskStreamOptions): Promise<DiskReadStream> {
    assertDiskKey(key);
    const root = await this.#resolveRootReal();
    if (root === undefined) {
      throw notFound();
    }
    const { path, stats } = await this.#statRegularFile(root, key);
    const { start, end } = resolveRange(options?.range, stats.size);
    if (end < start) {
      return { stream: new Blob([]).stream(), size: stats.size, start, end };
    }
    const nodeStream = createReadStream(path, { start, end });
    return {
      stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      size: stats.size,
      start,
      end,
    };
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
    await this.#withQuota(async () => {
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

      if (this.#maxBytes !== undefined) {
        // Sum first, so the delta lands on a total that still counted the file.
        await this.#getTotal(root);
      }
      try {
        await unlink(target);
      } catch (error) {
        if (isNotFound(error)) {
          return; // raced away; still a no-op
        }
        throw toDiskIoError(error);
      }
      this.#adjustTotal(-existingSize);
    });
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
