/**
 * Tests for component tag collection and resolution: which capitalized template tags map to `app/components/` modules and how unresolved tags are reported.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  collectTemplateComponents,
  resolveComponentTags,
  type ComponentTagRef,
} from '../../src/compiler/resolve-components.js';
import { parseSfcBlocks } from '../../src/compiler/sfc/blocks.js';
import { SfcDiagnostics } from '../../src/compiler/sfc/diagnostics.js';
import type { TemplateNode } from '../../src/compiler/sfc/template-ast.js';

/** The children of a one-template file wrapping `markup`, and the file. */
function template(markup: string): { source: string; children: readonly TemplateNode[] } {
  const source = `<template>${markup}</template>`;
  const file = parseSfcBlocks(source, 'view.jsails');
  assert.deepEqual(file.diagnostics, []);
  return { source, children: file.template?.root.children ?? [] };
}

describe('collectTemplateComponents', () => {
  it('collects capitalized tags, de-duplicated and sorted, at their name range', () => {
    const { source, children } = template('<div><TaskList /><Counter></Counter><Counter /></div>');
    const refs = collectTemplateComponents(children);
    assert.deepEqual(
      refs.map((ref) => ref.tag),
      ['Counter', 'TaskList'],
    );
    const counter = refs.find((ref) => ref.tag === 'Counter');
    assert.ok(counter !== undefined);
    assert.equal(source.slice(counter.start, counter.end), 'Counter');
    assert.ok(refs.every((ref) => Object.isFrozen(ref)));
  });

  it('takes the root of a member tag and ignores intrinsic elements', () => {
    const { children } = template('<span><Icons.Check /></span>');
    assert.deepEqual(
      collectTemplateComponents(children).map((ref) => ref.tag),
      ['Icons'],
    );
  });

  it('skips tags inside a js-pre subtree, which are literal markup', () => {
    const { children } = template('<!-- prettier-ignore -->\n<div js-pre><Counter /></div>');
    assert.deepEqual(collectTemplateComponents(children), []);
  });
});

describe('resolveComponentTags', () => {
  const root = mkdtempSync(join(tmpdir(), 'resolve-components-'));
  const componentsDir = join(root, 'app', 'components');
  mkdirSync(componentsDir, { recursive: true });
  writeFileSync(join(componentsDir, 'counter.tsx'), 'export const Counter = 1;');
  writeFileSync(join(componentsDir, 'task-list.tsx'), 'export const TaskList = 1;');

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const ref = (tag: string): ComponentTagRef => Object.freeze({ tag, start: 0, end: tag.length });

  it('resolves a tag to its kebab-case module with a .js specifier', () => {
    const resolved = resolveComponentTags(
      [ref('Counter'), ref('TaskList')],
      {
        fromDir: componentsDir,
        rootDir: root,
      },
      new SfcDiagnostics('view.jsails'),
    );
    assert.equal(resolved.length, 2);
    const [counter, taskList] = resolved;
    assert.ok(counter !== undefined && taskList !== undefined);
    assert.equal(counter.tag, 'Counter');
    assert.equal(counter.specifier, './counter.js');
    assert.equal(taskList.tag, 'TaskList');
    assert.equal(taskList.specifier, './task-list.js');
  });

  it('builds a relative specifier from a different directory', () => {
    const resolved = resolveComponentTags(
      [ref('Counter')],
      {
        fromDir: join(root, 'app'),
        rootDir: root,
      },
      new SfcDiagnostics('view.jsails'),
    );
    const [counter] = resolved;
    assert.ok(counter !== undefined);
    assert.equal(counter.specifier, './components/counter.js');
  });

  it('returns a frozen list of frozen entries', () => {
    const resolved = resolveComponentTags(
      [ref('Counter')],
      { fromDir: componentsDir, rootDir: root },
      new SfcDiagnostics('view.jsails'),
    );
    const [counter] = resolved;
    assert.ok(counter !== undefined);
    assert.ok(Object.isFrozen(resolved));
    assert.ok(Object.isFrozen(counter));
  });

  it('reports a positioned unresolved_component and skips the missing tag', () => {
    const diagnostics = new SfcDiagnostics('view.jsails');
    const resolved = resolveComponentTags(
      [Object.freeze({ tag: 'Missing', start: 7, end: 14 }), ref('Counter')],
      { fromDir: componentsDir, rootDir: root },
      diagnostics,
    );
    // The resolvable tag is still returned; the missing one is dropped.
    assert.deepEqual(
      resolved.map((r) => r.tag),
      ['Counter'],
    );
    const [diag, ...rest] = diagnostics.list();
    assert.deepEqual(rest, []);
    assert.ok(diag !== undefined);
    assert.equal(diag.code, 'sfc.unresolved_component');
    assert.equal(diag.start, 7);
    assert.equal(diag.end, 14);
    assert.doesNotMatch(diag.message, /Missing/);
  });
});
