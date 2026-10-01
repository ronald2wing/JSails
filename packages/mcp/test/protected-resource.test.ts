/**
 * The resource-server surface: canonical resource identifiers, audience
 * matching, scope lists, the RFC 9728 document and its well-known path, and
 * the RFC 6750 challenges.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { McpDefinitionError } from '../src/errors.js';
import {
  audienceIncludes,
  canonicalResource,
  insufficientScopeResponse,
  protectedResource,
  scopeList,
  unauthorizedResponse,
} from '../src/protected-resource.js';

function invalidOption(error: unknown): boolean {
  return error instanceof McpDefinitionError && error.code === 'invalid_option';
}

describe('canonicalResource and audienceIncludes', () => {
  it('normalizes scheme and host case and keeps the path', () => {
    assert.equal(canonicalResource('HTTPS://MCP.Example.COM/Mcp'), 'https://mcp.example.com/Mcp');
    assert.equal(canonicalResource('https://mcp.example.com'), 'https://mcp.example.com/');
    assert.equal(canonicalResource('http://127.0.0.1:3000/mcp'), 'http://127.0.0.1:3000/mcp');
    for (const value of ['http://mcp.example.com/', 'https://x/#', 'mcp', 'https://a:b@x/', 7]) {
      assert.throws(() => canonicalResource(value), invalidOption, String(value));
    }
  });

  it('matches an audience ignoring a fragment and one trailing slash', () => {
    const resource = 'https://mcp.example.com/mcp';
    assert.equal(audienceIncludes(resource, resource), true);
    assert.equal(audienceIncludes('https://mcp.example.com/mcp/', resource), true);
    assert.equal(audienceIncludes('HTTPS://MCP.EXAMPLE.COM/mcp#x', resource), true);
    assert.equal(audienceIncludes(['https://other.example', resource], resource), true);
    assert.equal(audienceIncludes('https://mcp.example.com/mcp/admin', resource), false);
    assert.equal(audienceIncludes('https://mcp.example.com/', resource), false);
    assert.equal(audienceIncludes(['nonsense', 3], resource), false);
  });

  it('checks and de-duplicates scope lists', () => {
    assert.deepEqual(scopeList(['a', 'b:c', 'a'], 'x'), ['a', 'b:c']);
    assert.deepEqual(scopeList(undefined, 'x'), []);
    for (const value of ['a', ['a b'], ['"'], [1]]) {
      assert.throws(() => scopeList(value, 'x'), invalidOption);
    }
  });
});

describe('protectedResource', () => {
  it('builds the document and the path-inserted location', () => {
    const resource = protectedResource({
      resource: 'https://mcp.example.com/tenants/mcp',
      authorizationServers: [
        'https://auth.example.com',
        'https://auth.example.com/',
        'https://login.example.org/realms/x',
      ],
      scopesSupported: ['notes:read'],
      resourceName: 'Notes',
      resourceDocumentation: 'https://docs.example.com/mcp',
    });
    assert.equal(resource.path, '/.well-known/oauth-protected-resource/tenants/mcp');
    assert.equal(
      resource.url,
      'https://mcp.example.com/.well-known/oauth-protected-resource/tenants/mcp',
    );
    assert.deepEqual(resource.document, {
      resource: 'https://mcp.example.com/tenants/mcp',
      authorization_servers: ['https://auth.example.com/', 'https://login.example.org/realms/x'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['notes:read'],
      resource_name: 'Notes',
      resource_documentation: 'https://docs.example.com/mcp',
    });
    assert.ok(Object.isFrozen(resource.document));
    const root = protectedResource({
      resource: 'https://mcp.example.com',
      authorizationServers: ['https://a.example'],
    });
    assert.equal(root.path, '/.well-known/oauth-protected-resource');
  });

  it('rejects bad issuers, names, and documentation links', () => {
    const base = {
      resource: 'https://mcp.example.com/mcp',
      authorizationServers: ['https://a.example'],
    };
    for (const overrides of [
      { authorizationServers: [] },
      { authorizationServers: ['http://a.example'] },
      { authorizationServers: ['https://a.example/?q=1'] },
      { authorizationServers: ['https://a.example/#f'] },
      { resourceName: ' ' },
      { resourceDocumentation: 'ftp://docs.example.com' },
      { scopesSupported: ['a b'] },
    ]) {
      assert.throws(
        () => protectedResource({ ...base, ...overrides }),
        invalidOption,
        JSON.stringify(overrides),
      );
    }
  });
});

describe('challenges', () => {
  const metadata = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';

  it('answers a missing credential without an error code', async () => {
    const response = unauthorizedResponse('missing', ['a', 'b'], metadata);
    assert.equal(response.status, 401);
    assert.equal(
      response.headers.get('www-authenticate'),
      `Bearer resource_metadata="${metadata}", scope="a b"`,
    );
    assert.equal(await response.text(), '');
    assert.equal(
      unauthorizedResponse('missing', [], undefined).headers.get('www-authenticate'),
      'Bearer',
    );
    assert.equal(
      unauthorizedResponse('missing', [], 'https://x/"\\é').headers.get('www-authenticate'),
      'Bearer resource_metadata="https://x/\\"\\\\ "',
    );
  });

  it('answers a bad or expired token with invalid_token', async () => {
    for (const reason of ['invalid', 'expired'] as const) {
      const response = unauthorizedResponse(reason, ['a'], metadata);
      assert.equal(response.status, 401);
      const challenge = response.headers.get('www-authenticate') ?? '';
      assert.match(
        challenge,
        /^Bearer error="invalid_token", error_description="[^"]+", scope="a", resource_metadata=/,
      );
      assert.equal(((await response.json()) as { error: string }).error, 'invalid_token');
    }
  });

  it('answers a missing scope with 403 naming every required scope', () => {
    const response = insufficientScopeResponse(['notes:read', 'notes:write'], metadata);
    assert.equal(response.status, 403);
    assert.equal(
      response.headers.get('www-authenticate'),
      `Bearer error="insufficient_scope", error_description="Insufficient scope", scope="notes:read notes:write", resource_metadata="${metadata}"`,
    );
  });
});
