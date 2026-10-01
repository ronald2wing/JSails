/**
 * The corpus under the real TypeScript 7 compiler (docs/design/sfc.md §3,
 * §10): every `.jsails` file's shadow, with its bridge and the corpus's `.ts`
 * modules, type-checks under the strict options an app compiles with
 * (`noUncheckedIndexedAccess`, unused locals and parameters) with no
 * diagnostic at all, so the lowering emits nothing an app's own settings
 * reject. A fault planted in every file's template is then reported once per
 * file, at the exact `.jsails` line and column of the misspelt member, and
 * nothing is `internal`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileFixtureApp } from './compiled-fixture.js';
import { CORPUS_APP, CORPUS_RESOLVER } from './corpus.js';

const FAULT = '<i>{{ (1 as number).toFixd() }}</i>';

/** The 1-based `line:column` of `needle` in `text`. */
function at(text: string, needle: string): string {
  const offset = text.indexOf(needle);
  assert.ok(offset >= 0, needle);
  const before = text.slice(0, offset).split('\n');
  return `${before.length}:${(before.at(-1)?.length ?? 0) + 1}`;
}

/** `source` with the fault inserted as the last child of its template. */
function planted(source: string): string {
  const end = source.lastIndexOf('</template>');
  assert.ok(end >= 0);
  return `${source.slice(0, end)}${FAULT}\n${source.slice(end)}`;
}

describe('the corpus on TypeScript 7', () => {
  it('type-checks with no diagnostic under strict app options', () => {
    const app = compileFixtureApp(CORPUS_APP, { resolver: CORPUS_RESOLVER });
    try {
      const result = app.typecheck();
      assert.deepEqual(result.diagnostics, []);
      assert.deepEqual(result.unparsed, []);
      assert.equal(result.status, 0);
    } finally {
      app.dispose();
    }
  });

  it('reports a planted template fault in every file at its .jsails position', () => {
    const files = CORPUS_APP.map((file) =>
      file.path.endsWith('.jsails') ? { ...file, source: planted(file.source) } : file,
    );
    const app = compileFixtureApp(files, { resolver: CORPUS_RESOLVER });
    try {
      const result = app.typecheck();
      assert.deepEqual(result.unparsed, []);
      assert.deepEqual(
        result.diagnostics
          .map(
            (entry) =>
              `${entry.origin} ${entry.file}:${entry.position?.line}:${entry.position?.column} TS${entry.code}`,
          )
          .sort(),
        files
          .filter((file) => file.path.endsWith('.jsails'))
          .map((file) => `source ${file.path}:${at(file.source, 'toFixd')} TS2551`)
          .sort(),
      );
    } finally {
      app.dispose();
    }
  });
});
