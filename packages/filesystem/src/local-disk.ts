/**
 * Local filesystem disk: a {@link Disk} backed by a directory.
 *
 * `new LocalDisk({ root, maxBytes?, createRoot?, staleTempMs? })` stores each
 * key as a file under `root`. It is built for safety first:
 *
 * - **Key safety.** Keys follow the shared disk rules, so a key can never
 *   lexically escape `root`. On Windows a key is also refused when a segment
 *   holds a character NTFS reserves (`<>:"|?*`, where `:` would open an
 *   alternate data stream), ends in a dot or space, or names a device (`CON`,
 *   `NUL`, `COM1`, `CONIN$`, ...).
 * - **Symlink safety.** `root` and every existing ancestor of a target are
 *   resolved through `realpath`; a symlink that resolves outside the root
 *   (including a dangling one) fails closed with `disk.invalid_key`. A read
 *   opens the file it checked (see `#openRegularFile`). `list` never follows
 *   symlinks.
 * - **Atomic, durable writes.** Bytes stream through the shared meter (byte
 *   limit, SHA-256, abort) into a temp file in the target's directory, opened
 *   exclusively and flushed to storage before it closes; the temp file is then
 *   renamed over the target, or, for `ifAbsent`, hard-linked to it (`EEXIST`
 *   is the conflict, so two racing writers cannot both win) and unlinked. On
 *   POSIX the directory is then fsynced so the rename survives a crash. Any
 *   failure removes the temp file, so a failed write leaves the previous
 *   content and nothing else.
 * - **Windows.** Directory fsync does not exist there and is skipped; a rename
 *   refused with `EPERM`/`EBUSY`/`EACCES` (a scanner or indexer holding the
 *   file) is retried a few times with a short backoff.
 * - **Startup sweep.** The first write scans the root once: temp files older
 *   than `staleTempMs` (a crash between write and rename) are removed, and,
 *   with a quota, the stored total is summed in the same walk.
 * - **Exact quota.** With `maxBytes`, the bytes are streamed outside any lock
 *   (a slow upload never holds up other writes) against the room left at the
 *   start, and the binding check, the rename and the counter update run as
 *   one serialized step against the live total.
 * - **Directories are not objects.** `stat` answers `null` for a directory,
 *   `delete` and `deletePrefix` prune directories they leave empty, and a key
 *   that names a directory of other keys (or runs through a stored file) is
 *   refused with `disk.key_collision`.
 * - **No content type.** A directory has nowhere to keep one, so `stat` and
 *   `read` report none.
 *
 * It has no signed URLs: a directory has no origin to hand a client, so its
 * files are served through an app route.
 */

import { constants, mkdirSync, type Dirent, type Stats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { isErrno } from 'jsails/errors';
import {
  assertDiskKey,
  assertDiskPrefix,
  DiskErrors,
  isDiskKey,
  meterByteSource,
  resolveDiskRange,
  throwIfDiskAborted,
  type ByteSource,
  type Disk,
  type DiskListOptions,
  type DiskListPage,
  type DiskObject,
  type DiskReadOptions,
  type DiskStat,
  type DiskWriteOptions,
  type DiskWriteResult,
} from 'jsails/filesystem';
import { Encoding } from 'jsails/support';

import {
  assertListOptions,
  assertReadSignal,
  assertWriteOptions,
  diskIoError,
  isOptionsObject,
  positiveIntegerOption,
  quotaOption,
} from './disk-validation.js';
import { compareKeys, decodeCursor, encodeCursor } from './list-order.js';

/**
 * The name of a write's temp file. Keys whose segments have this shape are
 * refused, and `list`, the quota total and the sweep treat such files as
 * temp files rather than objects.
 */
const TEMP_FILE = /^\.[0-9a-f]{12}\.tmp$/;

const IS_WINDOWS = process.platform === 'win32';
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

const DEFAULT_STALE_TEMP_MS = 60 * 60 * 1000;
/** Delays between rename attempts on Windows, in ms. */
const RENAME_RETRY_DELAYS = [10, 20, 40, 80, 160];

function tempName(): string {
  return `.${Encoding.hex(Encoding.randomBytes(6))}.tmp`;
}

/** True when `segment` is a key segment this disk can store on the current platform. */
function isStorableSegment(segment: string): boolean {
  if (TEMP_FILE.test(segment)) return false;
  if (!IS_WINDOWS) return true;
  return (
    !WINDOWS_FORBIDDEN.test(segment) &&
    !segment.endsWith('.') &&
    !segment.endsWith(' ') &&
    !WINDOWS_DEVICE.test(segment)
  );
}

function assertLocalKey(key: unknown): asserts key is string {
  assertDiskKey(key);
  if (!key.split('/').every(isStorableSegment)) throw new DiskErrors.Error('invalid_key');
}

/**
 * Options for {@link LocalDisk}.
 *
 * @public
 */
export interface LocalDiskOptions {
  /** The directory that holds the stored files. */
  readonly root: string;
  /** A cap on the total stored bytes; a write that would pass it fails with `disk.too_large`. */
  readonly maxBytes?: number;
  /** Create `root` at construction; by default it is created by the first write. */
  readonly createRoot?: boolean;
  /** How old a leftover temp file must be for the startup sweep to remove it. Defaults to one hour. */
  readonly staleTempMs?: number;
}

/** True for the errors that mean "nothing there". */
function isMissing(error: unknown): boolean {
  return isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR');
}

/**
 * True when `candidate` is `root` or lies inside it. Segment-aware
 * (`root-other` is outside `root`), and a relative path that comes back
 * absolute (another Windows drive) is outside.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function notFound(): Error {
  return new DiskErrors.Error('not_found');
}

/** Remove a file, ignoring every failure: used only where an earlier error, or success, already decided the outcome. */
async function unlinkQuietly(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // A leftover temp file is harmless (the sweep removes it), and the
    // operation's own result is what the caller must see.
  }
}

/** Rename, retrying the transient refusals Windows gives while another process holds the file. */
async function renameDurably(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const delay = RENAME_RETRY_DELAYS[attempt];
      const transient =
        IS_WINDOWS &&
        (isErrno(error, 'EPERM') || isErrno(error, 'EBUSY') || isErrno(error, 'EACCES'));
      if (!transient || delay === undefined) throw error;
      await sleep(delay);
    }
  }
}

/**
 * Flush a directory entry change (a rename or link) to storage. Windows has no
 * directory handle to sync; a filesystem that cannot sync directories reports
 * `EINVAL`/`ENOTSUP`, and the entry is then as durable as that filesystem makes it.
 */
async function syncDirectory(dir: string): Promise<void> {
  if (IS_WINDOWS) return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(dir, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!isErrno(error, 'EINVAL') && !isErrno(error, 'ENOTSUP')) {
      throw diskIoError('write', error);
    }
  } finally {
    await handle?.close();
  }
}

/**
 * A disk backed by a directory. Construction validates options and, with
 * `createRoot`, creates the root; it reads nothing else.
 *
 * @public
 */
export class LocalDisk implements Disk {
  readonly #rootPath: string;
  readonly #quota: number | undefined;
  readonly #staleTempMs: number;
  #rootReal: string | undefined;
  /** The first write's root preparation (create, sweep, sum), shared by concurrent callers. */
  #ready: Promise<string> | undefined;
  /** The stored total, present once summed when a quota is enforced. */
  #total: Promise<number> | undefined;
  /** Serializes quota-bearing commits and deletes. */
  #quotaChain: Promise<void> = Promise.resolve();

  constructor(options: LocalDiskOptions) {
    if (!isOptionsObject(options))
      throw new DiskErrors.Error('invalid_option', { option: 'options' });
    if (typeof options.root !== 'string' || options.root.trim() === '') {
      throw new DiskErrors.Error('invalid_option', { option: 'root' });
    }
    this.#quota = quotaOption(options.maxBytes);
    this.#staleTempMs = positiveIntegerOption(
      options.staleTempMs,
      'staleTempMs',
      DEFAULT_STALE_TEMP_MS,
    );
    this.#rootPath = resolve(options.root);
    if (options.createRoot === true) {
      try {
        mkdirSync(this.#rootPath, { recursive: true });
      } catch (error) {
        throw diskIoError('write', error);
      }
    }
  }

  /** Run `step` alone when a quota is enforced; without one there is no shared counter to protect. */
  #withQuota<T>(step: () => Promise<T>): Promise<T> {
    if (this.#quota === undefined) return step();
    const run = this.#quotaChain.then(step);
    this.#quotaChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** The real root without creating it, or `undefined` while it does not exist. */
  async #resolveRootReal(): Promise<string | undefined> {
    if (this.#rootReal !== undefined) return this.#rootReal;
    try {
      this.#rootReal = await realpath(this.#rootPath);
      return this.#rootReal;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw diskIoError('open', error);
    }
  }

  /** Create the root, sweep stale temp files and, with a quota, sum the total; once. */
  #ensureRoot(): Promise<string> {
    this.#ready ??= this.#prepareRoot().catch((error: unknown) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  async #prepareRoot(): Promise<string> {
    let root: string;
    try {
      await mkdir(this.#rootPath, { recursive: true });
      root = await realpath(this.#rootPath);
    } catch (error) {
      throw diskIoError('open', error);
    }
    this.#rootReal = root;
    const total = await this.#scan(root, Date.now() - this.#staleTempMs);
    if (this.#quota !== undefined) this.#total = Promise.resolve(total);
    return root;
  }

  /**
   * Walk the tree under `dir` without following symlinks: remove temp files
   * last modified before `staleBefore`, and return the bytes of the stored files.
   */
  async #scan(dir: string, staleBefore: number): Promise<number> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return 0;
      throw diskIoError('open', error);
    }
    let total = 0;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += await this.#scan(path, staleBefore);
        continue;
      }
      if (!entry.isFile()) continue;
      let stats: Stats;
      try {
        stats = await lstat(path);
      } catch (error) {
        if (isMissing(error)) continue; // removed while the walk ran
        throw diskIoError('open', error);
      }
      if (!TEMP_FILE.test(entry.name)) {
        total += stats.size;
      } else if (stats.mtimeMs < staleBefore) {
        await unlinkQuietly(path);
      }
    }
    return total;
  }

  /** The live stored total. Only called when a quota is enforced, which the root preparation sums. */
  async #currentTotal(): Promise<number> {
    await this.#ensureRoot();
    return (await this.#total) ?? 0;
  }

  /** Apply a size change to the live total. Only called inside {@link #withQuota}. */
  #adjustTotal(delta: number): void {
    if (this.#total !== undefined) this.#total = this.#total.then((total) => total + delta);
  }

  /** The platform path of `key` under `root`. */
  #pathOf(root: string, key: string): string {
    return join(root, ...key.split('/'));
  }

  /** Resolve `target` and require the result inside the root; a missing target is `not_found`. */
  async #resolveContained(root: string, target: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await realpath(target);
    } catch (error) {
      if (isMissing(error)) throw notFound();
      throw diskIoError('open', error);
    }
    if (!isInsideRoot(root, resolved)) throw new DiskErrors.Error('invalid_key');
    return resolved;
  }

  /**
   * Refuse any existing ancestor of `target` that is a symlink resolving
   * outside the root. The final segment is each operation's own concern.
   */
  async #assertNoSymlinkEscape(root: string, target: string): Promise<void> {
    if (!isInsideRoot(root, target)) throw new DiskErrors.Error('invalid_key');
    const rel = relative(root, target);
    if (rel === '') return;
    let current = root;
    for (const segment of rel.split(sep).slice(0, -1)) {
      current = join(current, segment);
      let stats: Stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if (isMissing(error)) return; // nothing deeper exists
        throw diskIoError('open', error);
      }
      if (stats.isSymbolicLink()) {
        try {
          await this.#resolveContained(root, current);
        } catch (error) {
          if (DiskErrors.is(error, 'not_found')) return; // dangling: nothing below it exists
          throw error;
        }
      } else if (!stats.isDirectory()) {
        return; // a file where a directory would be: nothing below it exists
      }
    }
  }

  /** Resolve a key to its contained real path and stat it; `null` unless it is a regular file. */
  async #statRegularFile(
    root: string,
    key: string,
  ): Promise<{ path: string; stats: Stats } | null> {
    const target = this.#pathOf(root, key);
    await this.#assertNoSymlinkEscape(root, target);
    let path: string;
    try {
      path = await this.#resolveContained(root, target);
    } catch (error) {
      if (DiskErrors.is(error, 'not_found')) return null;
      throw error;
    }
    let stats: Stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw diskIoError('stat', error);
    }
    return stats.isFile() ? { path, stats } : null;
  }

  /**
   * Open the regular file at `key` as the very file the containment check
   * approved. Reading the checked path afterwards would follow whatever sits
   * there by then, so the descriptor is opened with `O_NOFOLLOW` (where the
   * platform has it) and its device and inode must equal the checked file's;
   * any swap reads as not found. Node has no `openat`, so a directory swapped
   * above the file between the check and the snapshot is outside this guarantee.
   */
  async #openRegularFile(root: string, key: string): Promise<{ handle: FileHandle; stats: Stats }> {
    const checked = await this.#statRegularFile(root, key);
    if (checked === null) throw notFound();
    let handle: FileHandle;
    try {
      handle = await open(checked.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (isMissing(error) || isErrno(error, 'ELOOP')) throw notFound();
      throw diskIoError('read', error);
    }
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== checked.stats.dev ||
        opened.ino !== checked.stats.ino
      ) {
        throw notFound();
      }
      return { handle, stats: opened };
    } catch (error) {
      await handle.close();
      throw diskIoError('read', error);
    }
  }

  /**
   * Resolve a write target: refuse a symlink escape, and a directory in the
   * target's place; report the size of the file it would replace and whether
   * anything (a file or a link) is there.
   */
  async #inspectTarget(
    root: string,
    target: string,
  ): Promise<{ existingSize: number; occupied: boolean }> {
    await this.#assertNoSymlinkEscape(root, target);
    let stats: Stats;
    try {
      stats = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return { existingSize: 0, occupied: false };
      throw diskIoError('write', error);
    }
    if (stats.isDirectory()) throw new DiskErrors.Error('key_collision');
    if (stats.isSymbolicLink()) {
      // A rename replaces the link without writing through it, but a link
      // pointing outside the root is refused regardless; a dangling one is
      // simply replaced.
      try {
        await this.#resolveContained(root, target);
      } catch (error) {
        if (!DiskErrors.is(error, 'not_found')) throw error;
      }
      return { existingSize: 0, occupied: true };
    }
    return { existingSize: stats.size, occupied: true };
  }

  /**
   * Create the target's directory and open a fresh temp file in it. The
   * directory can be pruned by a concurrent delete between the two steps, so
   * a vanished directory is created once more.
   */
  async #openTemp(target: string, temp: string): Promise<FileHandle> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await mkdir(dirname(target), { recursive: true });
      } catch (error) {
        // A stored file where a directory of the key would go.
        if (isErrno(error, 'EEXIST') || isErrno(error, 'ENOTDIR')) {
          throw new DiskErrors.Error('key_collision');
        }
        throw diskIoError('write', error);
      }
      try {
        return await open(temp, 'wx');
      } catch (error) {
        if (isErrno(error, 'ENOENT') && attempt === 0) continue;
        throw diskIoError('write', error);
      }
    }
  }

  async write(
    key: string,
    source: ByteSource,
    options: DiskWriteOptions,
  ): Promise<DiskWriteResult> {
    assertLocalKey(key);
    assertWriteOptions(options);
    throwIfDiskAborted(options.signal, 'write');
    const root = await this.#ensureRoot();
    const target = this.#pathOf(root, key);
    const { existingSize, occupied } = await this.#inspectTarget(root, target);
    if (options.ifAbsent === true && occupied) throw new DiskErrors.Error('conflict');
    // The room checked here only bounds how much is read; the binding check
    // runs at commit, against the live total.
    const room =
      this.#quota === undefined
        ? options.maxBytes
        : Math.min(options.maxBytes, this.#quota - (await this.#currentTotal()) + existingSize);
    const metered = meterByteSource(source, {
      maxBytes: Math.max(room, 0),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const temp = join(dirname(target), tempName());
    const handle = await this.#openTemp(target, temp);
    const sink = handle.createWriteStream({ flush: true });
    // The handle must be closed (and, with `flush`, synced) before the temp
    // file is renamed or removed: Windows refuses both on an open file.
    const closed = new Promise((settle) => sink.once('close', settle));
    try {
      await pipeline(metered.chunks, sink);
      if (!sink.closed) await closed;
    } catch (error) {
      if (!sink.closed) await closed;
      await unlinkQuietly(temp);
      throw diskIoError('write', error);
    }
    const result = metered.result();

    await this.#withQuota(async () => {
      try {
        throwIfDiskAborted(options.signal, 'write');
        const current = await this.#inspectTarget(root, target);
        if (this.#quota !== undefined) {
          const total = await this.#currentTotal();
          if (total - current.existingSize + result.size > this.#quota) {
            throw new DiskErrors.Error('too_large');
          }
        }
        if (options.ifAbsent === true) {
          if (current.occupied) throw new DiskErrors.Error('conflict');
          await this.#linkAbsent(temp, target);
          this.#adjustTotal(result.size);
        } else {
          await renameDurably(temp, target);
          this.#adjustTotal(result.size - current.existingSize);
        }
      } catch (error) {
        await unlinkQuietly(temp);
        throw diskIoError('write', error);
      }
    });
    await syncDirectory(dirname(target));
    return result;
  }

  /**
   * Publish `temp` at `target` only if nothing is there: the link fails with
   * `EEXIST` when a racing writer got there first. The temp name is removed
   * afterwards either way.
   */
  async #linkAbsent(temp: string, target: string): Promise<void> {
    try {
      await link(temp, target);
    } catch (error) {
      if (isErrno(error, 'EEXIST')) throw new DiskErrors.Error('conflict');
      // A filesystem without hard links (FAT, some network shares).
      if (isErrno(error, 'EPERM') || isErrno(error, 'ENOTSUP') || isErrno(error, 'EOPNOTSUPP')) {
        throw new DiskErrors.Error('unsupported', { operation: 'write' }, { cause: error });
      }
      throw error;
    }
    await unlinkQuietly(temp);
  }

  async read(key: string, options: DiskReadOptions = {}): Promise<DiskObject> {
    assertLocalKey(key);
    assertReadSignal(options.signal);
    throwIfDiskAborted(options.signal, 'read');
    const root = await this.#resolveRootReal();
    if (root === undefined) throw notFound();
    const { handle, stats } = await this.#openRegularFile(root, key);
    let range: { start: number; end: number };
    try {
      range = resolveDiskRange(options.range, stats.size);
    } catch (error) {
      await handle.close();
      throw error;
    }
    const { start, end } = range;
    if (end < start) {
      await handle.close();
      return { stream: new Blob([]).stream(), size: stats.size, start, end };
    }
    // The stream closes the handle when it ends, fails, or is cancelled.
    const nodeStream = handle.createReadStream({
      start,
      end,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      size: stats.size,
      start,
      end,
    };
  }

  async stat(key: string): Promise<DiskStat | null> {
    assertLocalKey(key);
    const root = await this.#resolveRootReal();
    if (root === undefined) return null;
    const checked = await this.#statRegularFile(root, key);
    if (checked === null) return null;
    return { size: checked.stats.size, modifiedAt: checked.stats.mtime };
  }

  async delete(key: string): Promise<void> {
    assertLocalKey(key);
    const root = await this.#resolveRootReal();
    if (root === undefined) return;
    await this.#withQuota(() => this.#deleteFile(root, this.#pathOf(root, key)));
    await this.#pruneEmptyParents(root, dirname(this.#pathOf(root, key)));
  }

  /** Unlink the file or link at `target` and update the total. Only called inside {@link #withQuota}. */
  async #deleteFile(root: string, target: string): Promise<void> {
    await this.#assertNoSymlinkEscape(root, target);
    let stats: Stats;
    try {
      stats = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return;
      throw diskIoError('delete', error);
    }
    if (stats.isDirectory()) return; // no object is stored under a directory's key
    // Sum first, so the delta lands on a total that still counted the file.
    if (this.#quota !== undefined) await this.#currentTotal();
    try {
      await unlink(target);
    } catch (error) {
      if (isMissing(error)) return;
      throw diskIoError('delete', error);
    }
    this.#adjustTotal(stats.isFile() ? -stats.size : 0);
  }

  /** Remove the now-empty directories from `dir` up to (not including) the root. */
  async #pruneEmptyParents(root: string, dir: string): Promise<void> {
    for (
      let current = dir;
      current !== root && isInsideRoot(root, current);
      current = dirname(current)
    ) {
      try {
        await rmdir(current);
      } catch {
        // Not empty (another key, or an in-flight write's temp file), already
        // gone, or not a directory: pruning stops, and nothing is lost.
        return;
      }
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    assertLocalKey(prefix);
    const root = await this.#resolveRootReal();
    if (root === undefined) return;
    const base = await this.#listBase(root, prefix);
    if (base === undefined) return;
    for await (const key of this.#sortedKeys(base, prefix, undefined)) {
      await this.#withQuota(() => this.#deleteFile(root, this.#pathOf(root, key)));
    }
    await this.#pruneEmptyTree(base);
    await this.#pruneEmptyParents(root, dirname(this.#pathOf(root, prefix)));
  }

  /** Remove every empty directory under and including `dir`, without following symlinks. */
  async #pruneEmptyTree(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // gone, or not a directory: nothing to prune
    }
    for (const entry of entries) {
      if (entry.isDirectory()) await this.#pruneEmptyTree(join(dir, entry.name));
    }
    try {
      await rmdir(dir);
    } catch {
      // Still holds a file (an in-flight write's temp file, a symlink):
      // the directory stays, and no stored key is affected.
    }
  }

  /** The real directory a listing under `prefix` reads, or `undefined` when there is none. */
  async #listBase(root: string, prefix: string): Promise<string | undefined> {
    if (prefix === '') return root;
    const candidate = this.#pathOf(root, prefix);
    await this.#assertNoSymlinkEscape(root, candidate);
    try {
      return await this.#resolveContained(root, candidate);
    } catch (error) {
      if (DiskErrors.is(error, 'not_found')) return undefined;
      throw error;
    }
  }

  /**
   * Yield the keys stored under `dir` (whose key is `keyPrefix`) in UTF-8 byte
   * order, strictly after `after`, never following symlinks. Siblings are
   * ordered with a directory's name read as `name/`, which is where its keys
   * fall among the files beside it, and a subtree that lies wholly before
   * `after` is skipped without being read.
   */
  async *#sortedKeys(
    dir: string,
    keyPrefix: string,
    after: string | undefined,
  ): AsyncGenerator<string> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw diskIoError('list', error);
    }
    const children = entries
      .filter((entry) => entry.isDirectory() || (entry.isFile() && !TEMP_FILE.test(entry.name)))
      .map((entry) => ({
        key: keyPrefix === '' ? entry.name : `${keyPrefix}/${entry.name}`,
        directory: entry.isDirectory(),
        name: entry.name,
      }))
      .filter((child) => isDiskKey(child.key))
      .sort((a, b) =>
        compareKeys(a.directory ? `${a.key}/` : a.key, b.directory ? `${b.key}/` : b.key),
      );
    for (const child of children) {
      if (!child.directory) {
        if (after === undefined || compareKeys(child.key, after) > 0) yield child.key;
        continue;
      }
      const scope = `${child.key}/`;
      if (after !== undefined && compareKeys(scope, after) < 0 && !after.startsWith(scope)) {
        continue;
      }
      yield* this.#sortedKeys(join(dir, child.name), child.key, after);
    }
  }

  async list(prefix: string, options: DiskListOptions): Promise<DiskListPage> {
    assertDiskPrefix(prefix);
    assertListOptions(options);
    const after = decodeCursor(options.cursor);
    const root = await this.#resolveRootReal();
    if (root === undefined) return { keys: [] };
    const base = await this.#listBase(root, prefix);
    if (base === undefined) return { keys: [] };
    const keys: string[] = [];
    let more = false;
    for await (const key of this.#sortedKeys(base, prefix, after)) {
      if (keys.length === options.limit) {
        more = true;
        break;
      }
      keys.push(key);
    }
    const last = keys.at(-1);
    return more && last !== undefined ? { keys, cursor: encodeCursor(last) } : { keys };
  }
}
