/**
 * Shared filesystem fixtures for the content tests.
 *
 * Every content test builds a throwaway content root, writes a map of
 * relative-path fixtures into it, and discovers a collection. The temp-dir
 * lifecycle and the write loop are identical across the suites; only the
 * fixture data differs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';

import {
  defineContentCollection,
  discoverContent,
  type ContentCollection,
  type ContentCollectionDescriptor,
} from '../src/index.js';

/** Create a fresh temp directory and register its cleanup on the test. */
export function tempRoot(t: TestContext, prefix = 'jsails-content-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a set of fixture files (paths relative to `root`, dirs created as needed). */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }
}

/** Build a collection in a temp dir from the given `.md` file map. */
export async function fixtureCollection(
  t: TestContext,
  files: Record<string, string>,
  prefix?: string,
): Promise<ContentCollection> {
  const root = tempRoot(t, prefix);
  writeFiles(root, files);
  return discoverContent(root);
}

/** A typed collection with dated, tagged posts, a draft, and an undated post. */
export async function postsCollection(
  t: TestContext,
): Promise<ContentCollectionDescriptor<Record<string, unknown>>> {
  const root = tempRoot(t);
  writeFiles(root, {
    'post-a.md': `---
title: Post A
date: 2026-10-05
order: 5
tags:
  - javascript
  - guide
---
# Post A Heading

This is the first paragraph of post A.

## Sub A

Second paragraph here with enough content so reading time is measurable.
More words. Still more words. Keep going. Almost there. One more sentence.
`,
    'post-b.md': `---
title: Post B
date: 2026-10-10
order: 1
tags:
  - typescript
  - guide
excerpt: Custom excerpt for B
---
# Post B Heading

Post B body content. Short.
`,
    'draft-post.md': `---
title: Draft Post
draft: true
date: 2026-10-15
tags:
  - draft
---
# Draft

This is a draft and must not appear in feeds, sitemap, or blogIndex.
`,
    'no-date.md': `---
title: No Date Post
order: 2
tags:
  - javascript
---
# No Date

A post with no date field. Much longer content here.
This has more words. And more. And more. And more. And more.
And more. And more. And more. And more. And more. And more.
`,
  });

  return defineContentCollection({
    dir: root,
    cacheDir: join(root, '.cache'),
  });
}

/** A typed collection whose single post has no `excerpt` field. */
export async function singlePostCollection(
  t: TestContext,
): Promise<ContentCollectionDescriptor<Record<string, unknown>>> {
  const root = tempRoot(t);
  writeFiles(root, {
    'single.md': `---
title: Single
date: 2026-10-01
---
# Single

First paragraph excerpt text here. More words follow.

Second paragraph.
`,
  });

  return defineContentCollection({
    dir: root,
    cacheDir: join(root, '.cache'),
  });
}
