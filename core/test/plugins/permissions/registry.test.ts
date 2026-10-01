/** Tests for the closed plugin permission registry. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PLUGIN_CAPABILITY_PERMISSIONS } from '../../../src/plugins/capability-gate.js';
import {
  describePermission,
  getPermission,
  parsePermission,
  PERMISSIONS,
} from '../../../src/plugins/permissions/index.js';

describe('permission registry', () => {
  it('defines a title, a description, and a risk for every permission', () => {
    assert.ok(PERMISSIONS.length > 0);
    const ids = new Set<string>();
    for (const permission of PERMISSIONS) {
      assert.ok(!ids.has(permission.id), `${permission.id} is defined twice`);
      ids.add(permission.id);
      assert.match(permission.id, /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/);
      assert.ok(permission.title.trim().length > 0, permission.id);
      assert.ok(permission.description.trim().endsWith('.'), permission.id);
      assert.ok(['low', 'elevated', 'high'].includes(permission.risk), permission.id);
      assert.equal(
        permission.title.includes('{scope}'),
        permission.scoped !== undefined,
        `${permission.id}: a scoped title names its scope, an unscoped one does not`,
      );
      assert.ok(Object.isFrozen(permission));
    }
    assert.ok(Object.isFrozen(PERMISSIONS));
  });

  it('holds the initial set', () => {
    const expected = [
      'http.routes',
      'http.routes.any',
      'http.middleware',
      'http.transform',
      'http.guard',
      'http.scope',
      'http.serve',
      'admin.pages',
      'data.own',
      'data.read',
      'data.write',
      'net.fetch',
      'mail.send',
      'notifications.send',
      'jobs.define',
      'jobs.schedule',
      'events.observe',
      'interceptors.register',
      'services.provide',
      'services.replace',
      'files.disk',
      'auth.session.read',
      'users.read',
      'health.readiness',
      'client.assets',
      'env.read',
    ];
    assert.deepEqual(
      PERMISSIONS.map((permission) => permission.id),
      expected,
    );
  });

  it('rates the permissions a managed ceiling excludes as high risk', () => {
    for (const id of [
      'http.middleware',
      'http.transform',
      'interceptors.register',
      'services.replace',
      'env.read',
      'data.write',
    ]) {
      assert.equal(getPermission(id)?.risk, 'high', id);
    }
  });

  it('defines every permission the setup-context capability gate demands', () => {
    for (const permission of Object.values(PLUGIN_CAPABILITY_PERMISSIONS)) {
      const parsed = parsePermission(permission);
      assert.equal(parsed.ok, true, `${permission} is demanded by the gate but not registered`);
    }
  });

  describe('parsePermission', () => {
    it('accepts an unscoped permission and a scoped one', () => {
      const plain = parsePermission('mail.send');
      assert.ok(plain.ok);
      assert.equal(plain.permission.definition.id, 'mail.send');
      assert.equal(plain.permission.scope, undefined);

      for (const [text, scope] of [
        ['net.fetch:api.example.com', 'api.example.com'],
        ['data.read:Post', 'Post'],
        ['data.write:blog_post', 'blog_post'],
        ['files.disk:media', 'media'],
        ['env.read:STRIPE_KEY', 'STRIPE_KEY'],
      ] as const) {
        const scoped = parsePermission(text);
        assert.ok(scoped.ok, text);
        assert.equal(scoped.permission.scope, scope);
      }
    });

    it('returns a code for every refusal', () => {
      const cases: readonly (readonly [unknown, string])[] = [
        [42, 'invalid_format'],
        ['', 'invalid_format'],
        ['Mail.Send', 'invalid_format'],
        ['mail..send', 'invalid_format'],
        ['x'.repeat(400), 'invalid_format'],
        ['database.read', 'unknown_permission'],
        ['network.connect', 'unknown_permission'],
        ['logging.write', 'unknown_permission'],
        ['net.fetch', 'scope_required'],
        ['net.fetch:', 'scope_required'],
        ['mail.send:anything', 'scope_not_allowed'],
        ['net.fetch:127.0.0.1', 'invalid_scope'],
        ['net.fetch:localhost', 'invalid_scope'],
        ['net.fetch:API.example.com', 'invalid_scope'],
        ['net.fetch:example.com:443', 'invalid_scope'],
        ['net.fetch:*.example.com', 'invalid_scope'],
        ['data.read:1Post', 'invalid_scope'],
        ['files.disk:Media', 'invalid_scope'],
        ['env.read:lower', 'invalid_scope'],
        ['env.read:JSAILS_CREDENTIALS_KEY', 'reserved_scope'],
      ];
      for (const [text, code] of cases) {
        const result = parsePermission(text);
        assert.equal(result.ok, false, String(text));
        if (!result.ok) assert.equal(result.code, code, String(text));
      }
    });
  });

  describe('describePermission', () => {
    it('fills the scope into the title', () => {
      assert.deepEqual(describePermission('net.fetch:api.example.com'), {
        permission: 'net.fetch:api.example.com',
        title: 'Send requests to api.example.com',
        description: getPermission('net.fetch')?.description,
        risk: 'elevated',
      });
      assert.equal(describePermission('http.routes')?.title, getPermission('http.routes')?.title);
    });

    it('returns undefined for a refused permission', () => {
      assert.equal(describePermission('database.read'), undefined);
    });
  });
});
