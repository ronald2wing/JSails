/**
 * Tests for the parts of a `.jsails` component (`routing/component-parts.ts`):
 * a path named like a folder member, and the part rule that module scans
 * skip by.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isSfcComponentPart, sfcFolderMember } from '../../src/routing/component-parts.js';

test('sfcFolderMember reads a path named like a member of a component folder', () => {
  assert.deepEqual(sfcFolderMember('pages/blog/[slug]/[slug].jsails'), {
    role: 'template',
    component: 'pages/blog/[slug].jsails',
    template: 'pages/blog/[slug]/[slug].jsails',
  });
  assert.equal(sfcFolderMember('components/card/card.ts')?.role, 'script');
  assert.equal(sfcFolderMember('components/card/card.css')?.role, 'style');
  assert.equal(sfcFolderMember('components/card/card.scoped.css')?.role, 'scopedStyle');
  assert.equal(sfcFolderMember('components/card/card.server.ts')?.role, 'server');
  assert.equal(
    sfcFolderMember('components/card/card.server.ts')?.template,
    'components/card/card.jsails',
  );
  assert.equal(sfcFolderMember('ui/card.jsails'), undefined);
  assert.equal(sfcFolderMember('components/card/other.ts'), undefined);
  assert.equal(sfcFolderMember('card.ts'), undefined);
});

test('isSfcComponentPart holds for folder members and a server module beside its .jsails file', () => {
  const files = new Set([
    'components/card/card.jsails',
    'components/card/card.ts',
    'components/card/card.server.ts',
    'pages/about.jsails',
    'pages/about.server.ts',
    'ui/menu/menu.ts',
    'ui/list.server.ts',
  ]);
  const exists = (path: string): boolean => files.has(path);
  assert.equal(isSfcComponentPart('components/card/card.ts', exists), true);
  assert.equal(isSfcComponentPart('components/card/card.server.ts', exists), true);
  assert.equal(isSfcComponentPart('pages/about.server.ts', exists), true);
  assert.equal(isSfcComponentPart('components/card/card.jsails', exists), false);
  assert.equal(isSfcComponentPart('ui/menu/menu.ts', exists), false);
  assert.equal(isSfcComponentPart('ui/list.server.ts', exists), false);
});

test('isSfcComponentPart takes only x.server.ts for the server module, as the layouts name it', () => {
  const files = new Set([
    'pages/about.jsails',
    'pages/about.server.tsx',
    'pages/about.server.types.ts',
    'components/card/card.jsails',
    'components/card/card.server.tsx',
  ]);
  const exists = (path: string): boolean => files.has(path);
  assert.equal(isSfcComponentPart('pages/about.server.tsx', exists), false);
  assert.equal(isSfcComponentPart('pages/about.server.types.ts', exists), false);
  assert.equal(isSfcComponentPart('components/card/card.server.tsx', exists), false);
  assert.equal(
    isSfcComponentPart('.server.ts', () => true),
    false,
  );
});
