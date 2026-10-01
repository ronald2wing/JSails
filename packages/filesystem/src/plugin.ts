/**
 * First-party `filesystem` plugin: a {@link FileSystem} over a map of named
 * {@link Disk}s, provided under `filesystemToken`.
 *
 * `filesystemPlugin({ disks, default? })` configures a plugin named
 * `filesystem` on the `definePlugin` contract. Its options are data, checked
 * by a strict schema when the factory is called (a failure is
 * `config.invalid_options`, before anything runs). Each disk is described,
 * never passed in:
 *
 * - `{ driver: 'local', root, maxBytes? }` stores files under `root`, which a
 *   relative path resolves against the application root;
 * - `{ driver: 'memory', maxBytes? }` keeps them in process memory;
 * - `{ driver: 'env' }` is the disk the deployment selects through
 *   `FILESYSTEM_DISK` (`local`, `s3` or `memory`) and the `FILESYSTEM_*` and
 *   `S3_*` variables, which the plugin declares, so secrets stay in the
 *   environment. A blank `FILESYSTEM_DISK` or a malformed variable fails
 *   (`config.invalid_env`) before any setup; an unknown selector or an
 *   incomplete S3 configuration fails the plugin's setup
 *   (`filesystem.invalid_environment`).
 *
 * A consumer calls `disk(name)` for a named disk, `disk()` for the default
 * (or the sole disk), and `names()` for the configured names. Setup builds
 * the disks, none of which opens a handle or touches storage until used, and
 * returns no cleanup.
 */

import { resolve } from 'node:path';

import { filesystemToken, type Disk } from 'jsails/filesystem';
import { definePlugin, envVar, type PluginFactory } from 'jsails/kernel';
import { z } from 'jsails/zod';

import { createDiskFromEnv } from './disk-from-env.js';
import { FilesystemErrors } from './filesystem-errors.js';
import { LocalDisk } from './local-disk.js';
import { MemoryDisk } from './memory-disk.js';

/**
 * How one disk of the `filesystem` plugin is built.
 *
 * @public
 */
export type DiskSpec =
  | { readonly driver: 'local'; readonly root: string; readonly maxBytes?: number }
  | { readonly driver: 'memory'; readonly maxBytes?: number }
  | { readonly driver: 'env' };

/**
 * Options accepted by {@link filesystemPlugin}.
 *
 * @public
 */
export interface FilesystemPluginOptions {
  /** The disks this plugin exposes, keyed by name. */
  readonly disks: Readonly<Record<string, DiskSpec>>;
  /** Name of the disk returned by `disk()` with no argument. */
  readonly default?: string;
}

const diskName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, { message: 'must be a disk name' });

const byteBudget = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const diskSpec: z.ZodType<DiskSpec> = z.discriminatedUnion('driver', [
  z
    .object({
      driver: z.literal('local'),
      root: z.string().min(1),
      maxBytes: byteBudget.optional(),
    })
    .strict(),
  z.object({ driver: z.literal('memory'), maxBytes: byteBudget.optional() }).strict(),
  z.object({ driver: z.literal('env') }).strict(),
]);

const filesystemOptions: z.ZodType<FilesystemPluginOptions> = z
  .object({
    disks: z
      .record(diskName, diskSpec)
      .refine((disks) => Object.keys(disks).length > 0, { message: 'needs at least one disk' }),
    default: diskName.optional(),
  })
  .strict()
  .refine(
    (options) => options.default === undefined || Object.hasOwn(options.disks, options.default),
    {
      message: 'the default must name a configured disk',
      path: ['default'],
    },
  );

/**
 * The first-party `filesystem` plugin. Nothing is built until its setup runs,
 * which provides the {@link FileSystem} under `filesystemToken`.
 *
 * @public
 */
export const filesystemPlugin: PluginFactory<FilesystemPluginOptions> = definePlugin({
  name: 'filesystem',
  options: filesystemOptions,
  env: {
    // Unset selects the local disk; a deploy that renders `FILESYSTEM_DISK=`
    // meant some other disk, so a blank value fails instead of reading as unset.
    FILESYSTEM_DISK: envVar.string({ refuseBlank: true }).optional(),
    FILESYSTEM_LOCAL_ROOT: envVar.string().optional(),
    S3_BUCKET: envVar.string().optional(),
    S3_REGION: envVar.string().optional(),
    S3_ENDPOINT: envVar.url().optional(),
    S3_FORCE_PATH_STYLE: envVar.string().optional(),
    S3_PREFIX: envVar.string().optional(),
    S3_CONDITIONAL_WRITES: envVar.string().optional(),
    S3_ACCESS_KEY_ID: envVar.secret().optional(),
    S3_SECRET_ACCESS_KEY: envVar.secret().optional(),
    S3_SESSION_TOKEN: envVar.secret().optional(),
  },
  provides: [filesystemToken],
  setup({ options, env, rootDir, services }) {
    const build = (spec: DiskSpec): Disk => {
      switch (spec.driver) {
        case 'local':
          return new LocalDisk({
            root: resolve(rootDir, spec.root),
            ...(spec.maxBytes === undefined ? {} : { maxBytes: spec.maxBytes }),
          });
        case 'memory':
          return new MemoryDisk(spec.maxBytes === undefined ? {} : { maxBytes: spec.maxBytes });
        case 'env':
          return createDiskFromEnv(env, { rootDir }).disk;
      }
    };
    const disks = new Map(Object.entries(options.disks).map(([name, spec]) => [name, build(spec)]));
    const names = Object.freeze([...disks.keys()]);
    const defaultName = options.default ?? (names.length === 1 ? names[0] : undefined);
    const lookup = (name: string): Disk => {
      const disk = disks.get(name);
      if (disk === undefined) throw new FilesystemErrors.Error('unknown_disk');
      return disk;
    };
    services.provide(
      filesystemToken,
      Object.freeze({
        disk(name?: string): Disk {
          if (name !== undefined) return lookup(name);
          if (defaultName === undefined) throw new FilesystemErrors.Error('missing_default');
          return lookup(defaultName);
        },
        names: () => [...names],
      }),
    );
  },
});
