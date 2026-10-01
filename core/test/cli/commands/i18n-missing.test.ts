/**
 * Tests for `jsails i18n:missing`. Exercises the DI seam (`runI18nMissing`)
 * and the command's arg parsing through the dispatcher, without importing real
 * config modules.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  runI18nMissing,
  runI18nMissingCommand,
  type I18nMissingDeps,
} from '../../../src/cli/commands/i18n-missing.js';
import type { ResolvedAppConfig } from '../../../src/app/config/index.js';
import { dispatch } from '../../../src/cli/dispatch.js';

interface Sinks {
  out: string[];
  err: string[];
}

/** Build a minimal resolved config with the fields the command reads. */
function resolveConfig(i18n?: ResolvedAppConfig['i18n']): ResolvedAppConfig {
  return {
    rootDir: '/app',
    pagesDir: '/app/pages',
    apiDir: '/app/api',
    i18n,
  } as unknown as ResolvedAppConfig;
}

function depsFor(
  config: ResolvedAppConfig,
  files: Record<string, string>,
): I18nMissingDeps & Sinks {
  const sinks: Sinks = { out: [], err: [] };
  return {
    loadConfig: async () => config,
    listFiles: (dir) => Object.keys(files).filter((file) => file.startsWith(dir)),
    readFile: (path) => files[path] ?? '',
    env: {},
    stdout: (text) => sinks.out.push(text),
    stderr: (text) => sinks.err.push(text),
    out: sinks.out,
    err: sinks.err,
  };
}

describe('runI18nMissing', () => {
  it('reports a key referenced in code but absent from catalogs', async () => {
    const config = resolveConfig({
      locale: 'en',
      fallbackLocale: 'en',
      catalogs: { en: { nav: { home: 'Home' } } },
    });
    const deps = depsFor(config, {
      '/app/pages/index.js': `I18n.t('nav.home'); I18n.t('missing.key');`,
    });
    const { result, exitCode } = await runI18nMissing(
      { configPath: 'jsails.app.js', options: {} },
      deps,
    );
    assert.equal(exitCode, 1);
    assert.deepEqual(
      result.missing.map((m) => m.key),
      ['missing.key'],
    );
    assert.equal(result.dynamic, 0);
    assert.equal(result.scannedFiles, 1);
  });

  it('exits 0 when every key resolves', async () => {
    const config = resolveConfig({
      locale: 'en',
      fallbackLocale: 'en',
      catalogs: { en: { nav: { home: 'Home' } } },
    });
    const deps = depsFor(config, { '/app/pages/index.js': `I18n.t('nav.home');` });
    const { result, exitCode } = await runI18nMissing(
      { configPath: 'jsails.app.js', options: {} },
      deps,
    );
    assert.equal(exitCode, 0);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unused, []);
  });

  it('reports unused keys only via the unused list (not missing)', async () => {
    const config = resolveConfig({
      locale: 'en',
      fallbackLocale: 'en',
      catalogs: { en: { nav: { home: 'Home' }, stale: 'S' } },
    });
    const deps = depsFor(config, { '/app/pages/index.js': `I18n.t('nav.home');` });
    const { result } = await runI18nMissing({ configPath: 'jsails.app.js', options: {} }, deps);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.unused, ['stale']);
  });

  it('counts dynamic call sites without guessing', async () => {
    const config = resolveConfig({
      locale: 'en',
      fallbackLocale: 'en',
      catalogs: { en: {} },
    });
    const deps = depsFor(config, { '/app/pages/index.js': `I18n.t(dynamicKey);` });
    const { result } = await runI18nMissing({ configPath: 'jsails.app.js', options: {} }, deps);
    assert.equal(result.dynamic, 1);
    assert.deepEqual(result.missing, []);
  });

  it('fails when i18n is not configured', async () => {
    const config = resolveConfig(undefined);
    const deps = depsFor(config, { '/app/pages/index.js': `I18n.t('nav.home');` });
    const { exitCode } = await runI18nMissing({ configPath: 'jsails.app.js', options: {} }, deps);
    assert.equal(exitCode, 1);
    assert.ok(deps.err.join('').includes('not configured'));
  });
});

describe('runI18nMissingCommand', () => {
  it('prints JSON with --json', async () => {
    const config = resolveConfig({
      locale: 'en',
      fallbackLocale: 'en',
      catalogs: { en: { nav: { home: 'Home' } } },
    });
    const deps = depsFor(config, { '/app/pages/index.js': `I18n.t('nav.home');` });
    const code = await runI18nMissingCommand(
      { configPath: 'jsails.app.js', options: { json: true } },
      deps,
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(deps.out.join('\n')) as { missing: unknown[] };
    assert.deepEqual(parsed.missing, []);
  });
});

describe('jsails i18n:missing (arg parsing)', () => {
  async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await dispatch(['i18n:missing', ...args], {
      cwd: process.cwd(),
      stdout: (text) => out.push(text),
      stderr: (line) => err.push(line),
    });
    return { code, out: out.join(''), err: err.join('\n') };
  }

  it('returns a usage error for an unknown option, before the environment resolves', async () => {
    const result = await run('--bogus');
    assert.equal(result.code, 2);
    assert.match(result.err, /unknown option --bogus/);
  });

  it('prints help and exits 0 with --help', async () => {
    const result = await run('--help');
    assert.equal(result.code, 0);
    assert.match(result.out, /Usage:/);
  });
});
