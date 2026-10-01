/**
 * The production server's file system, as a test model.
 *
 * Paths are what the engine sends: relative to the ssh user's home (an ssh
 * session's remote command starts there, `host-layout.ts`), or absolute. The
 * home has an absolute path too ({@link FakeFileSystem.home}, what `pwd -P`
 * prints there), and an absolute path below it names the same entry as the
 * relative one, as it does on a disk.
 * Directories are explicit, so a write into a missing directory fails the way
 * it would on a real disk; a rename replaces its destination atomically; and
 * every entry carries the mode and owner the operation that created it would
 * give it, so a test can assert who can read a secret.
 */

import { posix } from 'node:path';

/** One regular file. */
export interface FakeFile {
  readonly data: Buffer;
  readonly mode: number;
  readonly owner: string;
}

/** One directory. */
export interface FakeDirectory {
  readonly mode: number;
  readonly owner: string;
}

/** A comparable view of the whole tree: every directory and file with its mode and text. */
export interface FakeTreeSnapshot {
  readonly directories: Readonly<Record<string, number>>;
  readonly files: Readonly<Record<string, { readonly mode: number; readonly text: string }>>;
}

/**
 * The key of a path on a disk whose ssh user's home is `home`:
 * `posix.normalize` with `./` and trailing slashes dropped, and `home`
 * itself dropped from an absolute path below it, so `./.jamal/x/`,
 * `.jamal/x`, and `<home>/.jamal/x` are one entry. The home directory is the
 * empty key and `/` the root; both always exist.
 */
export function fakePathKey(path: string, home: string): string {
  const normalized = posix.normalize(path);
  if (normalized === '.' || normalized === './') return '';
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  if (trimmed === home) return '';
  if (trimmed.startsWith(`${home}/`)) return trimmed.slice(home.length + 1);
  return trimmed.startsWith('./') ? trimmed.slice(2) : trimmed;
}

/** A file system owned by one user, rooted at that user's home. */
export class FakeFileSystem {
  readonly #files = new Map<string, FakeFile>();
  readonly #directories = new Map<string, FakeDirectory>([
    ['', { mode: 0o755, owner: 'root' }],
    ['/', { mode: 0o755, owner: 'root' }],
  ]);

  constructor(
    /** The owner of every entry this model creates: the ssh user. */
    readonly user: string,
    /** The home's absolute path, with no symbolic link in it. */
    readonly home: string = `/home/${user}`,
  ) {}

  #key(path: string): string {
    return fakePathKey(path, this.home);
  }

  /** The key of `key`'s parent directory. */
  #parentKey(key: string): string {
    return this.#key(posix.dirname(key === '' ? '.' : key));
  }

  /** The file at `path`, if it is one. */
  file(path: string): FakeFile | undefined {
    return this.#files.get(this.#key(path));
  }

  /** The directory at `path`, if it is one. */
  directory(path: string): FakeDirectory | undefined {
    return this.#directories.get(this.#key(path));
  }

  /** Whether anything exists at `path`. */
  exists(path: string): boolean {
    const key = this.#key(path);
    return this.#files.has(key) || this.#directories.has(key);
  }

  /** Create `path` and its missing parents (`mkdir -p`); false when a file is in the way. */
  mkdirp(path: string, mode: number): boolean {
    const key = this.#key(path);
    if (this.#directories.has(key)) return true;
    if (this.#files.has(key)) return false;
    if (!this.mkdirp(this.#parentKey(key), mode)) return false;
    this.#directories.set(key, { mode, owner: this.user });
    return true;
  }

  /** Create one directory (`mkdir`); false when anything exists there or the parent is missing. */
  mkdir(path: string, mode: number): boolean {
    const key = this.#key(path);
    if (this.exists(key) || !this.#directories.has(this.#parentKey(key))) return false;
    this.#directories.set(key, { mode, owner: this.user });
    return true;
  }

  /**
   * Write `data` to `path`, creating the file with `mode` or keeping the mode
   * of the file it truncates (`>` redirection); false when the parent is missing
   * or a directory is in the way.
   */
  write(path: string, data: Buffer, mode: number): boolean {
    const key = this.#key(path);
    if (this.#directories.has(key) || !this.#directories.has(this.#parentKey(key))) return false;
    const existing = this.#files.get(key);
    this.#files.set(key, {
      data: Buffer.from(data),
      mode: existing?.mode ?? mode,
      owner: existing?.owner ?? this.user,
    });
    return true;
  }

  /** Set the mode of the file or directory at `path` (`chmod`); false when nothing is there. */
  chmod(path: string, mode: number): boolean {
    const key = this.#key(path);
    const file = this.#files.get(key);
    if (file !== undefined) {
      this.#files.set(key, { ...file, mode });
      return true;
    }
    const directory = this.#directories.get(key);
    if (directory === undefined) return false;
    this.#directories.set(key, { ...directory, mode });
    return true;
  }

  /** Move the file `from` over `to` in one step (`mv -f`); false when `from` is no file. */
  rename(from: string, to: string): boolean {
    const source = this.#key(from);
    const target = this.#key(to);
    const file = this.#files.get(source);
    if (file === undefined || this.#directories.has(target)) return false;
    if (!this.#directories.has(this.#parentKey(target))) return false;
    this.#files.delete(source);
    this.#files.set(target, file);
    return true;
  }

  /** Remove the file at `path` (`rm -f`); a missing file is not an error. */
  removeFile(path: string): void {
    this.#files.delete(this.#key(path));
  }

  /** Remove the empty directory at `path` (`rmdir`); false when missing or not empty. */
  removeDirectory(path: string): boolean {
    const key = this.#key(path);
    if (!this.#directories.has(key) || key === '' || key === '/') return false;
    const prefix = `${key}/`;
    const occupied = [...this.#files.keys(), ...this.#directories.keys()].some((entry) =>
      entry.startsWith(prefix),
    );
    if (occupied) return false;
    this.#directories.delete(key);
    return true;
  }

  /** The tree below `root` (default: everything) as plain data, for comparison. */
  snapshot(root = ''): FakeTreeSnapshot {
    const base = this.#key(root);
    const inside = (key: string): boolean =>
      base === '' ? key !== '' && key !== '/' : key.startsWith(`${base}/`);
    const relativeTo = (key: string): string => (base === '' ? key : key.slice(base.length + 1));
    const directories: Record<string, number> = {};
    for (const [key, entry] of [...this.#directories].sort(([a], [b]) => a.localeCompare(b))) {
      if (inside(key)) directories[relativeTo(key)] = entry.mode;
    }
    const files: Record<string, { mode: number; text: string }> = {};
    for (const [key, entry] of [...this.#files].sort(([a], [b]) => a.localeCompare(b))) {
      if (inside(key)) files[relativeTo(key)] = { mode: entry.mode, text: entry.data.toString() };
    }
    return { directories, files };
  }
}
