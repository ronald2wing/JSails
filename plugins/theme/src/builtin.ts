/**
 * First-party, built-in theme packages.
 *
 * These themes ship inside `@jsails/theme` itself rather than being discovered
 * from the filesystem. A starter or application can seed a registry with them
 * immediately, with no manifest file on disk and no code execution: the raw
 * manifests below are run through {@link discoverThemePackages} at module load,
 * so any invalid entry (a bad name, a version that is not semver, an
 * out-of-`--jsails-*` token, or an unsafe path) fails at import time instead of
 * hand-waving invalid data into a registry.
 *
 * The array is frozen and name-sorted by the discovery contract. It is plain
 * data — no I/O, no `node:*` imports — so it stays browser-safe alongside the
 * rest of the theme subpath.
 */

import { discoverThemePackages, type ThemePackage } from './packages/discovery.js';
import { jelloElementorTheme } from './themes/jello-elementor.js';

/**
 * The built-in theme package set: a neutral default plus a dark,
 * high-contrast alternative. Both are validated at module load; the array is
 * frozen and sorted by name (`neutral` sorts before `night`, so the registry's
 * default active theme is the neutral one). These are first-party starter
 * themes, not filesystem-discovered packages.
 */
export const builtinThemePackages: readonly ThemePackage[] = discoverThemePackages([
  jelloElementorTheme,
  {
    path: 'neutral',
    manifest: {
      name: 'neutral',
      version: '1.0.0',
      description: 'Neutral light theme with a muted gray accent — the calm default.',
      author: 'JSails',
      tokens: {
        '--jsails-bg': '#ffffff',
        '--jsails-fg': '#1f2937',
        '--jsails-accent': '#6b7280',
        '--jsails-muted': '#f3f4f6',
        '--jsails-border': '#e5e7eb',
        '--jsails-radius': '0.375rem',
      },
      contentTypes: ['article', 'page'],
    },
  },
  {
    path: 'night',
    manifest: {
      name: 'night',
      version: '1.0.0',
      parent: 'neutral',
      description: 'Dark high-contrast theme with a bright cyan accent.',
      author: 'JSails',
      tokens: {
        '--jsails-bg': '#0f172a',
        '--jsails-fg': '#e2e8f0',
        '--jsails-accent': '#22d3ee',
        '--jsails-muted': '#1e293b',
        '--jsails-border': '#334155',
        '--jsails-radius': '0.375rem',
      },
      contentTypes: ['article', 'page'],
    },
  },
]);
