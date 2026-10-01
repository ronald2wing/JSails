/**
 * Tests for `jsails convert` (`runConvertCommand`): every corpus component
 * toggled to a folder whose files Prettier leaves as they are and back to the
 * same bytes, the server module moved with its specifiers, a folder named by
 * its directory or its template file, each refusal (with the diagnostics that
 * explain it, and nothing written), a folder made only in a project that
 * syncs sidecars, an existing target never overwritten, and the usage
 * errors.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import * as prettier from 'prettier';

import { dispatch } from '../../../src/cli/dispatch.js';
import { SFC_CORPUS } from '../../compiler/sfc/corpus.js';
import { LIVE_SFC } from '../../compiler/sfc/live-corpus.js';

// Inside the checkout, so Prettier resolves the repository's configuration.
const tmpRoot = mkdtempSync(join(fileURLToPath(new URL('../..', import.meta.url)), 'convert-'));

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let sequence = 0;

/**
 * A project holding `files`; one that syncs `.jsails` sidecars (has
 * `.jsails/sfc`, which `snapshot` does not list while it is empty) unless
 * `synced` is false.
 */
function project(files: Readonly<Record<string, string>>, synced = true): string {
  const root = join(tmpRoot, `app-${sequence++}`);
  mkdirSync(synced ? join(root, '.jsails', 'sfc') : root, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return root;
}

/** Every file under `root`, as sorted posix paths with their texts. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), path);
      else out[path] = readFileSync(join(directory, entry.name), 'utf8');
    }
  };
  walk(root, '');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Run `jsails convert ...args` through the dispatcher, in `root`. */
async function convert(
  root: string,
  ...args: string[]
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await dispatch(['convert', ...args], {
    cwd: root,
    stdout: (text) => stdout.push(...text.replace(/\n$/, '').split('\n')),
    stderr: (line) => stderr.push(line),
  });
  return { code, stdout, stderr };
}

const PARSERS: Readonly<Record<string, string>> = { jsails: 'vue', ts: 'typescript', css: 'css' };

describe('jsails convert', () => {
  it('toggles every corpus component to a Prettier-clean folder and back to the same bytes', async () => {
    for (const { path, source } of [...SFC_CORPUS, ...LIVE_SFC]) {
      const root = project({ [path]: source });
      const there = await convert(root, path);
      assert.equal(there.code, 0, there.stderr.join('\n'));
      const folder = snapshot(root);
      assert.equal(folder[path], undefined);
      const stem = path.slice(path.lastIndexOf('/') + 1, -'.jsails'.length);
      for (const [file, text] of Object.entries(folder)) {
        assert.ok(file.startsWith(`${path.slice(0, -'.jsails'.length)}/${stem}.`), file);
        const parser = PARSERS[file.slice(file.lastIndexOf('.') + 1)];
        assert.ok(parser !== undefined, file);
        const filepath = join(root, ...file.split('/'));
        const options = await prettier.resolveConfig(filepath);
        assert.equal(await prettier.format(text, { ...options, filepath, parser }), text, file);
      }
      const back = await convert(root, path.slice(0, -'.jsails'.length));
      assert.equal(back.code, 0, back.stderr.join('\n'));
      assert.deepEqual(snapshot(root), { [path]: source }, path);
    }
  });

  it('moves the server module with the component, its specifiers following it', async () => {
    const server =
      "import { posts } from '../../shared/posts.js';\nexport const count = posts.length;\n";
    const source =
      '<script lang="ts">\nimport { count } from \'./post.server.js\';\nexport const n = count;\n</script>\n\n<template>\n  <p>{{ n }}</p>\n</template>\n';
    const root = project({ 'pages/blog/post.jsails': source, 'pages/blog/post.server.ts': server });
    const there = await convert(root, 'pages/blog/post.jsails');
    assert.equal(there.code, 0);
    assert.deepEqual(snapshot(root), {
      'pages/blog/post/post.jsails': '<template>\n  <p>{{ n }}</p>\n</template>\n',
      'pages/blog/post/post.server.ts':
        "import { posts } from '../../../shared/posts.js';\nexport const count = posts.length;\n",
      'pages/blog/post/post.ts':
        "import { count } from './post.server.js';\nexport const n = count;\n",
    });
    assert.deepEqual(there.stdout, [
      'Converted pages/blog/post.jsails into the folder post/',
      'Created pages/blog/post/post.jsails',
      'Created pages/blog/post/post.ts',
      'Created pages/blog/post/post.server.ts',
      'Removed pages/blog/post.jsails',
      'Removed pages/blog/post.server.ts',
    ]);
    const back = await convert(root, 'pages/blog/post/post.jsails');
    assert.equal(back.code, 0);
    assert.deepEqual(snapshot(root), {
      'pages/blog/post.jsails': source,
      'pages/blog/post.server.ts': server,
    });
    assert.equal(existsSync(join(root, 'pages', 'blog', 'post')), false, 'the empty folder goes');
  });

  it('moves only the server module, not a sibling whose name starts like it', async () => {
    const source =
      "<script lang=\"ts\">\nimport type { Post } from './post.server.types.js';\nimport { count } from './post.server.js';\nexport const n: Post['id'] = count;\n</script>\n\n<template>\n  <p>{{ n }}</p>\n</template>\n";
    const files = {
      'pages/blog/post.jsails': source,
      'pages/blog/post.server.ts': 'export const count = 1;\n',
      'pages/blog/post.server.types.ts': 'export interface Post {\n  id: number;\n}\n',
    };
    const root = project(files);
    const there = await convert(root, 'pages/blog/post.jsails');
    assert.equal(there.code, 0, there.stderr.join('\n'));
    const folder = snapshot(root);
    assert.equal(
      folder['pages/blog/post/post.ts'],
      "import type { Post } from '../post.server.types.js';\nimport { count } from './post.server.js';\nexport const n: Post['id'] = count;\n",
    );
    assert.equal(
      folder['pages/blog/post.server.types.ts'],
      files['pages/blog/post.server.types.ts'],
    );
    assert.equal(folder['pages/blog/post/post.server.ts'], files['pages/blog/post.server.ts']);
    const back = await convert(root, 'pages/blog/post');
    assert.equal(back.code, 0, back.stderr.join('\n'));
    assert.deepEqual(snapshot(root), files);
  });

  it('refuses a folder whose script or style file would end its block in one file', async () => {
    const files = {
      'components/x/x.jsails': '<template>\n  <p>{{ html }}</p>\n</template>\n',
      'components/x/x.ts':
        "export const html = '<b></b>';\n// end tag: </script>\nexport const n = 1;\n",
      'components/x/x.css': 'p {\n  color: red;\n} /* </STYLE > */\n',
    };
    const root = project(files);
    const result = await convert(root, 'components/x');
    assert.equal(result.code, 1);
    assert.deepEqual(result.stderr, [
      'jsails convert: a script or style file of components/x holds </script or </style, which would end its block in one file',
      'Split each such end tag (<\\/script> in a string), then convert',
      '  components/x/x.ts:2:13 sfc.raw_text_end_tag This text ends a <script> block in one file; split the end tag, as in <\\/script>',
      '  components/x/x.css:3:6 sfc.raw_text_end_tag This text ends a <style> block in one file; split the end tag, as in <\\/style>',
    ]);
    assert.deepEqual(snapshot(root), files);
  });

  it('makes a folder only in a project that syncs sidecars, and a file anywhere', async () => {
    const files = { 'pages/about.jsails': '<template><p /></template>\n' };
    const root = project(files, false);
    const refused = await convert(root, 'pages/about.jsails');
    assert.equal(refused.code, 1);
    assert.deepEqual(refused.stderr, [
      'jsails convert: this project does not sync .jsails sidecars (.jsails/sfc), which a component folder needs',
    ]);
    assert.deepEqual(snapshot(root), files);

    const folder = { 'pages/team/team.jsails': '<template><p /></template>\n' };
    const unsynced = project(folder, false);
    const joined = await convert(unsynced, 'pages/team');
    assert.equal(joined.code, 0, joined.stderr.join('\n'));
    assert.deepEqual(snapshot(unsynced), { 'pages/team.jsails': folder['pages/team/team.jsails'] });
  });

  it('keeps a file it does not own in the folder, and the folder with it', async () => {
    const root = project({
      'ui/card/card.jsails': '<template><p /></template>\n',
      'ui/card/notes.md': 'notes\n',
    });
    const result = await convert(root, 'ui/card');
    assert.equal(result.code, 0);
    assert.deepEqual(snapshot(root), {
      'ui/card.jsails': '<template><p /></template>\n',
      'ui/card/notes.md': 'notes\n',
    });
  });

  it('refuses two styles of one kind, printing the diagnostics, and writes nothing', async () => {
    const files = {
      'ui/x.jsails':
        '<template><p /></template>\n\n<style>\na {}\n</style>\n\n<style>\nb {}\n</style>\n',
    };
    const root = project(files);
    const result = await convert(root, 'ui/x.jsails');
    assert.equal(result.code, 1);
    assert.equal(
      result.stderr[0],
      'jsails convert: ui/x.jsails has more than one <style> or <style scoped>; a folder holds one of each',
    );
    assert.equal(result.stderr[1], 'Merge the style blocks of each kind into one, then convert');
    assert.match(result.stderr[2] ?? '', /^ {2}ui\/x\.jsails:\d+:\d+ sfc\./);
    assert.deepEqual(snapshot(root), files);
  });

  it('refuses a script that does not parse, and a folder whose template file holds a <style>', async () => {
    const broken = {
      'ui/x.jsails': '<script lang="ts">\nimport from;\n</script>\n\n<template><p /></template>\n',
    };
    const brokenRoot = project(broken);
    const syntax = await convert(brokenRoot, 'ui/x.jsails');
    assert.equal(syntax.code, 1);
    assert.match(syntax.stderr[0] ?? '', /a script of ui\/x\.jsails is not valid TypeScript/);
    assert.deepEqual(snapshot(brokenRoot), broken);

    const misplaced = {
      'ui/y/y.jsails': '<template><p /></template>\n\n<style>\np {}\n</style>\n',
    };
    const misplacedRoot = project(misplaced);
    const folder = await convert(misplacedRoot, 'ui/y');
    assert.equal(folder.code, 1);
    assert.match(folder.stderr[0] ?? '', /the template file of ui\/y holds a <script> or <style>/);
    assert.deepEqual(folder.stderr.slice(1), [
      '  ui/y/y.jsails:3:1 sfc.folder_block In a component folder, <style> is the file x.css and <style scoped> the file x.scoped.css',
    ]);
    assert.deepEqual(snapshot(misplacedRoot), misplaced);
  });

  it('never overwrites a target, in either direction', async () => {
    const both = {
      'ui/x.jsails': '<template><p>file</p></template>\n',
      'ui/x/x.jsails': '<template><p>folder</p></template>\n',
    };
    for (const target of ['ui/x.jsails', 'ui/x']) {
      const root = project(both);
      const result = await convert(root, target);
      assert.equal(result.code, 1);
      assert.match(
        result.stderr[0] ?? '',
        /^jsails convert: refusing to overwrite existing file ui\/x/,
      );
      assert.deepEqual(snapshot(root), both);
    }
  });

  it('refuses a path that is not a component', async () => {
    const root = project({ 'ui/x.ts': 'export {};\n', 'ui/empty/readme.md': '\n' });
    for (const target of ['ui/x.ts', 'ui/missing.jsails', 'ui/empty']) {
      const result = await convert(root, target);
      assert.equal(result.code, 1);
      assert.equal(
        result.stderr[0],
        `jsails convert: ${target} is not a .jsails component file or folder`,
      );
    }
  });

  it('reports usage errors with exit code 2, and prints its help', async () => {
    const root = project({});
    for (const args of [[], ['a.jsails', 'b.jsails'], ['--force', 'a.jsails']]) {
      const result = await convert(root, ...args);
      assert.equal(result.code, 2);
      assert.equal(result.stderr.at(-1), 'Run "jsails convert --help" for usage.');
    }
    const help = await convert(root, '--help');
    assert.equal(help.code, 0);
    assert.match(help.stdout[0] ?? '', /^jsails convert - Toggle a \.jsails component/);
  });
});
