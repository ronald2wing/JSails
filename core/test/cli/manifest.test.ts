/**
 * The built-in command table (`cli/manifest.ts`): every descriptor is well
 * formed and frozen, every `load()` resolves to a module that exports `run`,
 * the table imports nothing but types (so listing commands loads no command
 * code), each package command hint names a package that declares that
 * command, and the bins' Node floor equals `engines.node` and `.nvmrc`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { COMMAND_NAME_PATTERN } from '../../src/cli/command-sources.js';
import { BUILTIN_COMMANDS, PACKAGE_COMMANDS } from '../../src/cli/manifest.js';

/** A file of the repository, by its path from the repo root. */
function repoFile(path: string): string {
  return readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
}

describe('the built-in command table', () => {
  it('names each command once, with a command name and a one-line summary', () => {
    const names = BUILTIN_COMMANDS.map((command) => command.name);
    assert.equal(new Set(names).size, names.length);
    for (const command of BUILTIN_COMMANDS) {
      assert.match(command.name, COMMAND_NAME_PATTERN);
      assert.ok(command.summary.length > 0 && !command.summary.includes('\n'), command.name);
      assert.ok(Object.isFrozen(command), `${command.name} is frozen`);
    }
    assert.ok(Object.isFrozen(BUILTIN_COMMANDS));
  });

  it('gives a passthrough command no options or positionals, and a short flag one owner', () => {
    for (const command of BUILTIN_COMMANDS) {
      if (command.passthrough === true) {
        assert.deepEqual(Object.keys(command.options), [], command.name);
        assert.equal(command.positionals, undefined, command.name);
      }
      const shorts = Object.values(command.options).flatMap((option) =>
        option.short === undefined ? [] : [option.short],
      );
      assert.equal(new Set(shorts).size, shorts.length, `${command.name} reuses a short flag`);
      assert.ok(!shorts.includes('h') && !shorts.includes('n'), command.name);
      assert.ok(!('help' in command.options), command.name);
    }
  });

  it('resolves every load() to a module that exports run', async () => {
    for (const command of BUILTIN_COMMANDS) {
      const module = await command.load();
      assert.equal(typeof module.run, 'function', `${command.name} exports run`);
      assert.ok(
        module.preflight === undefined || typeof module.preflight === 'function',
        command.name,
      );
    }
  });

  it('imports nothing but types, so the table loads no command code', () => {
    const source = repoFile('core/src/cli/manifest.ts');
    const imports = source.match(/^import\b.*$/gm) ?? [];
    assert.ok(imports.length > 0);
    for (const line of imports) assert.match(line, /^import type /, line);
    assert.doesNotMatch(source, /^export \* from/m);
  });

  it('hints only at packages that declare the command, under no built-in name', () => {
    const builtins = new Set(BUILTIN_COMMANDS.map((command) => command.name));
    for (const [name, packageName] of PACKAGE_COMMANDS) {
      assert.equal(builtins.has(name), false, name);
      assert.match(packageName, /^@jsails\/[a-z-]+$/);
      const manifest = JSON.parse(
        repoFile(`packages/${packageName.slice('@jsails/'.length)}/package.json`),
      ) as { jsails?: { commands?: readonly { readonly name: string }[] } };
      assert.ok(
        manifest.jsails?.commands?.some((command) => command.name === name),
        `${packageName} declares ${name}`,
      );
    }
  });
});

describe('the bins', () => {
  it('check the Node floor that engines.node and .nvmrc state', () => {
    const engines = (JSON.parse(repoFile('core/package.json')) as { engines: { node: string } })
      .engines.node;
    const floor = /^>=(\d+)\.0\.0$/.exec(engines)?.[1];
    assert.ok(floor !== undefined, engines);
    assert.equal(repoFile('.nvmrc').trim(), floor);
    for (const bin of ['bin.cts', 'create-bin.cts']) {
      const source = repoFile(`core/src/cli/${bin}`);
      assert.match(source, new RegExp(`^var NODE_FLOOR = ${floor};$`, 'm'), bin);
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(code, /\brequire\s*\(/, `${bin} requires nothing`);
      assert.doesNotMatch(code, /\b(?:const|let|class|async|await)\b|=>|`/, `${bin} is ES5`);
    }
  });

  it('are what package.json names', () => {
    const { bin } = JSON.parse(repoFile('core/package.json')) as {
      bin: Readonly<Record<string, string>>;
    };
    assert.deepEqual(bin, {
      jsails: './dist/src/cli/bin.cjs',
      'create-jsails': './dist/src/cli/create-bin.cjs',
    });
  });
});
