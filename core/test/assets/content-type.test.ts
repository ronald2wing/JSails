/**
 * The asset content type: the extension of the file's own name decides it,
 * case-insensitively; text types carry their charset, and anything else is
 * a download.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assetContentType } from '../../src/assets/content-type.js';

describe('assetContentType', () => {
  it('types a file by the extension of its name, in any case', () => {
    assert.equal(assetContentType('/app.css'), 'text/css; charset=utf-8');
    assert.equal(assetContentType('/scripts/app.MJS'), 'text/javascript; charset=utf-8');
    assert.equal(assetContentType('/favicon.ico'), 'image/x-icon');
    assert.equal(assetContentType('/fonts/inter.woff2'), 'font/woff2');
    assert.equal(assetContentType('/.well-known/security.txt'), 'text/plain; charset=utf-8');
    assert.equal(assetContentType('/archive.tar.gz'), 'application/gzip');
  });

  it('answers a name without a known extension as a download', () => {
    for (const path of ['/LICENSE', '/notes.unknown', '/dir.css/file', '/.css', '/file.']) {
      assert.equal(assetContentType(path), 'application/octet-stream', path);
    }
  });

  it('never takes a type from the object prototype', () => {
    assert.equal(assetContentType('/x.constructor'), 'application/octet-stream');
    assert.equal(assetContentType('/x.__proto__'), 'application/octet-stream');
  });
});
