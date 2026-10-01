/**
 * Tests for `runPluginsCommand` (`list`, `check`, usage, and safety): discovery
 * output, framework-version checks, the refusal of the removed installer and
 * state subcommands, and value-free failures.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runPluginsCommand, type PluginsDeps } from '../../../../src/cli/commands/plugins/index.js';
import { parseCommandArgs } from '../../../../src/cli/command-args.js';
import { renderCommandHelp } from '../../../../src/cli/help.js';
import { BUILTIN_COMMANDS } from '../../../../src/cli/manifest.js';
import { packageManifestJson } from '../../../plugins/manifest-fixture.js';

interface Sinks {
  out: string[];
  err: string[];
}

function sinks(): Sinks {
  return { out: [], err: [] };
}

function deps(cwd: string, s: Sinks): PluginsDeps {
  return {
    cwd,
    frameworkVersion: '0.1.0',
    stdout: (text) => s.out.push(text),
    stderr: (text) => s.err.push(text),
  };
}

const DESCRIPTOR = BUILTIN_COMMANDS.find((command) => command.name === 'plugins');

/** Run `jsails plugins ...argv` as the dispatcher would, over `deps`. */
function plugins(argv: readonly string[], deps: PluginsDeps): number {
  assert.ok(DESCRIPTOR);
  const parsed = parseCommandArgs(DESCRIPTOR, argv);
  const usage = (message: string): number => {
    deps.stderr(`jsails: ${message}`);
    return 2;
  };
  if (parsed.kind === 'help') {
    deps.stdout(renderCommandHelp(DESCRIPTOR));
    return 0;
  }
  if (parsed.kind === 'usage') return usage(parsed.message);
  return runPluginsCommand(parsed.values, parsed.positionals, deps, usage);
}

const fixturesRoot = mkdtempSync(join(tmpdir(), 'plugins-commands-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function manifest(id: string, version: string, jsailsCompat: string): Record<string, unknown> {
  return packageManifestJson({ id, version, jsailsCompat, entry: './index.js' });
}

/** A root plugin whose package.json requires one transitive plugin package. */
function writeChain(root: string): void {
  writeJson(join(root, 'package.json'), {
    dependencies: { 'parent-plugin': '^1.0.0' },
  });
  writeJson(join(root, 'node_modules', 'parent-plugin', 'package.json'), {
    name: 'parent-plugin',
    version: '1.0.0',
    dependencies: { 'child-plugin': '^1.0.0' },
    jsails: manifest('parent', '1.0.0', '^0.1.0'),
  });
  writeJson(join(root, 'node_modules', 'child-plugin', 'package.json'), {
    name: 'child-plugin',
    version: '1.0.0',
    jsails: manifest('child', '1.0.0', '^0.1.0'),
  });
}

describe('runPluginsCommand list', () => {
  it('lists discovered plugins as a human table', () => {
    const root = join(fixturesRoot, 'list-human');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), {
      name: 'my-plugin',
      jsails: manifest('acme', '1.0.0', '^0.1.0'),
    });

    const s = sinks();
    const code = plugins([], deps(root, s));
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /1 plugin\(s\) discovered/);
    assert.match(s.out.join('\n'), /acme@1\.0\.0 \[my-plugin\] root/);
  });

  it('emits JSON for --json', () => {
    const root = join(fixturesRoot, 'list-json');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), {
      name: 'my-plugin',
      jsails: manifest('acme', '1.0.0', '^0.1.0'),
    });

    const s = sinks();
    const code = plugins(['--json'], deps(root, s));
    assert.equal(code, 0);
    const parsed = JSON.parse(s.out[0]!) as {
      plugins: Array<{ id: string; packageName: string; root: boolean }>;
    };
    assert.equal(parsed.plugins.length, 1);
    assert.equal(parsed.plugins[0]!.id, 'acme');
    assert.equal(parsed.plugins[0]!.packageName, 'my-plugin');
    assert.equal(parsed.plugins[0]!.root, true);
  });

  it('prints discovery warnings to stderr without failing', () => {
    const root = join(fixturesRoot, 'list-warning');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });

    const s = sinks();
    const code = plugins([], deps(root, s));
    assert.equal(code, 0);
    assert.match(s.err.join('\n'), /not installed/);
  });

  it('shows root provenance and requiredBy for a transitive plugin', () => {
    const root = join(fixturesRoot, 'list-provenance');
    writeChain(root);

    const s = sinks();
    const code = plugins([], deps(root, s));
    assert.equal(code, 0);
    const out = s.out.join('\n');
    assert.match(out, /parent@1\.0\.0 \[parent-plugin\] root/);
    assert.match(out, /child@1\.0\.0 \[child-plugin\] dependency required by: parent/);
  });

  it('emits root/requiredBy/provenanceChain/edges in --json', () => {
    const root = join(fixturesRoot, 'list-json-provenance');
    writeChain(root);

    const s = sinks();
    const code = plugins(['--json'], deps(root, s));
    assert.equal(code, 0);
    const parsed = JSON.parse(s.out[0]!) as {
      plugins: Array<{
        id: string;
        root?: boolean;
        requiredBy?: string[];
        provenanceChain?: string[];
      }>;
      edges?: string[];
    };

    const parent = parsed.plugins.find((p) => p.id === 'parent')!;
    const child = parsed.plugins.find((p) => p.id === 'child')!;

    assert.equal(parent.root, true);
    assert.equal(parent.requiredBy, undefined);
    assert.deepEqual(parent.provenanceChain, ['parent']);

    assert.equal(child.root, false);
    assert.deepEqual(child.requiredBy, ['parent']);
    assert.deepEqual(child.provenanceChain, ['child', 'parent']);

    assert.deepEqual(parsed.edges, ['parent -> child']);
  });
});

describe('runPluginsCommand check', () => {
  it('exits 0 when all plugins are compatible', () => {
    const root = join(fixturesRoot, 'check-ok');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), {
      name: 'my-plugin',
      jsails: manifest('acme', '1.0.0', '^0.1.0'),
    });

    const s = sinks();
    const code = plugins(['check'], deps(root, s));
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /0 finding\(s\)/);
  });

  it('exits 1 on an incompatible plugin and emits a finding', () => {
    const root = join(fixturesRoot, 'check-bad');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), {
      name: 'my-plugin',
      jsails: manifest('acme', '2.0.0', '^1.0.0'),
    });

    const s = sinks();
    const code = plugins(['check'], deps(root, s));
    assert.equal(code, 1);
    assert.match(s.out.join('\n'), /incompatible/);
  });

  it('emits JSON for check --json', () => {
    const root = join(fixturesRoot, 'check-json');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'my-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'my-plugin', 'package.json'), {
      name: 'my-plugin',
      jsails: manifest('acme', '2.0.0', '^1.0.0'),
    });

    const s = sinks();
    const code = plugins(['check', '--json'], deps(root, s));
    assert.equal(code, 1);
    const parsed = JSON.parse(s.out[0]!) as {
      ok: boolean;
      frameworkVersion: string;
    };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.frameworkVersion, '0.1.0');
  });

  it('exits 1 and surfaces a graph issue as a dedicated finding kind', () => {
    const root = join(fixturesRoot, 'check-graph-issue');
    writeJson(join(root, 'package.json'), {
      dependencies: { 'parent-plugin': '^1.0.0' },
    });
    writeJson(join(root, 'node_modules', 'parent-plugin', 'package.json'), {
      name: 'parent-plugin',
      version: '1.0.0',
      dependencies: { 'missing-plugin': '^1.0.0' },
      jsails: manifest('parent', '1.0.0', '^0.1.0'),
    });

    const s = sinks();
    const code = plugins(['check'], deps(root, s));
    assert.equal(code, 1);
    assert.match(s.out.join('\n'), /missing\s+transitive dependency/);
  });
});

describe('runPluginsCommand usage and safety', () => {
  it('prints help and exits 0 for --help', () => {
    const root = join(fixturesRoot, 'help');
    const s = sinks();
    const code = plugins(['--help'], deps(root, s));
    assert.equal(code, 0);
    assert.match(s.out.join('\n'), /Usage:/);
    assert.match(s.out.join('\n'), /plugins\.use/);
  });

  it('rejects an unknown subcommand with exit 2', () => {
    const root = join(fixturesRoot, 'unknown');
    const s = sinks();
    const code = plugins(['nope'], deps(root, s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /unknown subcommand/);
    assert.doesNotMatch(s.err.join('\n'), /nope/);
  });

  it('refuses every removed installer and state subcommand, echoing nothing', () => {
    const root = join(fixturesRoot, 'removed');
    for (const subcommand of [
      'install',
      'uninstall',
      'enable',
      'disable',
      'rollback',
      'resolve',
      'export',
      'import',
    ]) {
      const s = sinks();
      const code = plugins([subcommand, 'supersecret-plugin', '9.9.9'], deps(root, s));
      assert.equal(code, 2, subcommand);
      const err = s.err.join('\n');
      assert.match(err, /was removed: plugins run when the app config lists them in plugins\.use/);
      assert.doesNotMatch(err, /supersecret-plugin|9\.9\.9/);
      assert.deepEqual(s.out, []);
    }
  });

  it('refuses the removed flags as usage errors', () => {
    const root = join(fixturesRoot, 'removed-flags');
    for (const flag of ['--dir', '--config', '--db-config', '--url', '--allow-unverified']) {
      const s = sinks();
      const code = plugins(['list', flag, 'x'], deps(root, s));
      assert.equal(code, 2, flag);
    }
  });

  it('rejects an argument after list or check', () => {
    const root = join(fixturesRoot, 'extra');
    const s = sinks();
    const code = plugins(['check', 'extra'], deps(root, s));
    assert.equal(code, 2);
    assert.match(s.err.join('\n'), /unexpected argument/);
  });
});
