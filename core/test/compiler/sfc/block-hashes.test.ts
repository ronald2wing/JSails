/**
 * Tests for the block hashes a dev server compares (sfc-plan §3.7, KRN-19):
 * an edit inside a style body is a `'style'` change, whatever block it is
 * in and whatever its size, as long as nothing the module maps moves; an
 * edit that moves a mapped position (a style above the template growing,
 * or a line break replacing a character above it) is a `'module'` change;
 * an error is a module change; and an edit that changes nothing lowered
 * is `'none'`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sfcChange } from '../../../src/compiler/sfc/block-hashes.js';
import { lowerSfc, type SfcFolderSources } from '../../../src/compiler/sfc/lower.js';

function change(
  previous: string | SfcFolderSources,
  next: string | SfcFolderSources,
  file = 'ui/card.jsails',
): string {
  return sfcChange(lowerSfc(previous, file).hashes, lowerSfc(next, file).hashes);
}

const TEMPLATE =
  '<script setup lang="ts">\nconst n = 1;\n</script>\n<template><p class="a">{{ n }}</p></template>\n';

describe('sfcChange', () => {
  it('is none for the same source, and for an edit outside every block that moves nothing mapped', () => {
    const source = `${TEMPLATE}<style>\n.a { color: red }\n</style>\n`;
    assert.equal(change(source, source), 'none');
    assert.equal(change(source, `${source}\n\n`), 'none');
  });

  it('is style for any edit inside a style body after the template, of any size, scoped or not', () => {
    const before = `${TEMPLATE}<style>\n.a { color: red }\n</style>\n<style scoped>\n.a { margin: 0 }\n</style>\n`;
    assert.equal(
      change(before, before.replace('color: red', 'color: rebeccapurple; padding: 1rem')),
      'style',
    );
    assert.equal(change(before, before.replace('margin: 0', 'margin:\n  0\n  auto')), 'style');
    assert.equal(change(before, before.replace('<style scoped>', '<style>')), 'style');
    assert.equal(change(before, `${before}<style>\nb {}\n</style>\n`), 'style');
  });

  it('is style for an edit of a folder’s style files, which never move its template', () => {
    const folder = {
      template: '<template><p class="a">x</p></template>\n',
      style: '.a { color: red }\n',
    };
    assert.equal(
      change(folder, { ...folder, style: '.a {\n  color: blue;\n}\n', scopedStyle: 'p {}\n' }),
      'style',
    );
    assert.equal(change(folder, { ...folder, script: 'export const x = 1;\n' }), 'module');
  });

  it('is module when a style edit moves what the module maps', () => {
    const above = `<style>\n.a { color: red }\n</style>\n${TEMPLATE}`;
    assert.equal(change(above, above.replace('red', 'blue')), 'module', 'the template moved');
    assert.equal(
      change(above, above.replace('red', 'tan')),
      'style',
      'a style edit of the same length moves nothing',
    );
    assert.equal(
      change(above, above.replace('.a { color: red }', '.a {\ncolor: red }')),
      'module',
      'a line break replacing a space moves every line after it',
    );
  });

  it('is module for a template, script or layout edit', () => {
    const source = `${TEMPLATE}<style>\n.a {}\n</style>\n`;
    assert.equal(change(source, source.replace('class="a"', 'class="b"')), 'module');
    assert.equal(change(source, source.replace('const n = 1', 'const n = 2')), 'module');
    assert.equal(
      change(source, { template: '<template><p class="a">x</p></template>\n' }),
      'module',
    );
  });

  it('is module when a style error stops code generation, and when it is fixed', () => {
    const good = `${TEMPLATE}<style>\n.a { color: red }\n</style>\n`;
    const broken = good.replace('red }', 'red');
    assert.equal(change(good, broken), 'module');
    assert.equal(change(broken, good), 'module');
  });
});
