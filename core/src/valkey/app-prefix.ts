/**
 * The default app key prefix, `<app name>:<environment>`.
 *
 * Every Valkey consumer of an app (cache, live log, job queues) keys its data
 * under this prefix, so two apps, or two environments of one app, that share a
 * server never read or consume each other's data, which a fixed default such
 * as BullMQ's `bull` would make them do.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The app-name part when no `package.json` names the app. */
const UNNAMED_APP = 'jsails';

/** Reduce a name to characters that are safe and unambiguous inside a Valkey key. */
function sanitizePrefixPart(value: string): string {
  const cleaned = value
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 100);
}

/** The `name` field of the `package.json` in `dir`, if it has a non-empty one. */
function packageNameIn(dir: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, 'package.json'), 'utf8');
  } catch {
    return undefined;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (manifest === null || typeof manifest !== 'object') return undefined;
  const name = (manifest as { name?: unknown }).name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/**
 * The `name` of the nearest `package.json` at or above `startDir` that has one.
 * A nameless manifest (such as a nested `{"type":"module"}`) is skipped, so two
 * processes of one app that start the search from different directories still
 * reach the app's own manifest and agree on the prefix.
 */
function nearestPackageName(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const name = packageNameIn(dir);
    if (name !== undefined) return name;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The default app key prefix: the `name` of the nearest `package.json` at or
 * above `startDir`, reduced to `[A-Za-z0-9._-]`, and the process's mode, joined
 * with `:`. The mode is `NODE_ENV` when it is `development` or `test`, else
 * `production` (unset included): the rule the environment resolver derives
 * `NODE_ENV` by, and the `mode` a plugin's setup sees, so a plugin keying from
 * its `mode` and a runtime config keying from its environment agree.
 *
 * `startDir` is the app root: a plugin's `setup` passes its context's
 * `rootDir` (and `{ NODE_ENV: mode }` as `env`), a runtime config its own
 * directory and the resolved environment. There is no default, because
 * the working directory is not the app root when `--config` names a project
 * elsewhere, and a producer and a worker that derived their prefixes from
 * different directories would key one queue two ways.
 *
 * @public
 */
export function defaultAppPrefix(
  startDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const app = sanitizePrefixPart(nearestPackageName(startDir) ?? '') || UNNAMED_APP;
  const nodeEnv = env.NODE_ENV;
  const environment = nodeEnv === 'development' || nodeEnv === 'test' ? nodeEnv : 'production';
  return `${app}:${environment}`;
}
