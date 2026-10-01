/** Tests for the plugin-leaks gate's verdicts, violation ids and fixture tables. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KERNEL_FIXTURES, LEGACY_FIXTURES, verdict, violationId } from '../gates/plugin-leaks.mjs';
import { inventory } from '../gates/unconverted-plugins.mjs';
import { repoRoot } from '../workspaces.mjs';

describe('plugin-leaks', () => {
  it('names a violation by source file and plugin', () => {
    assert.equal(
      violationId('core/src/valkey/plugin.ts', 'valkey'),
      'core/src/valkey/plugin.ts (valkey)',
    );
  });

  it('passes a report without a leak and names each kind that grew', () => {
    assert.equal(
      verdict({ cycles: 50, growth: { 'resource:Timeout': 1 }, leaked: false }),
      undefined,
    );
    assert.equal(
      verdict({
        cycles: 50,
        growth: { 'resource:Timeout': 50, 'listener:SIGTERM': 50 },
        leaked: true,
      }),
      'leaks over 50 cycles: resource:Timeout +50, listener:SIGTERM +50',
    );
  });

  it('has a fixture for exactly the legacy declarations, so none goes unmeasured', () => {
    const legacy = inventory(repoRoot)
      .filter((entry) => entry.contract === 'legacy')
      .map((entry) => entry.file)
      .sort();
    assert.deepEqual(Object.keys(LEGACY_FIXTURES).sort(), legacy);
    for (const fixture of Object.values(LEGACY_FIXTURES)) {
      assert.match(fixture.factory, /^[a-z][A-Za-z]*Plugin$/);
    }
  });

  it('loads companions and option modules only from built modules of the repository', () => {
    const builtPath = /^(core|packages\/[^/]+)\/dist\/src\/.+\.js$/;
    for (const fixture of [...Object.values(KERNEL_FIXTURES), ...Object.values(LEGACY_FIXTURES)]) {
      for (const companion of fixture.with ?? []) {
        assert.match(companion.module, builtPath);
        for (const path of Object.values(companion.modules ?? {})) assert.match(path, builtPath);
      }
      for (const path of Object.values(fixture.modules ?? {})) assert.match(path, builtPath);
    }
  });
});
