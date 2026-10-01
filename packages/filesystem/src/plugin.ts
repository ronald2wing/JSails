/**
 * First-party `filesystem` plugin: exposes a {@link FileSystem} over a map of
 * named {@link Disk}s under a typed service token.
 *
 * `filesystemPlugin({ disks, default? })` builds a {@link JsailsPlugin} named
 * `filesystem` whose `setup` registers the service under {@link filesystemToken}.
 * A consumer calls `disk(name)` to select a configured disk by name, `disk()`
 * with no argument to use the configured default (or the sole disk), and
 * `names()` to list the configured names. Names are validated eagerly at plugin
 * construction: non-empty, unique (a plain object keyed by name), each value a
 * `Disk`, and `default` one of them.
 *
 * Cleanup is a no-op: a disk holds no open handles (files are opened and closed
 * per operation), so `setup` returns no teardown and the runner's `close`
 * remains idempotent.
 */

import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import { filesystemToken, isDisk, type Disk } from 'jsails/filesystem';
import { JsailsError } from 'jsails/plugin-sdk';

/** Options accepted by {@link filesystemPlugin}. */
export interface FilesystemPluginOptions {
  /** The disks this plugin exposes, keyed by non-empty, unique names. */
  readonly disks: Readonly<Record<string, Disk>>;
  /** Name of the disk returned by `disk()` with no argument. */
  readonly default?: string;
}

/** Machine-readable reason for a {@link FileSystemError}. */
export type FileSystemErrorCode = 'unknown_disk' | 'missing_default';

/**
 * Raised when a `disk()` lookup cannot be satisfied: the name is not
 * configured, or no name was given and no default (or sole disk) exists.
 * Messages are value-free; the requested name is never echoed.
 */
export class FileSystemError extends JsailsError {
  constructor(
    readonly code: FileSystemErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Build the first-party `filesystem` plugin. Validation is eager and throws
 * `TypeError` for malformed options; the returned plugin is otherwise inert.
 */
export function filesystemPlugin(options: FilesystemPluginOptions): JsailsPlugin {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('filesystemPlugin requires an options object');
  }
  if (options.disks === null || typeof options.disks !== 'object' || Array.isArray(options.disks)) {
    throw new TypeError('disks must be a map of named disks');
  }
  const disks = options.disks;
  const names = Object.keys(disks);
  if (names.length === 0) {
    throw new TypeError('filesystemPlugin requires at least one disk');
  }
  for (const name of names) {
    if (name.trim() === '') {
      throw new TypeError('disk names must be non-empty strings');
    }
    if (!isDisk(disks[name])) {
      throw new TypeError('every disk must implement the Disk contract');
    }
  }
  if (options.default !== undefined) {
    if (typeof options.default !== 'string' || options.default.trim() === '') {
      throw new TypeError('default must be a configured disk name');
    }
    if (!(options.default in disks)) {
      throw new TypeError('default must name one of the configured disks');
    }
  }

  const defaultName = options.default ?? (names.length === 1 ? names[0] : undefined);
  const lookup = (name: string): Disk => {
    const disk = disks[name];
    if (disk === undefined) {
      throw new FileSystemError('unknown_disk', 'no disk is configured under that name');
    }
    return disk;
  };

  return definePlugin({
    name: 'filesystem',
    setup({ services }) {
      const disk = (name?: string): Disk => {
        if (name !== undefined) {
          return lookup(name);
        }
        if (defaultName === undefined) {
          throw new FileSystemError(
            'missing_default',
            'disk() requires a name when no default disk is configured',
          );
        }
        return lookup(defaultName);
      };

      services.provide(filesystemToken, {
        disk,
        names: () => [...names],
      });
    },
  });
}
