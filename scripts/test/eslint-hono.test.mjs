/**
 * Tests for the Hono fragment (`eslint/hono.mjs`): the repository config
 * applies the ban to every shipped `src/` outside the allowlisted server
 * modules, planted code reports each import form of `hono` and its subpaths
 * (the `hono/utils/mime` table included) and nothing on other packages, and
 * the allowlist is exact: every entry is a file in the tree that still imports
 * Hono, so a module that moves, is deleted or stops importing it takes its
 * entry with it and the list only shrinks.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import * as hono from '../../eslint/hono.mjs';
import { composeFragments } from '../eslint-fragments.mjs';
import { repoRoot } from '../workspaces.mjs';

const RULE = 'jsails/no-hono-import';

const [ban] = hono.restrictedSyntax;

/** The fragment's ban, composed with `ignores` replaced (`undefined`: every file is judged). */
const fragmentConfig = (cwd, ignores) => [
  { files: ['**/*.ts', '**/*.tsx'], languageOptions: { parser: tseslint.parser } },
  ...composeFragments([
    {
      file: 'eslint/hono.mjs',
      configs: hono.default,
      restrictedSyntax: [{ ...ban, ignores }],
    },
  ]),
];

describe('repository config', () => {
  it('applies the ban to shipped sources outside the allowlist, not to tests', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const ruleState = async (file) => {
      const { rules } = await eslint.calculateConfigForFile(join(repoRoot, file));
      return rules[RULE]?.[0] ?? 0;
    };
    assert.equal(await ruleState('core/src/assets/responder.ts'), 2);
    assert.equal(await ruleState('core/src/server/page-routes.ts'), 2);
    assert.equal(await ruleState('packages/admin/src/plugin.ts'), 2);
    assert.equal(await ruleState('core/src/server/route-table.ts'), 0);
    assert.equal(await ruleState('core/test/server/app.test.ts'), 0);
    assert.equal(await ruleState('packages/admin/test/fixtures.ts'), 0);
  });
});

describe('hono fragment on planted code', () => {
  const cwd = join(repoRoot, 'plant');
  const config = fragmentConfig(cwd, ban.ignores);

  /** `[line, rule]` for every report on `lines`, linted as `file`. */
  const reports = (lines, file = 'core/src/assets/x.ts') =>
    new Linter({ cwd })
      .verify(lines.join('\n'), config, { filename: join(cwd, file) })
      .map((message) => [message.line, message.ruleId]);

  const banned = [
    "import 'hono';",
    "import { Hono } from 'hono';",
    "import type { Context } from 'hono';",
    "import { getMimeType } from 'hono/utils/mime';",
    "export { Hono } from 'hono';",
    "export * from 'hono/http-exception';",
    "const module = await import('hono');",
    "type Handler = import('hono').Handler;",
    "const loaded = require('hono/utils/mime');",
  ];
  const allowed = [
    "import { serve } from '@hono/node-server';",
    "import { honorific } from 'honorific';",
    "import { Respond } from 'jsails/api';",
    "const other = require('hono-sessions');",
  ];

  it('reports every banned form once', () => {
    assert.deepEqual(
      reports(banned),
      banned.map((_, index) => [index + 1, RULE]),
    );
  });

  it('reports nothing on other packages', () => {
    assert.deepEqual(reports(allowed), []);
  });

  it('reports a package source too', () => {
    assert.deepEqual(reports(banned.slice(0, 1), 'packages/admin/src/x.ts'), [[1, RULE]]);
  });

  it('exempts the allowlisted server modules', () => {
    assert.deepEqual(reports(banned, 'core/src/server/route-table.ts'), []);
  });
});

describe('the allowlist', () => {
  it('names each module once', () => {
    assert.deepEqual([...new Set(ban.ignores)], ban.ignores);
  });

  for (const file of ban.ignores) {
    it(`${file} exists and still imports hono`, () => {
      assert.ok(existsSync(join(repoRoot, file)), `${file} is gone: drop it from HONO_MODULES`);
      const messages = new Linter({ cwd: repoRoot }).verify(
        readFileSync(join(repoRoot, file), 'utf8'),
        fragmentConfig(repoRoot, undefined),
        { filename: join(repoRoot, file) },
      );
      assert.deepEqual(
        messages.filter((message) => message.fatal === true),
        [],
        `${file} parses`,
      );
      assert.ok(
        messages.some((message) => message.ruleId === RULE),
        `${file} no longer imports hono: drop it from HONO_MODULES`,
      );
    });
  }
});
