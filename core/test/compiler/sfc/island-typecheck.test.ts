/**
 * The island corpus type-checks under the strictest app options with no
 * diagnostic, and the island seams are typed where they are written
 * (sfc-plan SFC-07 exit): a prop that cannot cross to the browser as JSON
 * (a function, a `Date`) is a TypeScript error on the island's tag, at
 * the attribute that passes it, a missing prop at the tag's name, an event the
 * island does not declare at the `emit` call, and a `js-model` whose target
 * holds the wrong type at the target's name.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { compileFixtureApp, type CompiledFixtureApp } from './compiled-fixture.js';
import { ISLAND_APP, ISLAND_RESOLVER } from './island-corpus.js';

const apps: CompiledFixtureApp[] = [];

after(() => {
  for (const app of apps) app.dispose();
});

/** The 1-based line and column of `needle` in `text`. */
function positionOf(text: string, needle: string): { line: number; column: number } {
  const offset = text.indexOf(needle);
  assert.ok(offset >= 0, needle);
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: (before.at(-1) ?? '').length + 1 };
}

/** The corpus with `path` replaced by `edit` of its source, and the edited source. */
function edited(
  path: string,
  edit: (source: string) => string,
): { files: typeof ISLAND_APP; source: string } {
  const file = ISLAND_APP.find((entry) => entry.path === path);
  assert.ok(file !== undefined, path);
  const source = edit(file.source);
  assert.notEqual(source, file.source);
  return {
    files: ISLAND_APP.map((entry) => (entry === file ? { ...entry, source } : entry)),
    source,
  };
}

/** Where `tsc` reports errors over `files`, remapped. */
function located(
  files: typeof ISLAND_APP,
): { file: string | null; line: number; column: number }[] {
  const app = compileFixtureApp(files, { resolver: ISLAND_RESOLVER });
  apps.push(app);
  const result = app.typecheck();
  assert.deepEqual(result.unparsed, []);
  return result.diagnostics.map((entry) => {
    assert.equal(entry.origin, 'source', entry.message);
    assert.ok(entry.position !== null);
    return { file: entry.file, line: entry.position.line, column: entry.position.column };
  });
}

describe('the island corpus', () => {
  it('type-checks with no diagnostic', () => {
    const app = compileFixtureApp(ISLAND_APP, { resolver: ISLAND_RESOLVER });
    apps.push(app);
    const result = app.typecheck();
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.unparsed, []);
    assert.equal(result.status, 0);
  });

  it('reports a function prop and a Date prop at the attributes that pass them', () => {
    const { files, source } = edited('pages/index.jsails', (text) =>
      text
        .replace(':start="0" label="Clicks"', ':start="() => 0" label="Clicks"')
        .replace('title="Details"', ':title="new Date()"'),
    );
    const page = 'pages/index.jsails';
    assert.deepEqual(located(files), [
      { file: page, ...positionOf(source, '() => 0"') },
      { file: page, ...positionOf(source, 'title="new Date()"') },
    ]);
  });

  it("reports a missing prop at the island tag's name", () => {
    const { files, source } = edited('pages/index.jsails', (text) =>
      text.replace('<TogglePanel title="Details" />', '<TogglePanel />'),
    );
    assert.deepEqual(located(files), [
      { file: 'pages/index.jsails', ...positionOf(source, 'TogglePanel />') },
    ]);
  });

  it('reports an undeclared event at the emit call, and a mistyped model at its target', () => {
    const { files, source } = edited('islands/counter.jsails', (text) =>
      text
        .replace("emit('change', this.count.value)", "emit('chnage', this.count.value)")
        .replace(
          '<input type="number" js-model="count"',
          '<input type="checkbox" js-model="count"',
        ),
    );
    const counter = 'islands/counter.jsails';
    assert.deepEqual(
      located(files).sort((a, b) => a.line - b.line),
      [
        { file: counter, ...positionOf(source, "'chnage'") },
        { file: counter, ...positionOf(source, 'count" @input') },
      ],
    );
  });

  it('reports a handler that takes something else than the event at the handler, called on the event or not', () => {
    const { files, source } = edited('islands/counter.jsails', (text) =>
      text
        .replace('add(): void {', 'add(by: string): void {\n    void by;')
        .replace('function reset(): void {', 'function reset(to: string): void {\n  void to;'),
    );
    const counter = 'islands/counter.jsails';
    assert.deepEqual(
      located(files).sort((a, b) => a.line - b.line),
      [
        { file: counter, ...positionOf(source, 'clicks.add"') },
        { file: counter, ...positionOf(source, 'reset">') },
      ],
    );
  });

  it("types a model's own handler by the element, as its prop would be", () => {
    const element = edited('islands/toggle-panel.jsails', (text) =>
      text.replace('$event.currentTarget.checked', '$event.currentTarget.validity.valid'),
    );
    assert.deepEqual(located(element.files), []);
    const { files, source } = edited('islands/toggle-panel.jsails', (text) =>
      text.replace('$event.currentTarget.checked', '$event.currentTarget.chekced'),
    );
    assert.deepEqual(located(files), [
      { file: 'islands/toggle-panel.jsails', ...positionOf(source, 'chekced') },
    ]);
  });
});
