/**
 * `'use server'` source-transform tests (Node-import safe).
 *
 * These tests exercise the pure `source -> source` rewrite. The compiler API is
 * the only dependency; no bundler is loaded, so the suite runs under plain Node.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ServerDirectiveError,
  isServerOnlyModuleId,
  serverDirectivePlugin,
  stripServerDirectives,
  stubServerOnlyModule,
} from '../../src/build/index.js';

describe('stripServerDirectives', () => {
  it('leaves a module with no directive byte-identical', () => {
    const source = 'export const value = 1;\n';
    const result = stripServerDirectives(source, 'plain.ts');

    assert.equal(result.code, source);
    assert.equal(result.hadDirective, false);
    assert.deepEqual(result.stubbed, []);
  });

  it('refuses a function-level directive that would leave module code in the client', () => {
    const source = [
      "import { db } from './db.server.js';",
      "const API_KEY = 'sk-live-123';",
      '',
      'export async function persist(title: string): Promise<void> {',
      "  'use server';",
      '  await db.insert(API_KEY, title);',
      '}',
      '',
      'export function clientSafe(x: number): number { return x + 1; }',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'mixed.tsx'),
      (error: unknown) =>
        error instanceof ServerDirectiveError &&
        error.code === 'unsupported_position' &&
        error.subject === 'persist' &&
        /move the function into a module whose first statement is 'use server'/.test(
          error.message,
        ) &&
        !/API_KEY|sk-live|db\.insert/.test(error.message),
    );
  });

  for (const [label, source] of [
    [
      'an exported const arrow',
      "export const add = async (t: string) => {\n  'use server';\n  await save(t);\n};\n",
    ],
    [
      'an exported function expression',
      "export const persist = async function (t: string) {\n  'use server';\n  await save(t);\n};\n",
    ],
    [
      'several declarators and a default arrow',
      "export const a = () => { 'use server'; return one(); };\nexport default async () => { 'use server'; return three(); };\n",
    ],
  ] as const) {
    it(`refuses a function-level directive on ${label}`, () => {
      assert.throws(
        () => stripServerDirectives(source, 'fn-level.ts'),
        (error: unknown) =>
          error instanceof ServerDirectiveError && error.code === 'unsupported_position',
      );
    });
  }

  it('stubs every exported function on a file-level directive', () => {
    const source = [
      "'use server';",
      'export async function a() { return read(); }',
      'export const b = async () => { return read2(); };',
      'export function c() { return 3; }',
      '',
    ].join('\n');

    const result = stripServerDirectives(source, 'server.ts');

    assert.equal(result.hadDirective, true);
    assert.deepEqual(result.stubbed, ['a', 'b', 'c']);
    assert.doesNotMatch(result.code, /read\(\)|read2\(\)|return 3/);
    assert.match(result.code, /export \{ a, b, c \};/);
  });

  it('stubs an expression-bodied arrow under a file-level directive', () => {
    const source = [
      "'use server';",
      "export const getUser = async (id: string) => db.query('select secret', id);",
      '',
    ].join('\n');

    const result = stripServerDirectives(source, 'expr-body.ts');

    assert.deepEqual(result.stubbed, ['getUser']);
    assert.doesNotMatch(result.code, /db\.query|secret/);
    assert.match(result.code, /async function getUser\(\) \{ throw new Error/);
  });

  it('stubs every declarator of a multi-declarator export', () => {
    const source = [
      "'use server';",
      'export const a = () => { return one(); }, b = () => { return leakTwo(); };',
      '',
    ].join('\n');

    const result = stripServerDirectives(source, 'multi.ts');

    assert.deepEqual(result.stubbed, ['a', 'b']);
    assert.doesNotMatch(result.code, /one\(\)|leakTwo/);
  });

  it('stubs an anonymous default arrow and a default function expression', () => {
    const arrow = ["'use server';", 'export default async () => { return leak(); };', ''].join(
      '\n',
    );
    const arrowResult = stripServerDirectives(arrow, 'default-arrow.ts');
    assert.deepEqual(arrowResult.stubbed, ['default']);
    assert.doesNotMatch(arrowResult.code, /leak/);
    assert.match(arrowResult.code, /export default async function \(\) \{ throw/);

    const named = ["'use server';", 'export default function run() { return leak(); }', ''].join(
      '\n',
    );
    const namedResult = stripServerDirectives(named, 'default-named.ts');
    assert.deepEqual(namedResult.stubbed, ['default']);
    assert.doesNotMatch(namedResult.code, /leak/);
    assert.match(namedResult.code, /export \{ run as default \};/);
  });

  it('resolves local export specifiers and default identifiers to stubs', () => {
    const source = [
      "'use server';",
      "import { db } from './db.js';",
      "const SECRET = 'k-123';",
      'function f() { return db.query(SECRET); }',
      'const g = async () => db.write(SECRET);',
      'export { f, g as renamed };',
      'export default f;',
      '',
    ].join('\n');

    const result = stripServerDirectives(source, 'specifiers.ts');

    assert.deepEqual(result.stubbed, ['default', 'f', 'renamed']);
    assert.doesNotMatch(result.code, /SECRET|k-123|db\.|from '\.\/db\.js'/);
    assert.match(result.code, /export \{ f, g as renamed, f as default \};/);
  });

  it('drops type-only exports and keeps the module importable', () => {
    const source = [
      "'use server';",
      'export interface Row { id: string }',
      'export type Id = string;',
      'export declare const ambient: number;',
      "export type { Other } from './other.js';",
      'export function load(): Row { return { id: secret() }; }',
      '',
    ].join('\n');

    const result = stripServerDirectives(source, 'types.ts');

    assert.deepEqual(result.stubbed, ['load']);
    assert.doesNotMatch(result.code, /secret|interface|other\.js/);
  });

  for (const [label, line] of [
    ['a constant', 'export const notAFunction = 42;'],
    ['an object literal', 'export const config = { key: process.env.KEY };'],
    ['a class', 'export class Repo { load() { return 1; } }'],
    ['an enum', 'export enum Mode { A }'],
    ['a non-function specifier', "const token = 'k'; export { token };"],
    ['an imported binding', "import { db } from './db.js'; export { db };"],
    ['a default expression', 'export default { secret: 1 };'],
  ] as const) {
    it(`fails closed on ${label} exported from a file-level module`, () => {
      const source = ["'use server';", line, ''].join('\n');
      assert.throws(
        () => stripServerDirectives(source, 'bad-export.ts'),
        (error: unknown) =>
          error instanceof ServerDirectiveError && error.code === 'unsupported_export',
      );
    });
  }

  it('fails closed on an export-all inside a file-level module', () => {
    const source = ["'use server';", "export * from './all.js';", ''].join('\n');
    assert.throws(
      () => stripServerDirectives(source, 'export-all.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('returns a source map without the original text', () => {
    const source = "'use server';\nexport const a = async () => { await secretCall(); };\n";
    const result = stripServerDirectives(source, 'mapped.ts?v=1');

    assert.ok(result.map !== null);
    assert.deepEqual(result.map.sources, ['mapped.ts']);
    assert.equal('sourcesContent' in result.map, false);
    // The bundler adds `sourcesContent` to a transform map in place.
    assert.equal(Object.isExtensible(result.map), true);
    assert.doesNotMatch(JSON.stringify(result.map), /secretCall/);
  });

  it('parses a queried id with the language of its real extension', () => {
    const source = "'use server';\nexport const a = () => { return <div />; };\n";
    const result = stripServerDirectives(source, '/app/view.tsx?import');
    assert.deepEqual(result.stubbed, ['a']);
  });

  it('stubServerOnlyModule treats a module without the prologue as server code', () => {
    const source = [
      "const KEY = 'k';",
      'export async function persist() { return save(KEY); }',
      '',
    ].join('\n');

    const result = stubServerOnlyModule(source, 'block.ts');

    assert.deepEqual(result.stubbed, ['persist']);
    assert.doesNotMatch(result.code, /KEY|save/);
  });

  it('fails closed on a marked non-exported function (un-stubable, would leak)', () => {
    const source = [
      "function helper() { 'use server'; return secret(); }",
      'export const value = helper;',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'private.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('is pure: the same input yields the same output', () => {
    const source = "'use server';\nexport const a = async () => { await x(); };\n";
    const first = stripServerDirectives(source, 'p.ts');
    const second = stripServerDirectives(source, 'p.ts');

    assert.deepEqual(first, second);
  });

  it('throws on a directive attached to a class method', () => {
    const source = [
      'class Service {',
      "  async run() { 'use server'; await x(); }",
      '}',
      'export { Service };',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'method.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on a directive attached to an object property', () => {
    const source = [
      'export const handlers = {',
      "  run: async () => { 'use server'; await x(); },",
      '};',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'prop.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on a directive inside a nested closure', () => {
    const source = [
      'export function outer() {',
      "  return () => { 'use server'; return 1; };",
      '}',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'nested.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on a directive inside an immediately-invoked function expression', () => {
    const source = ["(function () { 'use server'; })();", ''].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'iife.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on a directive inside a bare block statement', () => {
    const source = ['export function f() {', "  { 'use server'; }", '  return 1;', '}', ''].join(
      '\n',
    );

    assert.throws(
      () => stripServerDirectives(source, 'block.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on a top-level directive that is not the module prologue', () => {
    const source = [
      'export const x = 1;',
      "'use server';",
      'export function f() { return 1; }',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'midfile.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on a directive that is not the first statement of a function body', () => {
    const source = [
      'export function f() {',
      '  const a = 1;',
      "  'use server';",
      '  return a;',
      '}',
      '',
    ].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'midbody.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('does not flag an inert use-server string literal', () => {
    const source = [
      'export function f() {',
      "  const s = 'use server';",
      '  return s;',
      '}',
      '',
    ].join('\n');

    const result = stripServerDirectives(source, 'literal.ts');
    assert.equal(result.hadDirective, false);
    assert.deepEqual(result.stubbed, []);
  });

  it('throws on a re-export inside a server module', () => {
    const source = ["'use server';", "export { persist } from './persist.js';", ''].join('\n');

    assert.throws(
      () => stripServerDirectives(source, 'reexport.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_position',
    );
  });

  it('throws on unparseable source', () => {
    assert.throws(
      () => stripServerDirectives('export function (', 'broken.ts'),
      (error: unknown) => error instanceof ServerDirectiveError && error.code === 'unparseable',
    );
  });

  it('carries no source text in the error message', () => {
    const source = ["'use server';", "export { persist } from './persist.js';", ''].join('\n');
    try {
      stripServerDirectives(source, 'reexport.ts');
      assert.fail('expected ServerDirectiveError');
    } catch (error) {
      assert.ok(error instanceof ServerDirectiveError);
      assert.doesNotMatch(error.message, /persist/);
    }
  });
});

/** A `'use server'` module: the shape the plugin rewrites into stubs. */
const SERVER_MODULE = "'use server';\nexport const a = async () => { await x(); };\n";

describe('serverDirectivePlugin', () => {
  it('reports the bundler shape: name, enforce pre, transform', () => {
    const plugin = serverDirectivePlugin();

    assert.equal(plugin.name, 'jsails-use-server-directive');
    assert.equal(plugin.enforce, 'pre');
    assert.equal(typeof plugin.transform, 'function');
  });

  it('returns null when the module carries no directive', () => {
    const plugin = serverDirectivePlugin();

    assert.equal(plugin.transform('export const x = 1;', '/app/plain.ts'), null);
  });

  it('returns rewritten code for a use-server module', () => {
    const plugin = serverDirectivePlugin();
    const source = SERVER_MODULE;

    const result = plugin.transform(source, '/app/mixed.ts');

    assert.ok(result !== null);
    assert.match(result.code, /server-only function \\?"a\\?"/);
    assert.ok(result.map !== null);
  });

  it('never parses a module that does not mention the directive', () => {
    const plugin = serverDirectivePlugin();
    // Unparseable source proves the prefilter skipped the parser entirely.
    assert.equal(plugin.transform('export function (', '/app/broken.ts'), null);
  });

  it('skips dependencies under node_modules', () => {
    const plugin = serverDirectivePlugin();
    const source = SERVER_MODULE;
    assert.equal(plugin.transform(source, '/app/node_modules/dep/index.js'), null);
  });

  it('refuses client source maps with embedded sources after stripping a module', () => {
    const plugin = serverDirectivePlugin();
    plugin.transform(SERVER_MODULE, '/app/m.ts');

    assert.throws(
      () => plugin.renderStart({ sourcemap: true }),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_sourcemap',
    );
    assert.throws(() => plugin.renderStart({ sourcemap: 'hidden' }));
    assert.doesNotThrow(() =>
      plugin.renderStart({ sourcemap: true, sourcemapExcludeSources: true }),
    );
    assert.doesNotThrow(() => plugin.renderStart({ sourcemap: false }));
  });

  it('keeps refusing source maps on a watch rebuild that reuses a cached strip', () => {
    // A watch rebuild runs the build hooks again but reuses the cached transform
    // of an unchanged module, so `transform` never sees the stripped module twice.
    const plugin = serverDirectivePlugin() as ReturnType<typeof serverDirectivePlugin> & {
      buildStart?: () => void;
    };
    plugin.transform(SERVER_MODULE, '/app/m.ts');
    plugin.buildStart?.();
    plugin.buildStart?.();
    plugin.transform('export const y = 2;', '/app/other.ts');

    assert.throws(
      () => plugin.renderStart({ sourcemap: true }),
      (error: unknown) =>
        error instanceof ServerDirectiveError && error.code === 'unsupported_sourcemap',
    );
  });

  it('forgets a module once it is transformed again without a directive', () => {
    const plugin = serverDirectivePlugin();
    plugin.transform(SERVER_MODULE, '/app/m.ts');
    plugin.transform('export const a = async () => x();\n', '/app/m.ts');
    assert.doesNotThrow(() => plugin.renderStart({ sourcemap: true }));
  });

  it('allows client source maps when no module was stripped', () => {
    const plugin = serverDirectivePlugin();
    plugin.transform('export const x = 1;', '/app/plain.ts');
    assert.doesNotThrow(() => plugin.renderStart({ sourcemap: true }));
  });

  it('skips CSS and non-source modules', () => {
    const plugin = serverDirectivePlugin();
    const source = SERVER_MODULE;

    assert.equal(plugin.transform(source, '/app/styles.css'), null);
    assert.equal(plugin.transform(source, '/app/file.json'), null);
  });

  it('skips everything when configured as a server build', () => {
    const plugin = serverDirectivePlugin({ server: true });
    const source = SERVER_MODULE;

    assert.equal(plugin.transform(source, '/app/mixed.ts'), null);
  });

  it('honors a custom include list', () => {
    const plugin = serverDirectivePlugin({ include: ['.tsx'] });
    const source = SERVER_MODULE;

    assert.equal(plugin.transform(source, '/app/mixed.ts'), null);
    assert.ok(plugin.transform(source, '/app/mixed.tsx') !== null);
  });
  it('fails a client build on a function-level directive instead of shipping the module', () => {
    const plugin = serverDirectivePlugin();
    const source = [
      "const SECRET = 'k-123';",
      "export async function load() { 'use server'; return SECRET; }",
      '',
    ].join('\n');
    assert.throws(
      () => plugin.transform(source, '/app/ui/mixed.ts'),
      (error: unknown) =>
        error instanceof ServerDirectiveError &&
        error.code === 'unsupported_position' &&
        !error.message.includes('k-123'),
    );
  });

  it('applies to every TypeScript and JavaScript module extension by default', () => {
    const plugin = serverDirectivePlugin();
    for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) {
      const result = plugin.transform(SERVER_MODULE, `/app/m${extension}`);
      assert.ok(result !== null, extension);
      assert.doesNotMatch(result.code, /await x\(\)/, extension);
    }
  });
});

describe('isServerOnlyModuleId', () => {
  it('matches a .server module in every TypeScript and JavaScript extension', () => {
    for (const extension of ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']) {
      assert.equal(isServerOnlyModuleId(`/app/store.server.${extension}`), true, extension);
    }
    assert.equal(isServerOnlyModuleId('/app/store.server.ts?import'), true);
    assert.equal(isServerOnlyModuleId('\0/app/store.server.js'), true);
  });

  it('does not match ordinary or look-alike modules', () => {
    for (const id of [
      '/app/store.ts',
      '/app/server.ts',
      '/app/store.server.css',
      '/app/store.server.json',
      '/app/store.serverless.ts',
    ]) {
      assert.equal(isServerOnlyModuleId(id), false, id);
    }
  });
});
