/**
 * The stylesheet injection check, imported through the package barrel because
 * other renderers (the admin document) reuse it from there.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isSafeStylesheet } from '../src/index.js';

describe('isSafeStylesheet', () => {
  it('accepts a multi-line stylesheet with tabs and line breaks', () => {
    assert.equal(isSafeStylesheet(':root {\n\t--jsails-bg: #fff;\r\n}\n'), true);
  });

  it('refuses a sheet that would close its style element', () => {
    assert.equal(isSafeStylesheet('a{}</style><script>x()</script>'), false);
    assert.equal(isSafeStylesheet('a{}</STYLE >'), false);
  });

  it('refuses control characters other than tab, LF, and CR', () => {
    assert.equal(isSafeStylesheet('a{}\u0000'), false);
    assert.equal(isSafeStylesheet('a{}\u000b'), false);
    assert.equal(isSafeStylesheet('a{}\u007f'), false);
  });
});
