/**
 * The kept app config schema is fully typed: no opaque field. The one custom
 * schema is the plugin-instance check on `plugins.use`, which recognises an
 * instance by its brand.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appConfigSchema } from '../../../src/app/config/schema.js';
import { checkOptionSchema } from '../../../src/plugins/contract/option-schemas.js';

describe('appConfigSchema', () => {
  it('holds no z.unknown, z.any or unsanctioned custom schema but the instance check', () => {
    assert.deepEqual(checkOptionSchema(appConfigSchema), [
      { path: ['plugins', 'use', '[]'], construct: 'custom' },
    ]);
  });
});
