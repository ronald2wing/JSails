/**
 * The live corpus type-checks under the strictest app options with no
 * diagnostic, and a typo in a live action name is a TypeScript error at the
 * attribute that names it (sfc-plan SFC-05 exit): the schema-first
 * definition types the render tools by the component's own actions. A
 * condition the hoisted mount repeats is reported once.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { compileFixtureApp, type CompiledFixtureApp } from './compiled-fixture.js';
import { LIVE_APP, LIVE_RESOLVER, liveFile } from './live-corpus.js';

const apps: CompiledFixtureApp[] = [];

after(() => {
  for (const app of apps) app.dispose();
});

function compile(files: typeof LIVE_APP): CompiledFixtureApp {
  const app = compileFixtureApp(files, { resolver: LIVE_RESOLVER });
  apps.push(app);
  return app;
}

/** The 1-based line and column of `needle` in `text`. */
function positionOf(text: string, needle: string): { line: number; column: number } {
  const offset = text.indexOf(needle);
  assert.ok(offset >= 0, needle);
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: (before.at(-1) ?? '').length + 1 };
}

describe('the live corpus', () => {
  it('type-checks with no diagnostic', () => {
    const result = compile(LIVE_APP).typecheck();
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.unparsed, []);
    assert.equal(result.status, 0);
  });

  it('reports @submit="ad" at the action name in the attribute', () => {
    const taskList = liveFile('components/task-list.jsails');
    const source = taskList.source.replace('@submit="add"', '@submit="ad"');
    assert.notEqual(source, taskList.source);
    const files = LIVE_APP.map((file) => (file === taskList ? { ...file, source } : file));
    const result = compile(files).typecheck();
    assert.deepEqual(
      result.diagnostics.map((entry) => ({
        origin: entry.origin,
        file: entry.file,
        position: entry.position,
        code: entry.code,
      })),
      [
        {
          origin: 'source',
          file: 'components/task-list.jsails',
          position: positionOf(source, 'ad"'),
          code: 2345,
        },
      ],
    );
  });

  it('reports an error in a condition around a live tag once, where it is written', () => {
    const source =
      '<!-- A probe page. -->\n<script setup lang="ts">\nconst user = { name: \'a\' };\n</script>\n\n' +
      '<template>\n  <section js-if="user.nme"><TaskList /></section>\n</template>\n';
    const result = compile([...LIVE_APP, { path: 'pages/typo.jsails', source }]).typecheck();
    assert.deepEqual(
      result.diagnostics.map((entry) => ({
        file: entry.file,
        position: entry.position,
        code: entry.code,
      })),
      [{ file: 'pages/typo.jsails', position: positionOf(source, 'nme'), code: 2551 }],
    );
  });

  it('reports wrong action args and an unknown state field where they are written', () => {
    const taskList = liveFile('components/task-list.jsails');
    const source = taskList.source
      .replace('remove({ index })', 'remove({ position: index })')
      .replace('js-model.trim="title"', 'js-model.trim="titel"');
    const files = LIVE_APP.map((file) => (file === taskList ? { ...file, source } : file));
    const result = compile(files).typecheck();
    const located = result.diagnostics.map((entry) => ({
      origin: entry.origin,
      position: entry.position,
    }));
    assert.deepEqual(located, [
      { origin: 'source', position: positionOf(source, 'titel') },
      { origin: 'source', position: positionOf(source, 'position: index') },
    ]);
  });
});
