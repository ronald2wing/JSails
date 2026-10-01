/**
 * The corpus app is in the repository's style: Prettier, with the
 * repository's configuration and the `vue` parser that formats `.jsails`
 * files (docs/design/sfc.md §5), leaves every `.jsails` file of
 * `fixtures/app/` as it is. Otherwise `npm run format` would rewrite the
 * corpus under the twin, parity, typecheck and map tests, which read it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';

import { CORPUS_ROOT, SFC_CORPUS } from './corpus.js';

describe('the .jsails corpus', () => {
  it('is formatted as Prettier formats a .jsails file', async () => {
    for (const file of SFC_CORPUS) {
      const filepath = fileURLToPath(new URL(file.path, CORPUS_ROOT));
      const options = await prettier.resolveConfig(filepath);
      const formatted = await prettier.format(file.source, {
        ...options,
        filepath,
        parser: 'vue',
      });
      assert.equal(formatted, file.source, file.path);
    }
  });
});
