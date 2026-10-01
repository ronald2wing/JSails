/**
 * Audit regressions for file-based content (CNT-01): each test states the
 * correct behaviour for one audited defect. Those that fail today are listed,
 * with the failure they show, in `scripts/expected-failures/content.json`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { auditCase, tempDir } from 'jsails/testing';

import { discoverContent } from '../src/discovery.js';
import { ContentError } from '../src/errors.js';
import { renderAtomXml, renderRssXml } from '../src/feed.js';
import { createFileCache } from '../src/render-cache.js';

/** Characters XML 1.0 forbids anywhere in a document. */
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

test(
  ...auditCase(
    'content/duplicate-slug',
    'two pages that claim one slug fail discovery instead of one replacing the other',
  ),
  async (t) => {
    const root = tempDir(t, 'jsails-audit-content-');
    const pages = join(root, 'pages');
    mkdirSync(pages);
    writeFileSync(join(pages, 'a.md'), '---\ntitle: First\nslug: home\n---\n\nfirst\n');
    writeFileSync(join(pages, 'b.md'), '---\ntitle: Second\nslug: home\n---\n\nsecond\n');
    await assert.rejects(
      discoverContent(pages, { cacheDir: join(root, 'cache') }),
      ContentError,
      'one of the two pages silently vanished from the collection',
    );
  },
);

test(
  ...auditCase(
    'content/render-cache-collision',
    'the render cache never serves one file the HTML of another',
  ),
  (t) => {
    const cache = createFileCache(tempDir(t, 'jsails-audit-render-cache-'));
    // "Aa" and "BB" share a 31-multiplier string hash.
    cache.put('/site/pages/Aa.md', 1000, 10, { html: '<p>Aa</p>', toc: [] });
    assert.equal(
      cache.get('/site/pages/BB.md', 1000, 10),
      null,
      "BB.md was served Aa.md's cached HTML",
    );
  },
);

test(
  ...auditCase(
    'content/feed-xml-illegal-characters',
    'a feed never contains XML-illegal characters',
  ),
  () => {
    const channel = {
      title: 'Site',
      siteUrl: 'https://example.test',
      feedUrl: 'https://example.test/feed.xml',
    };
    const items = [{ title: 'Backspace\u0008in a title', url: 'https://example.test/a' }];
    for (const xml of [renderRssXml(channel, items), renderAtomXml(channel, items)]) {
      assert.doesNotMatch(xml, XML_ILLEGAL, 'one control character invalidates the whole feed');
    }
  },
);
