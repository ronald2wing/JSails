/**
 * Tests for the ioredis fragment (`eslint/valkey.mjs`): the repository config
 * applies the ban to every shipped `src/` except `core/src/valkey`, and planted
 * code reports each import form of `ioredis` and its subpaths, and nothing on
 * packages that merely share the prefix.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';

import * as valkey from '../../eslint/valkey.mjs';
import { composeFragments } from '../eslint-fragments.mjs';
import { repoRoot } from '../workspaces.mjs';

const RULE = 'jsails/no-ioredis-import';

describe('repository config', () => {
  it('applies the ban to shipped sources outside core/src/valkey, not to tests', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const ruleState = async (file) => {
      const { rules } = await eslint.calculateConfigForFile(join(repoRoot, file));
      return rules[RULE]?.[0] ?? 0;
    };
    assert.equal(await ruleState('core/src/broadcast/valkey-adapter.ts'), 2);
    assert.equal(await ruleState('packages/cache/src/plugin.ts'), 2);
    assert.equal(await ruleState('core/src/valkey/connections.ts'), 0);
    assert.equal(await ruleState('packages/live/test/valkey-change-log-live.test.ts'), 0);
  });
});

describe('ioredis fragment on planted code', () => {
  const cwd = join(repoRoot, 'plant');
  const config = [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ...composeFragments([
      {
        file: 'eslint/valkey.mjs',
        configs: valkey.default,
        restrictedSyntax: valkey.restrictedSyntax,
      },
    ]),
  ];

  /** `[line, rule]` for every report on `lines`, linted as `file`. */
  const reports = (lines, file = 'packages/cache/src/x.ts') =>
    new Linter({ cwd })
      .verify(lines.join('\n'), config, { filename: join(cwd, file) })
      .map((message) => [message.line, message.ruleId]);

  const banned = [
    "import 'ioredis';",
    "import { Redis } from 'ioredis';",
    "import type { RedisOptions } from 'ioredis';",
    "export { Redis } from 'ioredis';",
    "export * from 'ioredis';",
    "const module = await import('ioredis');",
    "const built = await import('ioredis/built/index.js');",
    "type Client = import('ioredis').Redis;",
    "const loaded = require('ioredis');",
  ];
  const allowed = [
    "import { Redis } from 'ioredis-mock';",
    "const module = await import('node:net');",
    "import type { ValkeyClient } from 'jsails/plugin-sdk';",
    "const other = require('ioredis-mock');",
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

  it('exempts core/src/valkey', () => {
    assert.deepEqual(reports(banned, 'core/src/valkey/connections.ts'), []);
  });
});
