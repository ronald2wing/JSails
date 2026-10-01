/**
 * Tests for the package barrel: it exports the pure tenancy domain and the
 * plugin, and keeps the store port, the memory store and the lifecycle
 * service internal until the framework wires them to a service token.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as tenancy from '../src/index.js';

const PURE_DOMAIN = [
  'normalizeHostname',
  'isHostnameWithin',
  'slugPolicy',
  'checkSlug',
  'suggestSlug',
  'DEFAULT_RESERVED_SLUGS',
  'matchTenantHost',
  'normalizeRootDomain',
  'matchTenantPath',
  'assertTenantPathPrefix',
  'isTenantId',
  'defineTenantRoles',
  'defaultTenantRoles',
  'OWNER_ROLE',
  'TENANCY_PERMISSIONS',
  'nextTenantStatus',
  'parseTenantStatus',
  'isTenantAccessible',
  'issueInvitationToken',
  'hashInvitationToken',
  'sameInvitationTokenHash',
  'normalizeEmail',
  'invitationMessage',
  'systemDnsResolver',
  'issueDomainClaim',
  'domainChallenge',
  'challengeTokenOf',
  'checkDomainChallenge',
  'admissibleDomain',
  'domainVerificationPolicy',
  'nextDomainVerification',
  'parseTenantSettings',
  'tenantSettingsParser',
  'checkLimit',
  'TENANCY_ERROR_CODES',
  'TenancyError',
];

const INTERNAL = [
  'createTenancyLifecycle',
  'createMemoryTenancyStore',
  'resolveLifecycleOptions',
  'enforcedLimits',
  'plainTenantSettings',
  'tenantSettingsJson',
  'limitValue',
  'serializeTenantSettings',
  'encodePageCursor',
  'checkActor',
];

describe('@jsails/tenancy barrel', () => {
  it('exports the pure domain', () => {
    for (const name of PURE_DOMAIN) {
      assert.ok(name in tenancy, name);
    }
  });

  it('keeps the store, the lifecycle and their helpers internal', () => {
    for (const name of INTERNAL) {
      assert.ok(!(name in tenancy), name);
    }
  });

  it('default-exports the plugin factory for the declarative loader', () => {
    assert.equal(tenancy.default, tenancy.tenancyPlugin);
  });
});
