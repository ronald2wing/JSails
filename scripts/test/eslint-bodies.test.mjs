/**
 * Tests for the request-body fragment (`eslint/bodies.mjs`): the repository
 * config applies the ban to shipped sources outside the form reader and the
 * hook routes pending their port, not to tests, and planted code reports a
 * buffered `formData()` or `parseBody()` and nothing for `ctx.body` readers.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import * as bodies from '../../eslint/bodies.mjs';
import { composeFragments } from '../eslint-fragments.mjs';
import { repoRoot } from '../workspaces.mjs';

const RULE = 'jsails/no-buffered-body-parse';

describe('repository config', () => {
  it('applies the ban to shipped sources outside the allow-list, not to tests', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const ruleState = async (file) => {
      const { rules } = await eslint.calculateConfigForFile(join(repoRoot, file));
      return rules[RULE]?.[0] ?? 0;
    };
    assert.equal(await ruleState('core/src/server/request-body.ts'), 2);
    assert.equal(await ruleState('packages/media/src/library.ts'), 2);
    assert.equal(await ruleState('core/src/api/forms.ts'), 0);
    assert.equal(await ruleState('core/test/server/multipart.test.ts'), 0);
  });
});

describe('request-body fragment on planted code', () => {
  const cwd = join(repoRoot, 'plant');
  const config = [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ...composeFragments([
      {
        file: 'eslint/bodies.mjs',
        configs: bodies.default,
        restrictedSyntax: bodies.restrictedSyntax,
      },
    ]),
  ];

  /** `[line, rule]` for every report on `lines`, linted as `file`. */
  const reports = (lines, file = 'core/src/x.ts') =>
    new Linter({ cwd })
      .verify(lines.join('\n'), config, { filename: join(cwd, file) })
      .map((message) => [message.line, message.ruleId]);

  it('reports each buffered parse', () => {
    for (const line of [
      'const form = await request.formData();',
      'const form = await request.clone().formData();',
      'const form = await c.req.parseBody();',
      'const form = await c.req.parseBody({ all: true });',
    ]) {
      assert.deepEqual(reports([line]), [[1, RULE]], line);
      assert.deepEqual(reports([line], 'packages/admin/src/x.ts'), [[1, RULE]], line);
    }
  });

  it('allows the ctx.body readers and building form data', () => {
    assert.deepEqual(
      reports([
        'const form = await ctx.body.form();',
        'for await (const part of ctx.body.multipart()) void part;',
        'const data = new FormData(element);',
      ]),
      [],
    );
  });

  it('allows the form reader only', () => {
    const line = 'const form = await request.formData();';
    assert.deepEqual(reports([line], 'core/src/api/forms.ts'), []);
    assert.deepEqual(reports([line], 'core/src/api/other.ts'), [[1, RULE]]);
  });
});
