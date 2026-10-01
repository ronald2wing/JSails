/**
 * Tests for the portable-path fragment (`eslint/paths.mjs`): the repository
 * config applies both bans to core source except the path module itself, and
 * planted code reports exactly the forms the fragment documents, and nothing
 * on the portable forms.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import * as paths from '../../eslint/paths.mjs';
import { composeFragments } from '../eslint-fragments.mjs';
import { repoRoot } from '../workspaces.mjs';

const RULES = ['jsails/no-raw-dynamic-import', 'jsails/no-separator-conversion'];

describe('repository config', () => {
  it('applies both bans to core/src, not to the path module, packages or tests', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const ruleState = async (file) => {
      const { rules } = await eslint.calculateConfigForFile(join(repoRoot, file));
      return RULES.map((rule) => rules[rule]?.[0] ?? 0);
    };
    assert.deepEqual(await ruleState('core/src/server/api-routes.ts'), [2, 2]);
    assert.deepEqual(await ruleState('core/src/support/project-paths.server.ts'), [0, 0]);
    assert.deepEqual(await ruleState('packages/live/src/plugin.ts'), [0, 0]);
    assert.deepEqual(await ruleState('core/test/x.test.ts'), [0, 0]);
  });
});

describe('path fragment on planted code', () => {
  const cwd = join(repoRoot, 'plant');
  const config = [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ...composeFragments([
      {
        file: 'eslint/paths.mjs',
        configs: paths.default,
        restrictedSyntax: paths.restrictedSyntax,
      },
    ]),
  ];

  /** `[line, rule]` for every report on `lines`, linted as `file`. */
  const reports = (lines, file = 'core/src/x.ts') =>
    new Linter({ cwd })
      .verify(lines.join('\n'), config, { filename: join(cwd, file) })
      .map((message) => [message.line, message.ruleId]);

  const banned = [
    'await import(file);',
    'await import(pathToFileURL(file).href);',
    'await import(`${href}?v=1`);',
    "await import('./a' + name);",
    "const parts = rel.split(sep).join('/');",
    "const parts = rel.split(path.sep).join('/');",
    "if (sep === '\\\\') windows = true;",
    "const windows = path.sep !== '/';",
    "const first = relative(root, file).split('/')[0];",
    "const first = path.join(a, b).split('/');",
    "const id = relative(root, file).replace(/\\\\/g, '/');",
    "const id = resolve(file).replaceAll('\\\\', '/');",
    "const id = filename.replaceAll('\\\\', '/');",
    "const id = filename.replace(/\\\\/g, '/');",
    "const id = filename.split('\\\\').join('/');",
  ];
  const allowed = [
    "await import('node:fs');",
    'await import(`node:path`);',
    'await importFile(file);',
    'await importModule(specifier);',
    "const segments = route.split('/');",
    "const id = toPosixId(relative(root, file)).split('/');",
    "const stem = relative(root, file).replace(/\\.ts$/, '');",
    "const escaped = value.replace(/\\\\/g, '\\\\\\\\');",
    'const parts = text.split(separator);',
    "const lines = text.split('\\n');",
    "const quoted = value.replaceAll('\\\\', '\\\\\\\\');",
  ];

  it('reports every banned form once, with the rule that bans it', () => {
    const found = reports(banned);
    assert.deepEqual(
      found.map(([line]) => line),
      banned.map((_, index) => index + 1),
    );
    assert.deepEqual(
      found.map(([, rule]) => rule),
      [...Array(4).fill(RULES[0]), ...Array(11).fill(RULES[1])],
    );
  });

  it('reports nothing on the portable forms', () => {
    assert.deepEqual(reports(allowed), []);
  });

  it('exempts the path module and leaves packages alone', () => {
    assert.deepEqual(reports(banned, 'core/src/support/project-paths.server.ts'), []);
    assert.deepEqual(reports(banned, 'packages/live/src/plugin.ts'), []);
  });
});
