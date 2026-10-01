/**
 * The curated first-party plugin catalog shipped with JSails.
 *
 * These are the official `@jsails/*` plugins that can be installed through the
 * admin plugin manager. Entries are plain data: the catalog never imports a
 * plugin, never reads the filesystem, and never performs a network request. The
 * install specifier is the npm registry tarball URL for the current release;
 * bump it with the framework version when publishing a new line.
 */

import { createPluginDirectory, type PluginDirectory } from './catalog.js';

/** Registry tarball URL for a scoped `@jsails/*` package at a version. */
function tarball(name: string, version: string): string {
  return `https://registry.npmjs.org/@jsails/${name}/-/${name}-${version}.tgz`;
}

/** Framework version every entry in this catalog currently targets. */
const VERSION = '1.0.0';
/** Semver range accepted by every entry in this catalog. */
const FRAMEWORK_RANGE = '^1.0.0';

/** The official first-party plugin directory, frozen and validated once. */
export const firstPartyPluginDirectory: PluginDirectory = createPluginDirectory([
  {
    id: 'auth',
    name: 'Authentication',
    description:
      'Better Auth email/password, device authorization, registration, password reset, and API tokens.',
    categories: ['identity'],
    featured: true,
    latestVersion: VERSION,
    frameworkRange: FRAMEWORK_RANGE,
    specifier: tarball('auth', VERSION),
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
    specifier: tarball('blog', VERSION),
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
    specifier: tarball('cache', VERSION),
  },
  {
    id: 'diagnostics',
    name: 'Diagnostics',
    description: 'Record-first in-memory diagnostics with watchers, exporters, and pruning.',
    categories: ['observability'],
    featured: false,
    latestVersion: VERSION,
    frameworkRange: FRAMEWORK_RANGE,
    specifier: tarball('diagnostics', VERSION),
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Local and in-memory disks, file variants, and richer filesystem helpers.',
    categories: ['infrastructure'],
    featured: false,
    latestVersion: VERSION,
    frameworkRange: FRAMEWORK_RANGE,
    specifier: tarball('filesystem', VERSION),
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
    specifier: tarball('editor', VERSION),
  },
  {
    id: 'flags',
    name: 'Feature Flags',
    description: 'Boolean gates with memory or database stores, scopes, and A/B rollout helpers.',
    categories: ['infrastructure'],
    featured: true,
    latestVersion: VERSION,
    frameworkRange: FRAMEWORK_RANGE,
    specifier: tarball('flags', VERSION),
  },
  {
    id: 'logging',
    name: 'Logging',
    description: 'Record-first logging with structured fields and a diagnostics bridge.',
    categories: ['observability'],
    featured: false,
    latestVersion: VERSION,
    frameworkRange: FRAMEWORK_RANGE,
    specifier: tarball('logging', VERSION),
  },
  {
    id: 'mail',
    name: 'Mail',
    description: 'Transport-agnostic mailer with in-memory, callback, and lazy SMTP transports.',
    categories: ['communication'],
    featured: false,
    latestVersion: VERSION,
    frameworkRange: FRAMEWORK_RANGE,
    specifier: tarball('mail', VERSION),
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
    specifier: tarball('media', VERSION),
  },
  {
    id: 'notifications',
    name: 'Notifications',
    description: 'Notification fan-out over the mail seam with per-channel delivery.',
    categories: ['communication'],
    featured: false,
    latestVersion: VERSION,
    frameworkRange: FRAMEWORK_RANGE,
    specifier: tarball('notifications', VERSION),
  },
  {
    id: 'plugin-tools',
    name: 'Plugin Tools',
    description: 'Shared cleanup, Zod, trusted-mutation, and response helpers for plugin authors.',
    categories: ['developer'],
    featured: false,
    latestVersion: VERSION,
    frameworkRange: FRAMEWORK_RANGE,
    specifier: tarball('plugin-tools', VERSION),
  },
  {
    id: 'signals',
    name: 'Signals',
    description: 'Typed application signal bus with request and lifecycle events.',
    categories: ['observability'],
    featured: false,
    latestVersion: VERSION,
    frameworkRange: FRAMEWORK_RANGE,
    specifier: tarball('signals', VERSION),
  },
  {
    id: 'tenancy',
    name: 'Tenancy',
    description: 'Opt-in tenants and memberships with an app-owned tenant resolver.',
    categories: ['infrastructure'],
    featured: true,
    latestVersion: VERSION,
    frameworkRange: FRAMEWORK_RANGE,
    specifier: tarball('tenancy', VERSION),
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
    specifier: tarball('theme', VERSION),
  },
]);
