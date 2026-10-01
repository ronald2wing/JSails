/**
 * Tests for the bundler plugin wrapper around the component compiler: which files it transforms, the emitted code and source map, and how diagnostics surface as build errors.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { compilerPlugin, surfaceDiagnostics } from '../../src/compiler/compiler-plugin.js';
import {
  CompilerBuildError,
  CompilerError,
  type CompileDiagnostic,
} from '../../src/compiler/errors.js';

/** A warning-severity diagnostic fixture for the diagnostic-routing tests. */
const WARNING_DIAGNOSTIC: CompileDiagnostic = Object.freeze({
  severity: 'warning',
  code: 'unknown_directive',
  message: 'a warning',
  range: {
    start: { line: 1, column: 1 },
    end: { line: 1, column: 1 },
  },
  frame: '',
});

/** An error-severity diagnostic fixture for the diagnostic-routing tests. */
const ERROR_DIAGNOSTIC: CompileDiagnostic = Object.freeze({
  severity: 'error',
  code: 'unresolved_component',
  message: 'a failure',
  range: {
    start: { line: 2, column: 3 },
    end: { line: 2, column: 3 },
  },
  frame: '',
});

// Resolve the fixture from the repo root: templates are not copied into dist/.
const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const taskListFixture = readFileSync(
  join(packageRoot, 'templates/starter-web/components/task-list.tsx'),
  'utf-8',
);

const SYNTHETIC_COMPONENT = `// #region model
const stateSchema = 1;
// #endregion model

// #region server
// #endregion server

// #region style
const style = 1;
// #endregion style

// #region view
export const view = <form js-submit="add" />;
// #endregion view
`;

const MALFORMED_COMPONENT = `// #region model
// #endregion model
// #region model
// #endregion model
// #region server
// #endregion server
// #region style
// #endregion style
// #region view
// #endregion view
`;

describe('compilerPlugin', () => {
  it('has the expected plugin shape', () => {
    const plugin = compilerPlugin();
    assert.equal(plugin.name, 'jsails-component-compiler');
    assert.equal(plugin.enforce, 'pre');
    assert.equal(typeof plugin.transform, 'function');
    assert.equal(typeof plugin.resolveId, 'function');
    assert.equal(typeof plugin.load, 'function');
  });

  it('returns null for a .tsx id with no region markers', () => {
    const plugin = compilerPlugin();
    assert.equal(plugin.transform('export const x = 1;\n', 'plain.tsx'), null);
  });

  it('returns null for a CSS id', () => {
    const plugin = compilerPlugin();
    assert.equal(plugin.transform('// #region model\n', 'styles.css'), null);
  });

  it('returns null for a .ts id outside the default include', () => {
    const plugin = compilerPlugin();
    assert.equal(plugin.transform(SYNTHETIC_COMPONENT, 'component.ts'), null);
  });

  it('returns null for the shipped task-list fixture (no js-* directives)', () => {
    const plugin = compilerPlugin();
    assert.equal(plugin.transform(taskListFixture, 'task-list.tsx'), null);
  });

  it('lowers a js-submit directive in the view region', () => {
    const plugin = compilerPlugin();
    const result = plugin.transform(SYNTHETIC_COMPONENT, 'synthetic.tsx');
    assert.ok(result !== null);
    assert.ok(result.map !== null, 'expected a source map');
    assert.ok(result.code.includes("{...submit('add')}"));
  });

  it('lowers only real js-* attributes, never class names, data attributes, or text', () => {
    const component = SYNTHETIC_COMPONENT.replace(
      'export const view = <form js-submit="add" />;',
      'export const view = <div className="js-toggle" data-js-hook="x"><p js-submit="add">use js-ignore here</p></div>;',
    );
    const plugin = compilerPlugin();
    const result = plugin.transform(component, 'synthetic.tsx');
    assert.ok(result !== null);
    assert.match(result.code, /className="js-toggle" data-js-hook="x"/);
    assert.match(result.code, /<p \{\.\.\.submit\('add'\)\}>use js-ignore here<\/p>/);
  });

  it('passes a brace-valued directive through as an expression', () => {
    const component = SYNTHETIC_COMPONENT.replace('js-submit="add"', 'js-submit={action}');
    const plugin = compilerPlugin();
    const result = plugin.transform(component, 'synthetic.tsx');
    assert.ok(result !== null);
    assert.ok(result.code.includes('{...submit(action)}'));
  });

  it('keeps the model, server, and style regions of a component whose server region imports a .server module', () => {
    const component = `import { z } from 'zod';

// #region model
const stateSchema = z.object({ title: z.string() });
// #endregion model

// #region server
import { save } from './store.server.js';
export async function persist(title: string) {
  'use server';
  await save(title);
}
// #endregion server

// #region style
const style = 1;
// #endregion style

// #region view
export const view = defineComponent({ stateSchema, render: () => <form js-submit="add" /> });
// #endregion view
`;
    const plugin = compilerPlugin();
    const result = plugin.transform(component, 'split.tsx');
    assert.ok(result !== null);
    assert.match(result.code, /const stateSchema = z\.object/);
    assert.match(result.code, /import \{ z \} from 'zod';/);
    assert.match(result.code, /export async function persist/);
    assert.match(result.code, /const style = 1;/);
  });

  it('does not resolve tags the module already imports or declares', () => {
    const component = `import { Fragment } from 'preact';
import { Button } from '@acme/ui';

// #region model
// #endregion model

// #region server
// #endregion server

// #region style
// #endregion style

// #region view
const Row = () => <li />;
export const view = <Fragment><Button /><Row /></Fragment>;
// #endregion view
`;
    const plugin = compilerPlugin({ rootDir: mkdtempSync(join(tmpdir(), 'plugin-bound-')) });
    const result = plugin.transform(component, 'bound.tsx');
    // Nothing to lower once the tags are known to be bound: passed through.
    assert.ok(result === null || !/from '\.\.?\//.test(result.code));
  });

  it('leaves a tag the autoload registry provides to the autoload pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-autoload-tag-'));
    mkdirSync(join(root, 'ui'), { recursive: true });
    writeFileSync(join(root, 'ui', 'button.tsx'), 'export function Button() { return null; }\n');
    const component = SYNTHETIC_COMPONENT.replace(
      'export const view = <form js-submit="add" />;',
      'export const view = <Button />;',
    );
    try {
      const plugin = compilerPlugin({ rootDir: root });
      await plugin.buildStart();
      assert.doesNotThrow(() => plugin.transform(component, join(root, 'components', 'w.tsx')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws invalid_region for a malformed component', () => {
    const plugin = compilerPlugin();
    try {
      plugin.transform(MALFORMED_COMPONENT, 'malformed.tsx');
    } catch (error) {
      assert.ok(error instanceof CompilerError, `expected CompilerError, got ${String(error)}`);
      assert.equal(error.code, 'invalid_region');
      return;
    }
    assert.fail('expected CompilerError to be thrown');
  });

  it('resolves a capitalized tag to an import using rootDir', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-resolve-'));
    const componentsDir = join(root, 'app', 'components');
    mkdirSync(componentsDir, { recursive: true });
    writeFileSync(join(componentsDir, 'counter.tsx'), 'export const Counter = 1;');

    const component = `// #region model
// #endregion model

// #region server
// #endregion server

// #region style
// #endregion style

// #region view
export const view = <Counter />;
// #endregion view
`;

    try {
      const plugin = compilerPlugin({ rootDir: root });
      const result = plugin.transform(component, join(componentsDir, 'widget.tsx'));
      assert.ok(result !== null);
      assert.match(result.code, /import \{ Counter \} from '\.\/counter\.js';/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves a .jsails specifier against its importer to an absolute virtual id', async () => {
    const plugin = compilerPlugin({ rootDir: '/project' });
    assert.equal(
      await plugin.resolveId('./widget.jsails', '/project/app/pages/home.tsx'),
      '/project/app/pages/widget.jsails.tsx',
    );
    assert.equal(
      await plugin.resolveId('../shared/widget.jsails?import', '/project/app/pages/home.tsx'),
      '/project/app/shared/widget.jsails.tsx?import',
    );
    // Same specifier, different importers: two distinct modules.
    assert.notEqual(
      await plugin.resolveId('./widget.jsails', '/project/a/x.tsx'),
      await plugin.resolveId('./widget.jsails', '/project/b/x.tsx'),
    );
    assert.equal(await plugin.resolveId('./widget.jsails'), '/project/widget.jsails.tsx');
    assert.equal(await plugin.resolveId('./widget.tsx', '/project/x.tsx'), null);
  });

  it('loads the real .jsails file for its virtual id and watches it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-sfc-load-'));
    const file = join(root, 'widget.jsails');
    writeFileSync(file, '<script>export const x = 1;\n</script>\n<template><p>hi</p></template>');

    try {
      const plugin = compilerPlugin();
      const watched: string[] = [];
      const context = { addWatchFile: (id: string) => watched.push(id) };
      assert.equal(
        await plugin.load.call(context, `${file}.tsx`),
        '<script>export const x = 1;\n</script>\n<template><p>hi</p></template>',
      );
      assert.deepEqual(watched, [file]);
      assert.equal(await plugin.load(file), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('compiles a .jsails single-file component', () => {
    const sfc = [
      '<script>',
      "import { z } from 'zod';",
      'export const stateSchema = z.object({ title: z.string() });',
      'export const authorize = () => true;',
      '</script>',
      '<template>',
      '<p js-if="title">{{ title }}</p>',
      '</template>',
    ].join('\n');

    const plugin = compilerPlugin();
    const result = plugin.transform(sfc, 'widget.jsails.tsx');
    assert.ok(result !== null);
    assert.ok(result.map !== null, 'expected a source map');
    assert.match(result.code, /export const widget = defineComponent\(\{/);
    assert.match(result.code, /\{title \? \(<p>\{title\}<\/p>\) : null\}/);
  });

  it('imports the <style> body as a virtual CSS module the plugin loads', async () => {
    const sfc = [
      '<script>',
      'export const authorize = () => true;',
      '</script>',
      '<template>',
      '<p>hi</p>',
      '</template>',
      '<style>',
      '.card { @apply card; }',
      '</style>',
    ].join('\n');

    const root = mkdtempSync(join(tmpdir(), 'plugin-sfc-style-'));
    const file = join(root, 'widget.jsails');
    writeFileSync(file, sfc);
    try {
      const plugin = compilerPlugin();
      const result = plugin.transform(sfc, `${file}.tsx`);
      assert.ok(result !== null);
      const styleId = `${file}?jsails&type=style&lang.css`;
      assert.ok(result.code.includes(`import ${JSON.stringify(styleId)};`));
      assert.equal(await plugin.resolveId(styleId, `${file}.tsx`), styleId);
      assert.equal(await plugin.load(styleId), '.card { @apply card; }');
      // The CSS id is never compiled as a component.
      assert.equal(plugin.transform('.card {}', styleId), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits no style import when a .jsails component has no <style>', () => {
    const sfc = [
      '<script>',
      'export const authorize = () => true;',
      '</script>',
      '<template>',
      '<p>hi</p>',
      '</template>',
    ].join('\n');

    const plugin = compilerPlugin();
    const result = plugin.transform(sfc, 'widget.jsails.tsx');
    assert.ok(result !== null);
    assert.doesNotMatch(result.code, /lang\.css/);
  });

  it('stubs the <server> block in a client build and keeps it for a server build', () => {
    const sfc = [
      '<script>',
      'export const authorize = () => true;',
      '</script>',
      '<template>',
      '<p>hi</p>',
      '</template>',
      '<server>',
      "const SECRET = 'k-123';",
      'export async function load() { return db.query(SECRET); }',
      '</server>',
    ].join('\n');

    const client = compilerPlugin().transform(sfc, 'widget.jsails.tsx');
    assert.ok(client !== null);
    assert.doesNotMatch(client.code, /SECRET|db\.query/);
    assert.match(client.code, /async function load\(\) \{ throw new Error/);

    const server = compilerPlugin({ server: true }).transform(sfc, 'widget.jsails.tsx');
    assert.ok(server !== null);
    assert.match(server.code, /db\.query\(SECRET\)/);

    const ssr = compilerPlugin().transform(sfc, 'widget.jsails.tsx', { ssr: true });
    assert.ok(ssr !== null);
    assert.match(ssr.code, /db\.query\(SECRET\)/);
  });

  it('refuses client source maps with sources after compiling a <server> block', () => {
    const sfc = [
      '<script>',
      'export const authorize = () => true;',
      '</script>',
      '<template>',
      '<p>hi</p>',
      '</template>',
      '<server>',
      'export async function load() { return 1; }',
      '</server>',
    ].join('\n');
    const plugin = compilerPlugin();
    plugin.transform(sfc, 'widget.jsails.tsx');
    assert.throws(
      () => plugin.renderStart({ sourcemap: true }),
      (error: unknown) => error instanceof CompilerError && error.code === 'unsupported_sourcemap',
    );
    assert.doesNotThrow(() =>
      plugin.renderStart({ sourcemap: true, sourcemapExcludeSources: true }),
    );
    assert.doesNotThrow(() => plugin.renderStart({ sourcemap: false }));
  });

  it('keeps refusing source maps on a watch rebuild that reuses a cached <server> block', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jsails-compiler-watch-'));
    try {
      const client = [
        '<script>',
        'export const authorize = () => true;',
        '</script>',
        '<template>',
        '<p>hi</p>',
        '</template>',
      ];
      const sfc = [
        ...client,
        '<server>',
        'export async function load() { return 1; }',
        '</server>',
      ].join('\n');
      const plugin = compilerPlugin({ rootDir: root });
      plugin.transform(sfc, join(root, 'widget.jsails.tsx'));
      // The rebuild runs `buildStart` again but not `transform` for the
      // unchanged component, whose cached output the bundler reuses.
      await plugin.buildStart();
      await plugin.buildStart();
      assert.throws(
        () => plugin.renderStart({ sourcemap: true }),
        (error: unknown) =>
          error instanceof CompilerError && error.code === 'unsupported_sourcemap',
      );

      plugin.transform(client.join('\n'), join(root, 'widget.jsails.tsx'));
      assert.doesNotThrow(() => plugin.renderStart({ sourcemap: true }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws a value-free CompilerError for a malformed .jsails component', () => {
    const plugin = compilerPlugin();
    try {
      plugin.transform('<script>export const x = 1;\n</script>', 'widget.jsails.tsx');
    } catch (error) {
      assert.ok(error instanceof CompilerError, `expected CompilerError, got ${String(error)}`);
      assert.equal(error.code, 'missing_region');
      assert.equal(error.subject, 'template');
      return;
    }
    assert.fail('expected CompilerError to be thrown');
  });

  it('aborts the build with a positioned CompilerBuildError on error diagnostics', () => {
    const component = `// #region model
// #endregion model

// #region server
// #endregion server

// #region style
// #endregion style

// #region view
export const view = <Counter />;
// #endregion view
`;

    const plugin = compilerPlugin({ rootDir: tmpdir() });
    try {
      plugin.transform(component, join(tmpdir(), 'widget.tsx'));
    } catch (error) {
      assert.ok(
        error instanceof CompilerBuildError,
        `expected CompilerBuildError, got ${String(error)}`,
      );
      assert.equal(error.code, 'unresolved_component');
      assert.equal(error.loc.file, join(tmpdir(), 'widget.tsx'));
      assert.ok(error.loc.line >= 1);
      assert.ok(error.loc.column >= 1);
      assert.equal(error.diagnostics.length, 1);
      const [first] = error.diagnostics;
      assert.ok(first !== undefined);
      assert.equal(first.severity, 'error');
      assert.equal(first.code, 'unresolved_component');
      return;
    }
    assert.fail('expected CompilerBuildError to be thrown');
  });

  it('surfaces warnings through the warn callback without aborting', () => {
    const reported: string[] = [];
    surfaceDiagnostics('widget.tsx', [WARNING_DIAGNOSTIC], (message) => reported.push(message));
    assert.equal(reported.length, 1);
    assert.match(reported[0] ?? '', /widget\.tsx:1:1: warning\[unknown_directive\]: a warning/);
  });

  it('throws CompilerBuildError only for error-severity diagnostics', () => {
    assert.throws(
      () => surfaceDiagnostics('widget.tsx', [WARNING_DIAGNOSTIC, ERROR_DIAGNOSTIC]),
      (error: unknown) => {
        assert.ok(error instanceof CompilerBuildError);
        assert.equal(error.diagnostics.length, 1);
        assert.equal(error.diagnostics[0]?.severity, 'error');
        return true;
      },
    );
  });
});
