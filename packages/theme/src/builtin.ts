/**
 * First-party, built-in theme packages.
 *
 * These themes ship inside `@jsails/theme` itself rather than being discovered
 * from the filesystem. A starter or application can seed a registry with them
 * immediately, with no manifest file on disk and no code execution: the raw
 * manifests under `themes/` are run through {@link discoverThemePackages} at
 * module load, so any invalid entry (a bad name, a version that is not semver,
 * an out-of-`--jsails-*` token, or an unsafe path) fails at import time instead
 * of hand-waving invalid data into a registry.
 *
 * The array is frozen and name-sorted by the discovery contract. It is plain
 * data (no I/O, no `node:*` imports), so it stays browser-safe alongside the
 * rest of the theme subpath.
 */

import { discoverThemePackages, type ThemePackage } from './packages/discovery.js';
import { jelloElementorTheme } from './themes/jello-elementor.js';
import { neutralTheme } from './themes/neutral.js';
import { nightTheme } from './themes/night.js';

/**
 * The built-in theme package set: the Jello Elementor blog theme, a neutral
 * light base, and a dark high-contrast child of it. All are validated at
 * module load; the array is frozen and sorted by name, so `jello-elementor`
 * comes first and is the default active theme of a registry seeded with this
 * set ({@link DEFAULT_BUILTIN_THEME_NAME}).
 */
export const builtinThemePackages: readonly ThemePackage[] = discoverThemePackages([
  jelloElementorTheme,
  neutralTheme,
  nightTheme,
]);

/** The theme a registry seeded with {@link builtinThemePackages} activates by default. */
export const DEFAULT_BUILTIN_THEME_NAME = builtinThemePackages[0]!.name;
