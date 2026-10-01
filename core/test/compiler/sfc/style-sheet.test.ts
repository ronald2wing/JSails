/**
 * Tests for the collected stylesheet (sfc-plan §3.3, SFC-08): the island
 * marker rule first, then every component's blocks by path and index,
 * whatever order the lowerings arrive in; two runs over the corpus give the
 * same bytes; and a scope-id collision or a component passed twice is
 * refused with the paths, never a guess.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lowerSfc, type SfcLowering } from '../../../src/compiler/sfc/lower.js';
import { sfcStyleSheet } from '../../../src/compiler/sfc/style-sheet.js';
import { scopedCss, sfcScopeId, sfcStyleId } from '../../../src/compiler/sfc/style.js';
import { ISLAND_STYLE } from '../../../src/view/island-props.js';
import { CORPUS_RESOLVER, SFC_CORPUS } from './corpus.js';

function lower(file: string, styles: string): SfcLowering {
  const lowering = lowerSfc(`<template><p /></template>\n${styles}`, file);
  assert.deepEqual(lowering.diagnostics, [], file);
  return lowering;
}

function lowerCorpus(): readonly SfcLowering[] {
  return SFC_CORPUS.map((file) => lowerSfc(file.source, file.path, { resolver: CORPUS_RESOLVER }));
}

describe('sfcStyleSheet', () => {
  it('starts with the island marker rule, then orders components by path and blocks by index', () => {
    const page = lower('pages/index.jsails', '<style>\nmain { margin: 0 }\n</style>\n');
    const card = lower(
      'ui/card.jsails',
      '<style scoped>\n.card { padding: 1rem }\n</style>\n<style>\n:root { --gap: 1rem }\n</style>\n',
    );
    const plain = lower('ui/a.jsails', '');
    const forward = sfcStyleSheet([card, plain, page]);
    const reverse = sfcStyleSheet([page, plain, card]);
    assert.deepEqual(forward, reverse);
    assert.equal(
      forward.css,
      `${ISLAND_STYLE}\n` +
        'main { margin: 0 }\n' +
        scopedCss('.card { padding: 1rem }\n', sfcScopeId('ui/card.jsails')) +
        ':root { --gap: 1rem }\n',
    );
    assert.deepEqual(
      forward.blocks.map((block) => [block.file, block.index, block.scoped, block.id]),
      [
        ['pages/index.jsails', 0, false, sfcStyleId('pages/index.jsails', 0)],
        ['ui/card.jsails', 0, true, sfcStyleId('ui/card.jsails', 0)],
        ['ui/card.jsails', 1, false, sfcStyleId('ui/card.jsails', 1)],
      ],
    );
    assert.ok(Object.isFrozen(forward) && Object.isFrozen(forward.blocks));
    assert.ok(forward.blocks.every((block) => Object.isFrozen(block)));
  });

  it('orders paths by code unit, not by locale', () => {
    const upper = lower('ui/Z.jsails', '<style>\nz {}\n</style>\n');
    const lowerCase = lower('ui/a.jsails', '<style>\na {}\n</style>\n');
    assert.deepEqual(
      sfcStyleSheet([lowerCase, upper]).blocks.map((block) => block.file),
      ['ui/Z.jsails', 'ui/a.jsails'],
    );
  });

  it('holds only the island rule without styles', () => {
    assert.deepEqual(sfcStyleSheet([]), { css: `${ISLAND_STYLE}\n`, blocks: [] });
  });

  it('gives the same bytes on two runs over the corpus', () => {
    const first = sfcStyleSheet(lowerCorpus());
    const second = sfcStyleSheet([...lowerCorpus()].reverse());
    assert.equal(first.css, second.css);
    assert.deepEqual(
      first.blocks.map((block) => [block.file, block.scoped]),
      [
        ['pages/layout.jsails', false],
        ['ui/card.jsails', true],
      ],
    );
  });

  it('refuses two components with one scope id, naming both, and a component passed twice', () => {
    const card = lower('ui/card.jsails', '');
    const twin = { ...lower('ui/other.jsails', ''), scopeId: card.scopeId };
    assert.throws(() => sfcStyleSheet([twin, card]), {
      code: 'sfc_style.scope_collision',
      message: /ui\/card\.jsails.*ui\/other\.jsails/,
    });
    const respelled = { file: 'UI/Card.jsails', scopeId: sfcScopeId('UI/Card.jsails'), styles: [] };
    assert.throws(() => sfcStyleSheet([respelled, card]), {
      code: 'sfc_style.scope_collision',
    });
    assert.throws(() => sfcStyleSheet([card, card]), {
      code: 'sfc_style.duplicate_file',
      message: /ui\/card\.jsails/,
    });
  });
});
