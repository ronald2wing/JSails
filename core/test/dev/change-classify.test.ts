/**
 * Tests for the dev watcher's change classification and class merging.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyChange,
  isMetaSourceChange,
  mergeChangeClasses,
} from '../../src/dev/change-classify.js';

describe('classifyChange', () => {
  it('restarts the server for emitted server code', () => {
    assert.equal(classifyChange('dist/src/app/application.js'), 'server-restart');
    assert.equal(classifyChange('dist/jobs/send-email.job.js'), 'server-restart');
    assert.equal(classifyChange('jsails.app.js'), 'server-restart');
    assert.equal(classifyChange('dist/src/index.mjs'), 'server-restart');
    assert.equal(classifyChange('dist/src/index.cjs'), 'server-restart');
  });

  it('reloads the browser for Vite output', () => {
    assert.equal(classifyChange('public/assets/app.css'), 'client-reload');
    assert.equal(classifyChange('public/assets/app.js'), 'client-reload');
    assert.equal(classifyChange('public/assets/app.js.map'), 'client-reload');
    assert.equal(classifyChange('public/assets/fonts/inter.woff2'), 'client-reload');
  });

  it('checks the Vite output prefix before the public ignore rule', () => {
    // `public` is ignored, but `public/assets` is Vite's output and is the only
    // signal that a client change landed. Ordering decides this case.
    assert.equal(classifyChange('public/assets/app.css'), 'client-reload');
    assert.equal(classifyChange('public/favicon.ico'), 'ignore');
    assert.equal(classifyChange('public/robots.txt'), 'ignore');
  });

  it('ignores source files, because the emitted .js already restarts', () => {
    // Reacting to the source would restart against a stale dist/.
    assert.equal(classifyChange('src/app/application.ts'), 'ignore');
    assert.equal(classifyChange('ui/live-posts.tsx'), 'ignore');
    assert.equal(classifyChange('ui/styles.css'), 'ignore');
  });

  it('ignores build and dependency directories', () => {
    assert.equal(classifyChange('node_modules/jsails/dist/index.js'), 'ignore');
    assert.equal(classifyChange('.git/index'), 'ignore');
    assert.equal(classifyChange('out/index.html'), 'ignore');
    assert.equal(classifyChange('.jsails/framework-symbols.js'), 'ignore');
  });

  it('ignores paths outside the project root', () => {
    assert.equal(classifyChange(''), 'ignore');
    assert.equal(classifyChange('/etc/passwd'), 'ignore');
    assert.equal(classifyChange('../evil.js'), 'ignore');
  });

  it('reads only / as a separator; the watcher converts platform paths first', () => {
    assert.equal(classifyChange('public\\assets\\app.css'), 'ignore');
    assert.equal(classifyChange('node_modules\\x/index.js'), 'server-restart');
  });

  it('ignores files with no extension and dotfiles', () => {
    assert.equal(classifyChange('package.json'), 'ignore');
    assert.equal(classifyChange('README'), 'ignore');
    assert.equal(classifyChange('.env'), 'ignore');
  });
});

describe('mergeChangeClasses', () => {
  it('lets a restart subsume a reload', () => {
    assert.equal(mergeChangeClasses(['client-reload', 'server-restart']), 'server-restart');
    assert.equal(mergeChangeClasses(['server-restart', 'client-reload']), 'server-restart');
  });

  it('keeps a reload when nothing restarts', () => {
    assert.equal(mergeChangeClasses(['ignore', 'client-reload']), 'client-reload');
  });

  it('reports ignore for an empty or all-ignored window', () => {
    assert.equal(mergeChangeClasses([]), 'ignore');
    assert.equal(mergeChangeClasses(['ignore', 'ignore']), 'ignore');
  });
});

describe('isMetaSourceChange', () => {
  it('accepts source modules under the directories build:meta scans', () => {
    for (const path of [
      'models/post.ts',
      'components/card/card.tsx',
      'app/components/counter.tsx',
      'server/helpers/format.ts',
      'shared/types.mts',
      'services/mailer.ts',
      'jobs/send.job.ts',
      'pages/index.tsx',
    ]) {
      assert.equal(isMetaSourceChange(path), true, path);
    }
  });

  it('rejects unscanned directories, declarations, other extensions, and escapes', () => {
    for (const path of [
      'src/index.ts',
      'dist/models/post.js',
      'models.ts',
      'models/post.d.ts',
      'models/notes.md',
      'models/node_modules/x.ts',
      '.jsails/models.ts',
      '/abs/models/post.ts',
      '../models/post.ts',
      '',
    ]) {
      assert.equal(isMetaSourceChange(path), false, path);
    }
  });
});
