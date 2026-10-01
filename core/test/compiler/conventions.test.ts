/**
 * Tests for the project layout conventions: artifact directories, generator layouts, server-component ids, and the kind of a `.jsails` file.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CONVENTION_DIRS,
  GENERATOR_LAYOUT,
  MAKE_COMMAND_TYPES,
  MODEL_EXTENSIONS,
  camelCase,
  classNameFromFile,
  componentIdFor,
  kebabCase,
  pascalCase,
  probeConventionFile,
  sfcKind,
  snakeCase,
  toWords,
} from '../../src/compiler/conventions.js';

test('toWords splits camelCase boundaries', () => {
  assert.deepEqual(toWords('BlogPost'), ['Blog', 'Post']);
  assert.deepEqual(toWords('blogPost'), ['blog', 'Post']);
  assert.deepEqual(toWords('TaskList'), ['Task', 'List']);
});

test('toWords splits acronym runs', () => {
  assert.deepEqual(toWords('HTMLParser'), ['HTML', 'Parser']);
  assert.deepEqual(toWords('getHTMLId'), ['get', 'HTML', 'Id']);
  assert.deepEqual(toWords('OAuthToken'), ['O', 'Auth', 'Token']);
});

test('toWords splits kebab and snake separators', () => {
  assert.deepEqual(toWords('blog-post'), ['blog', 'post']);
  assert.deepEqual(toWords('blog_post'), ['blog', 'post']);
  assert.deepEqual(toWords('blog post'), ['blog', 'post']);
});

test('toWords drops empty segments', () => {
  assert.deepEqual(toWords('--foo__bar--'), ['foo', 'bar']);
  assert.deepEqual(toWords(''), []);
});

test('pascalCase joins words with capitalized heads', () => {
  assert.equal(pascalCase('blog-post'), 'BlogPost');
  assert.equal(pascalCase('task_list'), 'TaskList');
  assert.equal(pascalCase('HTMLParser'), 'HtmlParser');
});

test('camelCase lowercases the first word', () => {
  assert.equal(camelCase('task-list'), 'taskList');
  assert.equal(camelCase('BlogPost'), 'blogPost');
  assert.equal(camelCase(''), '');
});

test('kebabCase and snakeCase lowercase every word', () => {
  assert.equal(kebabCase('BlogPost'), 'blog-post');
  assert.equal(snakeCase('BlogPost'), 'blog_post');
  assert.equal(kebabCase('HTMLParser'), 'html-parser');
});

test('classNameFromFile derives a PascalCase class from a kebab filename', () => {
  assert.equal(classNameFromFile('models/blog-post.ts'), 'BlogPost');
  assert.equal(classNameFromFile('blog-post.tsx'), 'BlogPost');
  assert.equal(classNameFromFile('task-list.mts'), 'TaskList');
});

test('CONVENTION_DIRS places server components under components/', () => {
  assert.equal(CONVENTION_DIRS.serverComponents, 'components');
});

test('GENERATOR_LAYOUT covers every make command type', () => {
  for (const type of MAKE_COMMAND_TYPES) {
    const layout = GENERATOR_LAYOUT[type];
    assert.ok(layout.dir.length > 0, `${type} has a dir`);
    assert.ok(layout.extension.startsWith('.'), `${type} has an extension`);
  }
  assert.equal(GENERATOR_LAYOUT.model.dir, CONVENTION_DIRS.models);
  assert.equal(GENERATOR_LAYOUT['server-component'].dir, CONVENTION_DIRS.serverComponents);
});

test('probeConventionFile returns the first existing candidate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-conventions-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'blog-post.ts'), 'export class BlogPost {}\n');

  assert.equal(probeConventionFile(dir, 'blog-post', MODEL_EXTENSIONS), join(dir, 'blog-post.ts'));
  assert.equal(probeConventionFile(dir, 'missing', MODEL_EXTENSIONS), undefined);
});

test('probeConventionFile honors extension order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsails-conventions-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'card.tsx'), 'export const Card = () => null;\n');
  writeFileSync(join(dir, 'card.ts'), 'export const Card = () => null;\n');

  assert.equal(probeConventionFile(dir, 'card', MODEL_EXTENSIONS), join(dir, 'card.ts'));
});

test('componentIdFor derives the id from the path under components/', () => {
  assert.equal(componentIdFor('components/task-list.tsx'), 'task-list');
  assert.equal(componentIdFor('components/TaskList.tsx'), 'task-list');
  assert.equal(componentIdFor('components/admin/UserCard.tsx'), 'admin/user-card');
});

test('componentIdFor names a .jsails folder by its component path, a nested file by its path', () => {
  assert.equal(componentIdFor('components/card.jsails'), 'card');
  assert.equal(componentIdFor('components/admin/card.jsails'), 'admin/card');
  assert.equal(componentIdFor('components/card/card.tsx'), 'card/card');
});

test('componentIdFor gives colliding spellings one id', () => {
  assert.equal(
    componentIdFor('components/taskList.tsx'),
    componentIdFor('components/task-list.tsx'),
  );
});

test('sfcKind decides a .jsails kind from its location alone', () => {
  const kinds = Object.fromEntries(
    [
      'pages/index.jsails',
      'pages/blog/[slug].jsails',
      'pages/components/x.jsails',
      'pages/layout.jsails',
      'pages/blog/layout.jsails',
      'pages/blog/error.jsails',
      'pages/not-found.jsails',
      'components/task-list.jsails',
      'components/admin/card/card.jsails',
      'islands/counter.jsails',
      'mail/welcome.jsails',
      'ui/tag-badge.jsails',
      'app/ui/layout.jsails',
      'packages/kit/src/components/x.jsails',
      'pages.jsails',
      'layout.jsails',
    ].map((path) => [path, sfcKind(path)]),
  );
  assert.deepEqual(kinds, {
    'pages/index.jsails': 'page',
    'pages/blog/[slug].jsails': 'page',
    'pages/components/x.jsails': 'page',
    'pages/layout.jsails': 'layout',
    'pages/blog/layout.jsails': 'layout',
    'pages/blog/error.jsails': 'error',
    'pages/not-found.jsails': 'not-found',
    'components/task-list.jsails': 'live',
    'components/admin/card/card.jsails': 'live',
    'islands/counter.jsails': 'island',
    'mail/welcome.jsails': 'mail',
    'ui/tag-badge.jsails': 'view',
    'app/ui/layout.jsails': 'view',
    'packages/kit/src/components/x.jsails': 'view',
    'pages.jsails': 'view',
    'layout.jsails': 'view',
  });
});
