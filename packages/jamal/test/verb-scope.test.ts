/**
 * Tests for the split of jamal's verbs (`verb-scope.ts`) and for
 * `invokedVerb`, which names the verb a command line runs so the bin resolves
 * that verb's environment: the local verbs run as development, every other
 * verb as the deployed app (production) unless JSAILS_ENV names another.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { invokedVerb } from '../src/command.js';
import { isLocalVerb, verbDefaultEnvironment } from '../src/verb-scope.js';

describe('isLocalVerb', () => {
  it('names the Compose verbs and the dev-container shortcuts local', () => {
    for (const verb of ['up', 'down', 'logs', 'ps', 'exec', 'jsails', 'npm', 'npx', 'node']) {
      assert.equal(isLocalVerb(verb), true, verb);
    }
    assert.equal(isLocalVerb('test'), true);
    assert.equal(isLocalVerb('shell'), true);
  });

  it('names every verb that reaches or plans for the server a server verb', () => {
    for (const verb of [
      'deploy',
      'rollback',
      'status',
      'app',
      'accessory',
      'domain',
      'lock',
      'backup',
      'restore',
      'prune',
      'secrets',
      'cache-proxy',
    ]) {
      assert.equal(isLocalVerb(verb), false, verb);
    }
  });
});

describe('verbDefaultEnvironment', () => {
  it('runs a local verb as development everywhere', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      assert.equal(verbDefaultEnvironment('up', platform), 'development', platform);
      assert.equal(verbDefaultEnvironment('npm', platform), 'development', platform);
    }
  });

  it('runs a server verb as production, and resolves nothing for it on Windows', () => {
    assert.equal(verbDefaultEnvironment('deploy', 'linux'), 'production');
    assert.equal(verbDefaultEnvironment('secrets', 'darwin'), 'production');
    assert.equal(verbDefaultEnvironment('deploy', 'win32'), undefined);
    assert.equal(verbDefaultEnvironment('backup', 'win32'), undefined);
  });
});

describe('the environment each command line runs in', () => {
  it('runs every server verb, as typed, as production', () => {
    for (const args of [
      ['deploy'],
      ['deploy', '--dry-run'],
      ['deploy', '--allow-dirty'],
      ['rollback'],
      ['status'],
      ['prune', '--keep', '3'],
      ['secrets', 'print'],
      ['secrets', 'fetch', 'X'],
      ['app', 'boot'],
      ['accessory', 'reboot', 'db'],
      ['domain', 'check'],
      ['lock', 'status'],
      ['backup', 'db'],
      ['restore', 'db', 'file'],
      ['cache-proxy', 'plan'],
    ]) {
      assert.equal(
        verbDefaultEnvironment(invokedVerb(args) as string, 'linux'),
        'production',
        args.join(' '),
      );
    }
  });

  it('runs every local verb, as typed, as development', () => {
    for (const args of [
      ['up'],
      ['up', '--detach'],
      ['down'],
      ['ps'],
      ['logs', '--follow', 'db'],
      ['exec', 'db', '--', 'sh'],
      ['jsails', 'deploy'],
      ['npm', 'install'],
      ['npx', 'jamal', 'deploy'],
      ['node', 'x.js'],
      ['test'],
      ['shell'],
    ]) {
      assert.equal(
        verbDefaultEnvironment(invokedVerb(args) as string, 'linux'),
        'development',
        args.join(' '),
      );
    }
  });
});

describe('invokedVerb', () => {
  it('names the verb a command line runs, wherever its flags sit', () => {
    assert.equal(invokedVerb(['deploy']), 'deploy');
    assert.equal(invokedVerb(['--destination', 'up', 'deploy']), 'deploy');
    assert.equal(invokedVerb(['--dry-run', 'rollback']), 'rollback');
    assert.equal(invokedVerb(['secrets', 'fetch', 'X']), 'secrets');
    assert.equal(invokedVerb(['logs', '--follow', 'db']), 'logs');
    assert.equal(invokedVerb(['backup', 'db', '--out', 'dir']), 'backup');
    assert.equal(invokedVerb(['app', 'boot']), 'app');
  });

  it('names a shortcut even when its command asks for help', () => {
    assert.equal(invokedVerb(['npm', '--help']), 'npm');
    assert.equal(invokedVerb(['jsails', 'db:push', '-h']), 'jsails');
  });

  it('names no verb when the command line only prints', () => {
    for (const args of [
      [],
      ['--help'],
      ['deploy', '--help'],
      ['accessory', '-h'],
      ['bogus'],
      ['toString'],
      ['deploy', '--no-such-flag'],
      ['--destination'],
    ]) {
      assert.equal(invokedVerb(args), undefined, JSON.stringify(args));
    }
  });

  it('keeps tokens after -- out of the help check', () => {
    assert.equal(invokedVerb(['exec', 'db', '--', 'mariadb', '--help']), 'exec');
  });
});
