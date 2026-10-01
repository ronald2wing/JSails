/**
 * Tests for the suite-concurrency fragment (`eslint/test-concurrency.mjs`):
 * the repository config applies the ban to every test tree and not to shipped
 * code, and planted suites report `concurrency: true` and nothing for a bound.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import * as fragment from '../../eslint/test-concurrency.mjs';
import { composeFragments } from '../eslint-fragments.mjs';
import { repoRoot } from '../workspaces.mjs';

const RULE = 'jsails/no-unbounded-test-concurrency';

describe('repository config', () => {
  it('applies the ban to test trees only', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const ruleState = async (file) => {
      const { rules } = await eslint.calculateConfigForFile(join(repoRoot, file));
      return rules[RULE]?.[0] ?? 0;
    };
    assert.equal(await ruleState('core/test/cli/cli.test.ts'), 2);
    assert.equal(await ruleState('packages/mcp/test/stdio.test.ts'), 2);
    assert.equal(await ruleState('scripts/test/lint.test.mjs'), 2);
    assert.equal(await ruleState('core/src/index.ts'), 0);
  });
});

describe('suite-concurrency fragment on planted code', () => {
  const cwd = join(repoRoot, 'plant');
  const config = [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ...composeFragments([
      {
        file: 'eslint/test-concurrency.mjs',
        configs: fragment.default,
        restrictedSyntax: fragment.restrictedSyntax,
      },
    ]),
  ];
  const reports = (lines, file = 'core/test/x.test.ts') =>
    new Linter({ cwd })
      .verify(lines.join('\n'), config, { filename: join(cwd, file) })
      .map((message) => [message.line, message.ruleId]);

  it('reports concurrency: true on a suite or a test', () => {
    assert.deepEqual(
      reports([
        "describe('a', { concurrency: true }, () => {});",
        "it('b', { timeout: 5, concurrency: true }, () => {});",
      ]),
      [
        [1, RULE],
        [2, RULE],
      ],
    );
  });

  it('accepts a bound', () => {
    assert.deepEqual(
      reports([
        "describe('a', { concurrency: 4 }, () => {});",
        "describe('b', { concurrency: CLI_SUITE_CONCURRENCY }, () => {});",
        "describe('c', { concurrency: false }, () => {});",
      ]),
      [],
    );
  });
});
