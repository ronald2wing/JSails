/**
 * The tool and dependency versions the final report records, read best-effort
 * from the verifier's own toolchain and the fixture's `node_modules`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { npm } from '../subprocess.mjs';
import { readManifest, repoRoot } from '../workspaces.mjs';
import { BROWSER_PATH } from './browser.mjs';

/** The version of `name` installed under `dir/node_modules`, or `null`. */
function installedVersion(dir, name) {
  try {
    return readManifest(join(dir, 'node_modules', name)).version ?? null;
  } catch {
    return null;
  }
}

/** `cmd --version`-style output, or `null` when the command fails. */
function commandOutput(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function collectVersions(fixtureDir, { skipBrowser }) {
  return {
    node: process.version,
    npm: commandOutput(npm, ['--version']),
    jsails: readManifest(join(repoRoot, 'core')).version ?? null,
    // Under --skip-browser the Chromium binary is never probed, not even for
    // `--version`, so the run performs zero browser subprocess activity.
    chromium:
      skipBrowser || !existsSync(BROWSER_PATH) ? null : commandOutput(BROWSER_PATH, ['--version']),
    preact: installedVersion(fixtureDir, 'preact'),
    '@preact/signals': installedVersion(fixtureDir, '@preact/signals'),
    vite: installedVersion(fixtureDir, 'vite'),
    hono: installedVersion(fixtureDir, 'hono'),
    '@hono/node-server': installedVersion(fixtureDir, '@hono/node-server'),
    typescript: installedVersion(fixtureDir, 'typescript'),
    tailwindcss: installedVersion(fixtureDir, 'tailwindcss'),
    daisyui: installedVersion(fixtureDir, 'daisyui'),
  };
}
