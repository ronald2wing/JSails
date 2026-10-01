/**
 * Parsing and validation for `config.volumes` values. A value is either a
 * named Docker volume (`"<name>:<containerPath>"`, or a bare container path
 * whose source defaults to the volume's key) or a host bind mount
 * (`"<hostPath>:<containerPath>[:ro|rw]"`).
 */

import { isForbiddenKey } from '../../json/shape.js';
import { CONTROL_CHARS } from '../../support/strings.js';

import { JamalConfigError } from '../error.js';
import type { JamalVolumeSpec } from './model.js';

export function assertVolumeName(name: string): void {
  if (name.length === 0) {
    throw new JamalConfigError('config.volumes names must be non-empty');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new JamalConfigError('config.volumes names must not contain a path separator');
  }
  if (name === '.' || name === '..') {
    throw new JamalConfigError('config.volumes names must not be "." or ".."');
  }
  if (CONTROL_CHARS.test(name)) {
    throw new JamalConfigError('config.volumes names must not contain control characters');
  }
  if (isForbiddenKey(name)) {
    throw new JamalConfigError('config.volumes names must not use a reserved key');
  }
}

function assertContainerPath(path: string): void {
  if (!path.startsWith('/')) {
    throw new JamalConfigError(
      'config.volumes values must be absolute container paths starting with "/"',
    );
  }
  if (path.includes('\\') || CONTROL_CHARS.test(path)) {
    throw new JamalConfigError(
      'config.volumes values must not contain a backslash or control characters',
    );
  }
  for (const segment of path.split('/')) {
    if (segment === '..') {
      throw new JamalConfigError('config.volumes values must not contain a ".." traversal segment');
    }
  }
}

/** Reject a host volume source that carries a backslash, control characters, or ".." traversal. */
function assertHostPath(source: string): void {
  if (source.includes('\\')) {
    throw new JamalConfigError('config.volumes host paths must not contain a backslash');
  }
  if (CONTROL_CHARS.test(source)) {
    throw new JamalConfigError('config.volumes host paths must not contain control characters');
  }
  if (source.includes('..')) {
    throw new JamalConfigError(
      'config.volumes host paths must not contain a ".." traversal segment',
    );
  }
}

/**
 * Parse a volume value string into a {@link JamalVolumeSpec}. A value is a
 * named volume when its first colon-delimited segment is an identifier (no `/`,
 * no leading `.`), otherwise it is a host path. Host paths are detected by a
 * leading `/`, `./`, or `$PWD/`.
 *
 * Named volume form: `"<name>:<containerPath>"`
 * Host volume form:  `"<hostPath>:<containerPath>[:ro|rw]"`
 *
 * `$PWD/` host sources are preserved verbatim (the shell or Compose resolves
 * them); the parser never reads the filesystem.
 */
export function parseVolumeSpec(value: string): JamalVolumeSpec {
  const parts = value.split(':');

  // No colon: the value is just the container path, and the volume's own name
  // becomes the source when the model is built.
  if (parts.length === 1) {
    const containerPath = parts[0]!;
    assertContainerPath(containerPath);
    return Object.freeze({ source: '', containerPath, options: undefined, host: false });
  }

  // split always returns at least one element for any string input.
  const firstSegment = parts[0]!;
  const isHost =
    firstSegment.startsWith('/') ||
    firstSegment.startsWith('./') ||
    firstSegment.startsWith('$PWD/');

  if (isHost) {
    // Find the container path: the segment starting with '/',
    // skipping index 0 (which is part of the host source).
    let containerIdx = -1;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i]!.startsWith('/')) {
        containerIdx = i;
        break;
      }
    }
    if (containerIdx < 0) {
      throw new JamalConfigError(
        'config.volumes values must include an absolute container path starting with "/"',
      );
    }
    const source = parts.slice(0, containerIdx).join(':');
    const containerPath = parts[containerIdx]!;
    const optionsPart = parts[containerIdx + 1];

    let options: string | undefined = undefined;
    if (optionsPart !== undefined) {
      if (optionsPart === 'ro' || optionsPart === 'rw') {
        options = optionsPart;
      } else {
        throw new JamalConfigError('config.volumes options must be "ro" or "rw"');
      }
    }

    assertHostPath(source);
    assertContainerPath(containerPath);

    return Object.freeze({ source, containerPath, options, host: true });
  }

  // Named volume: exactly two segments.
  if (parts.length !== 2) {
    throw new JamalConfigError('config.volumes values must be "<name>:<containerPath>"');
  }

  const name = parts[0]!;
  const containerPath = parts[1]!;

  assertVolumeName(name);
  assertContainerPath(containerPath);

  return Object.freeze({ source: name, containerPath, options: undefined, host: false });
}
