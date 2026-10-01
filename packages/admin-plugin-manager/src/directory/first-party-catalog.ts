/**
 * The curated first-party plugin catalog shipped with JSails.
 *
 * These are the official `@jsails/*` plugins that can be installed through the
 * admin plugin manager. Entries are plain data: the catalog never imports a
 * plugin and never performs a network request. The install specifier is the
 * npm registry tarball URL for the current release; bump it with the framework
 * version when publishing a new line.
 *
 * Each entry's `sha256` comes from `first-party-digests.json` beside the
 * compiled module. The digest of a tarball exists only once the release packs
 * it, so `npm run release` writes that file into this package's build just
 * before packing it; a source checkout has none. An entry without a digest
 * (no file, or no valid digest for that package and version) is refused at
 * install unless the app sets `allowUnverified` on `pluginManagerAdmin`, and
 * every such install is reported as a warning.
 */

import { readFileSync } from 'node:fs';

import { createPluginDirectory, type PluginDirectory } from './catalog.js';

/** Registry tarball URL for a scoped `@jsails/*` package at a version. */
function tarball(name: string, version: string): string {
  return `https://registry.npmjs.org/@jsails/${name}/-/${name}-${version}.tgz`;
}

/** The release-written digest map, beside this module in the build. */
const DIGEST_FILE = new URL('./first-party-digests.json', import.meta.url);

/** A lowercase hex SHA-256 digest, the shape the release script writes. */
const SHA256_DIGEST = /^[0-9a-f]{64}$/;

/**
 * Read a release digest map (`<package name>@<version>` to hex SHA-256). The
 * file is optional, so a missing, unreadable, or malformed one yields no
 * digests rather than failing every import of the package; an entry whose
 * value is not a SHA-256 digest is dropped. Either way the affected entries
 * simply carry no digest, which the install path refuses by default.
 */
export function readFirstPartyDigests(file: URL = DIGEST_FILE): ReadonlyMap<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return new Map();
  }
  const digests = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && SHA256_DIGEST.test(value)) {
      digests.set(key, value);
    }
  }
  return digests;
}

/** Framework version every entry in this catalog currently targets. */
const VERSION = '1.0.0';
/** Semver range accepted by every entry in this catalog. */
const FRAMEWORK_RANGE = '^1.0.0';

/** The install specifier of `@jsails/<name>`, plus its digest from `digests` when there is one. */
function artifact(
  digests: ReadonlyMap<string, string>,
  name: string,
): { readonly specifier: string; readonly sha256?: string } {
  const sha256 = digests.get(`@jsails/${name}@${VERSION}`);
  return { specifier: tarball(name, VERSION), ...(sha256 === undefined ? {} : { sha256 }) };
}

/**
 * Build the first-party directory with each entry's `sha256` looked up in
 * `digests` (keyed `<package name>@<version>`, as {@link readFirstPartyDigests}
 * returns).
 */
export function createFirstPartyPluginDirectory(
  digests: ReadonlyMap<string, string>,
): PluginDirectory {
  return createPluginDirectory([
    {
      id: 'auth',
      name: 'Authentication',
      description:
        'Better Auth email/password, device authorization, registration, password reset, and API tokens.',
      categories: ['identity'],
      featured: true,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'auth'),
    },
    {
      id: 'blog',
      name: 'Blog CMS',
      description:
        'Tenant-free posts, pages, categories, tags, menus, settings, revisions, and a database-backed repository.',
      categories: ['content'],
      featured: true,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'blog'),
    },
    {
      id: 'cache',
      name: 'Cache and Mutex',
      description:
        'In-memory or Valkey-backed cache stores, a fixed-window limiter, and mutex locks.',
      categories: ['infrastructure'],
      featured: false,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'cache'),
    },
    {
      id: 'diagnostics',
      name: 'Diagnostics',
      description: 'Record-first in-memory diagnostics with watchers, exporters, and pruning.',
      categories: ['observability'],
      featured: false,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'diagnostics'),
    },
    {
      id: 'filesystem',
      name: 'Filesystem',
      description: 'Local and in-memory disks, file variants, and richer filesystem helpers.',
      categories: ['infrastructure'],
      featured: false,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'filesystem'),
    },
    {
      id: 'editor',
      name: 'Rich-Text Editor',
      description:
        'Editor.js-backed rich-text editing: conversion between the persisted document and editor output, a DOM-agnostic mount adapter, and the Preact island and server renderer.',
      categories: ['content'],
      featured: false,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'editor'),
    },
    {
      id: 'flags',
      name: 'Feature Flags',
      description: 'Boolean gates with memory or database stores, scopes, and A/B rollout helpers.',
      categories: ['infrastructure'],
      featured: true,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'flags'),
    },
    {
      id: 'logging',
      name: 'Logging',
      description: 'Record-first logging with structured fields and a diagnostics bridge.',
      categories: ['observability'],
      featured: false,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'logging'),
    },
    {
      id: 'mail',
      name: 'Mail',
      description: 'Transport-agnostic mailer with in-memory, callback, and lazy SMTP transports.',
      categories: ['communication'],
      featured: false,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'mail'),
    },
    {
      id: 'media',
      name: 'Media Library',
      description:
        'Upload, list, update, and remove media over the Disk seam, with pure editor-selection helpers and in-memory or database-backed indexes.',
      categories: ['content'],
      featured: false,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'media'),
    },
    {
      id: 'notifications',
      name: 'Notifications',
      description: 'Notification fan-out over the mail seam with per-channel delivery.',
      categories: ['communication'],
      featured: false,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'notifications'),
    },
    {
      id: 'tenancy',
      name: 'Tenancy',
      description: 'Opt-in tenants and memberships with an app-owned tenant resolver.',
      categories: ['infrastructure'],
      featured: true,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'tenancy'),
    },
    {
      id: 'theme',
      name: 'Theming',
      description:
        'Resolved CSS token themes with a built-in default and dark package, activation registry, and per-theme [data-theme] blocks.',
      categories: ['design'],
      featured: false,
      latestVersion: VERSION,
      frameworkRange: FRAMEWORK_RANGE,
      ...artifact(digests, 'theme'),
    },
  ]);
}

/** The official first-party plugin directory, frozen and validated once. */
export const firstPartyPluginDirectory: PluginDirectory =
  createFirstPartyPluginDirectory(readFirstPartyDigests());
