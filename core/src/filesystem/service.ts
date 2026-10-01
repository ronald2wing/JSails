/**
 * Named filesystem service contract (`jsails/filesystem`).
 *
 * The token and interface are core-owned so consumers can require the service
 * without importing the implementation package.
 */

import { createServiceToken, type ServiceToken } from '../extensions/services.js';
import type { Disk } from './disk.js';

/** The service the `filesystem` plugin provides: named disk lookup. */
export interface FileSystem {
  /** The configured disk by name, the default, or the sole disk. */
  disk(name?: string): Disk;
  /** The configured disk names, in declaration order. */
  names(): readonly string[];
}

/** Opaque token for the {@link FileSystem}. */
export const filesystemToken: ServiceToken<FileSystem> =
  createServiceToken<FileSystem>('filesystem');
