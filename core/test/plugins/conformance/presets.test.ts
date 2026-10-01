/**
 * Owner decision 1 for the starters: every preset is locked unless the
 * managed option is given. Locked is stated in code
 * (`activation: { mode: 'locked' }`)
 * with a committed lock file wherever a marketplace exists; the static and CLI
 * presets carry no marketplace; `--managed` (offered with the blog preset)
 * opts into `activation: { mode: 'managed' }` and the marketplace package. No preset
 * lets database state activate plugin code by default.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createStarterFiles, type StarterOptions } from '../../../src/app/starter/index.js';

type Preset = 'starter' | 'admin' | 'blog' | 'saas' | 'cli';

const PRESETS: readonly Preset[] = ['starter', 'admin', 'blog', 'saas', 'cli'];
const WEB_PRESETS: readonly Preset[] = ['admin', 'blog', 'saas'];

const MANAGED_LITERALS: readonly RegExp[] = [
  /\bmanaged\s*:\s*true\b/,
  /\bmode\s*:\s*['"]managed['"]/,
  /\bstateSource\s*:/,
];
const LOCKED_LITERAL = /\bactivation\s*:\s*\{\s*mode\s*:\s*['"]locked['"]\s*\}/;
const MANAGED_LITERAL = /\bactivation\s*:\s*\{\s*mode\s*:\s*['"]managed['"]\s*\}/;
const MARKETPLACE_PACKAGE = '@jsails/marketplace';

interface Generated {
  /** Every app config file (`jsails.app*.js`, `jsails.config.*`), concatenated. */
  readonly config: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly paths: readonly string[];
}

async function generate(options: StarterOptions): Promise<Generated> {
  const { files } = await createStarterFiles(options);
  const config = Object.entries(files)
    .filter(([path]) => /^jsails\.(?:app[^/]*|config\.[^/]+)$/.test(path))
    .map(([, content]) => content)
    .join('\n');
  const manifest = JSON.parse(files['package.json'] ?? '{}') as {
    dependencies?: Record<string, string>;
  };
  return { config, dependencies: manifest.dependencies ?? {}, paths: Object.keys(files) };
}

function options(preset: Preset): StarterOptions {
  return preset === 'starter' ? {} : { [preset]: true };
}

describe('marketplace presets', () => {
  it('no preset lets database state activate plugin code by default', async () => {
    for (const preset of PRESETS) {
      const { config } = await generate(options(preset));
      assert.ok(config !== '', `the ${preset} preset has an app config`);
      for (const literal of MANAGED_LITERALS) {
        assert.doesNotMatch(config, literal, `the ${preset} preset is not managed by default`);
      }
    }
  });

  it('the static and cli presets ship no marketplace', async () => {
    for (const preset of ['starter', 'cli'] as const) {
      const { config, dependencies } = await generate(options(preset));
      assert.equal(dependencies[MARKETPLACE_PACKAGE], undefined, `${preset} has no marketplace`);
      assert.doesNotMatch(config, /\bactivation\s*:/, `${preset} configures no activation mode`);
    }
  });

  it('the web presets state locked mode in code and commit a lock file', async () => {
    for (const preset of WEB_PRESETS) {
      const { config, paths } = await generate(options(preset));
      assert.match(config, LOCKED_LITERAL, `the ${preset} preset states locked activation`);
      assert.ok(paths.includes('jsails.plugins.lock'), `the ${preset} preset commits its lock`);
    }
  });

  it('the blog preset with the managed option ships managed mode', async () => {
    const managedBlog: StarterOptions & { readonly managed: boolean } = {
      blog: true,
      managed: true,
    };
    const { config, dependencies } = await generate(managedBlog);
    assert.match(config, MANAGED_LITERAL, '--blog --managed states managed activation');
    assert.ok(
      dependencies[MARKETPLACE_PACKAGE] !== undefined,
      '--blog --managed depends on the marketplace package',
    );
  });
});
