/**
 * Tests for the tenant role model: the exhaustive default role matrix, the
 * reserved owner, definition refusals, parse and rank, app permission
 * vocabularies, and the seeded canAssign and allows properties.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  defaultTenantRoles,
  defineTenantRoles,
  OWNER_ROLE,
  TENANCY_PERMISSIONS,
  type TenancyPermission,
  type TenantRolesDefinition,
} from '../src/tenant-roles.js';
import { seededPrng } from './seeded-prng.js';
import { thrownCode } from './thrown-code.js';

type DefaultRole = 'admin' | 'member' | 'viewer' | 'owner';

/** The expected matrix: role -> permissions it holds. Everything else is refused. */
const MATRIX: Readonly<Record<DefaultRole, readonly TenancyPermission[]>> = {
  owner: TENANCY_PERMISSIONS,
  admin: [
    'tenant.view',
    'tenant.update',
    'members.view',
    'members.invite',
    'members.remove',
    'members.role',
    'domains.manage',
    'settings.manage',
    'audit.view',
  ],
  member: ['tenant.view', 'members.view'],
  viewer: ['tenant.view'],
};

describe('defaultTenantRoles', () => {
  for (const role of Object.keys(MATRIX) as DefaultRole[]) {
    for (const permission of TENANCY_PERMISSIONS) {
      const expected = MATRIX[role].includes(permission);
      it(`${role} ${expected ? 'holds' : 'lacks'} ${permission}`, () => {
        assert.equal(defaultTenantRoles.allows(role, permission), expected);
      });
    }
  }

  it('keeps delete, transfer and plan with the owner', () => {
    for (const role of defaultTenantRoles.roles) {
      for (const permission of ['tenant.delete', 'tenant.transfer', 'plan.manage'] as const) {
        assert.equal(defaultTenantRoles.allows(role, permission), false, `${role} ${permission}`);
      }
    }
  });

  it('lists roles most privileged first, defaults invitations to member, and is frozen', () => {
    assert.deepEqual(defaultTenantRoles.roles, ['admin', 'member', 'viewer']);
    assert.equal(defaultTenantRoles.defaultRole, 'member');
    assert.ok(Object.isFrozen(defaultTenantRoles));
    assert.ok(Object.isFrozen(defaultTenantRoles.roles));
    assert.deepEqual(defaultTenantRoles.permissions, TENANCY_PERMISSIONS);
  });

  it('ranks owner above every role', () => {
    const owner = defaultTenantRoles.rank(OWNER_ROLE);
    for (const role of defaultTenantRoles.roles) {
      assert.ok(owner > defaultTenantRoles.rank(role), role);
    }
    assert.ok(defaultTenantRoles.rank('admin') > defaultTenantRoles.rank('member'));
    assert.ok(defaultTenantRoles.rank('member') > defaultTenantRoles.rank('viewer'));
  });

  it('parses stored values, owner included, and nothing else', () => {
    assert.equal(defaultTenantRoles.parse('admin'), 'admin');
    assert.equal(defaultTenantRoles.parse('owner'), 'owner');
    for (const value of ['Admin', 'OWNER', '', 'root', 'toString', '__proto__', ' admin']) {
      assert.equal(defaultTenantRoles.parse(value), null, value);
    }
    assert.equal(defaultTenantRoles.parse(1 as unknown as string), null);
  });

  it('refuses unknown roles and permissions', () => {
    assert.equal(
      thrownCode(() => defaultTenantRoles.rank('root' as 'admin')),
      'invalid_role',
    );
    assert.equal(
      thrownCode(() => defaultTenantRoles.rank('toString' as 'admin')),
      'invalid_role',
    );
    assert.equal(defaultTenantRoles.allows('root' as 'admin', 'tenant.view'), false);
    assert.equal(defaultTenantRoles.allows('owner', 'posts.write' as TenancyPermission), false);
    assert.equal(defaultTenantRoles.allows('admin', 'constructor' as TenancyPermission), false);
  });
});

describe('canAssign', () => {
  const roles = defaultTenantRoles;
  const table: readonly (readonly [
    DefaultRole,
    'admin' | 'member' | 'viewer' | null,
    'admin' | 'member' | 'viewer',
    boolean,
  ])[] = [
    ['owner', null, 'admin', true],
    ['owner', 'member', 'admin', true],
    ['owner', 'admin', 'viewer', true],
    ['admin', null, 'member', true],
    ['admin', 'viewer', 'member', true],
    ['admin', null, 'admin', false],
    ['admin', 'member', 'admin', false],
    ['admin', 'admin', 'member', false],
    ['member', null, 'viewer', true],
    ['member', null, 'member', false],
    ['viewer', null, 'viewer', false],
  ];
  for (const [actor, from, to, expected] of table) {
    it(`${actor}: ${String(from)} -> ${to} is ${String(expected)}`, () => {
      assert.equal(roles.canAssign(actor, from, to), expected);
    });
  }

  it('never assigns or re-roles owner', () => {
    assert.equal(roles.canAssign('owner', null, 'owner' as 'admin'), false);
    assert.equal(roles.canAssign('owner', 'owner' as 'admin', 'member'), false);
    assert.equal(roles.canAssign('root' as 'admin', null, 'viewer'), false);
  });

  it('never grants a rank at or above the actor or owner (seeded property)', () => {
    const random = seededPrng(0xca55);
    const actors: readonly DefaultRole[] = ['owner', 'admin', 'member', 'viewer'];
    const targets = ['admin', 'member', 'viewer', 'owner', 'ghost'] as const;
    for (let i = 0; i < 3000; i += 1) {
      const actor = random.pick(actors);
      const from = random.int(4) === 0 ? null : random.pick(targets);
      const to = random.pick(targets);
      const allowed = roles.canAssign(actor, from as 'admin' | null, to as 'admin');
      if (allowed) {
        assert.notEqual(to, 'owner');
        assert.ok(roles.rank(to as 'admin') < roles.rank(actor), `step ${i}`);
        if (from !== null) {
          assert.ok(roles.rank(from as 'admin') < roles.rank(actor), `step ${i}`);
        }
      }
    }
  });
});

describe('defineTenantRoles', () => {
  const valid = {
    roles: {
      editor: { rank: 20, permissions: ['tenant.view', 'posts.publish'] },
      reader: { rank: 10, permissions: ['tenant.view', 'posts.read'] },
    },
    defaultRole: 'reader',
    permissions: ['posts.publish', 'posts.read'],
  } as const;

  it('accepts app permissions and grants them to the owner too', () => {
    const roles = defineTenantRoles(valid);
    assert.equal(roles.allows('editor', 'posts.publish'), true);
    assert.equal(roles.allows('reader', 'posts.publish'), false);
    assert.equal(roles.allows('owner', 'posts.publish'), true);
    assert.deepEqual(roles.permissions, [...TENANCY_PERMISSIONS, 'posts.publish', 'posts.read']);
    assert.equal(roles.rank('owner'), 21);
  });

  it('matches allows to the declared permission lists (seeded property)', () => {
    const random = seededPrng(0xa110);
    const roles = defineTenantRoles(valid);
    for (let i = 0; i < 500; i += 1) {
      const role = random.pick(['editor', 'reader'] as const);
      const permission = random.pick(roles.permissions);
      const declared: readonly string[] = valid.roles[role].permissions;
      assert.equal(roles.allows(role, permission), declared.includes(permission));
    }
  });

  const refusals: readonly (readonly [string, TenantRolesDefinition<string, string>])[] = [
    ['an owner role', { roles: { owner: { rank: 1, permissions: [] } }, defaultRole: 'owner' }],
    ['no roles', { roles: {}, defaultRole: 'x' }],
    [
      'an upper-case role',
      { roles: { Admin: { rank: 1, permissions: [] } }, defaultRole: 'Admin' },
    ],
    ['a dotted role', { roles: { 'a.b': { rank: 1, permissions: [] } }, defaultRole: 'a.b' }],
    [
      'duplicate ranks',
      {
        roles: { a: { rank: 1, permissions: [] }, b: { rank: 1, permissions: [] } },
        defaultRole: 'a',
      },
    ],
    ['a zero rank', { roles: { a: { rank: 0, permissions: [] } }, defaultRole: 'a' }],
    ['an oversized rank', { roles: { a: { rank: 1_000_001, permissions: [] } }, defaultRole: 'a' }],
    [
      'permissions that are not a list',
      {
        roles: { a: { rank: 1, permissions: 'tenant.view' as unknown as readonly string[] } },
        defaultRole: 'a',
      },
    ],
    ['a fractional rank', { roles: { a: { rank: 1.5, permissions: [] } }, defaultRole: 'a' }],
    [
      'an unknown permission',
      { roles: { a: { rank: 1, permissions: ['posts.read'] } }, defaultRole: 'a' },
    ],
    [
      'an owner-only permission',
      { roles: { a: { rank: 1, permissions: ['tenant.transfer'] } }, defaultRole: 'a' },
    ],
    ['an undefined default role', { roles: { a: { rank: 1, permissions: [] } }, defaultRole: 'b' }],
    [
      'a malformed app permission',
      { roles: { a: { rank: 1, permissions: [] } }, defaultRole: 'a', permissions: ['Posts'] },
    ],
    [
      'an app permission shadowing a built-in',
      {
        roles: { a: { rank: 1, permissions: [] } },
        defaultRole: 'a',
        permissions: ['tenant.view'],
      },
    ],
  ];
  for (const [why, definition] of refusals) {
    it(`refuses ${why} with invalid_role_set`, () => {
      assert.equal(
        thrownCode(() => defineTenantRoles(definition)),
        'invalid_role_set',
      );
    });
  }
});
