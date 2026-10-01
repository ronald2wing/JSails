/**
 * Tests for the one-ambient-context fragment (`eslint/context.mjs`): the
 * repository config applies the ban to every shipped `src/` except the
 * context module and the data layer's own scopes, and planted code reports a
 * new `AsyncLocalStorage` in each form, and nothing for `snapshot()`.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import * as context from '../../eslint/context.mjs';
import { composeFragments } from '../eslint-fragments.mjs';
import { repoRoot } from '../workspaces.mjs';

const RULE = 'jsails/no-new-async-local-storage';

describe('repository config', () => {
  it('applies the ban to shipped sources outside the allow-list, not to tests', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const ruleState = async (file) => {
      const { rules } = await eslint.calculateConfigForFile(join(repoRoot, file));
      return rules[RULE]?.[0] ?? 0;
    };
    assert.equal(await ruleState('core/src/i18n/request-locale.ts'), 2);
    assert.equal(await ruleState('packages/tenancy/src/plugin.ts'), 2);
    assert.equal(await ruleState('core/src/context/execution-context.ts'), 0);
    assert.equal(await ruleState('core/src/database/transaction-scope.ts'), 0);
    assert.equal(await ruleState('packages/blog/src/cms/memory-repository.ts'), 0);
    assert.equal(await ruleState('core/test/context/execution-context.test.ts'), 0);
  });
});

describe('context fragment on planted code', () => {
  const cwd = join(repoRoot, 'plant');
  const config = [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ...composeFragments([
      {
        file: 'eslint/context.mjs',
        configs: context.default,
        restrictedSyntax: context.restrictedSyntax,
      },
    ]),
  ];

  /** `[line, rule]` for every report on `lines`, linted as `file`. */
  const reports = (lines, file = 'core/src/x.ts') =>
    new Linter({ cwd })
      .verify(lines.join('\n'), config, { filename: join(cwd, file) })
      .map((message) => [message.line, message.ruleId]);

  it('reports every way of creating another store', () => {
    const banned = [
      'const a = new AsyncLocalStorage<number>();',
      'const b = new hooks.AsyncLocalStorage();',
      "import { AsyncLocalStorage as Store } from 'node:async_hooks';",
      "const { AsyncLocalStorage: Store } = await import('node:async_hooks');",
      'const Store = AsyncLocalStorage;',
      'const Store = hooks.AsyncLocalStorage;',
    ];
    for (const line of banned) {
      assert.deepEqual(reports([line]), [[1, RULE]], line);
      assert.deepEqual(reports([line], 'packages/live/src/x.ts'), [[1, RULE]], line);
    }
  });

  it('allows snapshot() and the plain import', () => {
    assert.deepEqual(
      reports([
        "import { AsyncLocalStorage } from 'node:async_hooks';",
        'const run = AsyncLocalStorage.snapshot();',
      ]),
      [],
    );
  });

  it('allows a new store in the allow-listed modules only', () => {
    const line = 'const store = new AsyncLocalStorage();';
    assert.deepEqual(reports([line], 'core/src/context/execution-context.ts'), []);
    assert.deepEqual(reports([line], 'core/src/database/transaction-scope.ts'), []);
    assert.deepEqual(reports([line], 'core/src/context/carrier.ts'), [[1, RULE]]);
  });
});
