import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runExtensions } from 'jsails/extensions';
import {
  Tenant,
  TenantMembership,
  tenancyEntities,
  tenancyPlugin,
  tenancyToken,
} from '../src/index.js';

describe('tenancyPlugin', () => {
  it('owns tenant and membership entities without wiring them into an app', () => {
    const plugin = tenancyPlugin({ resolveTenant: () => null });
    assert.equal(plugin.name, 'tenancy');
    assert.deepEqual(plugin.schema?.entities, [Tenant, TenantMembership]);
    assert.deepEqual(tenancyEntities, [Tenant, TenantMembership]);
  });

  it('provides an auth-agnostic resolver under a typed token', async () => {
    const tenant = Object.assign(new Tenant(), { id: 1, slug: 'acme', name: 'Acme' });
    const plugin = tenancyPlugin({
      resolveTenant: async (request) =>
        request.headers.get('x-tenant') === 'acme' ? tenant : null,
    });
    const runtime = await runExtensions([plugin]);

    const service = runtime.services.get(tenancyToken);
    const request = new Request('http://localhost', { headers: { 'x-tenant': 'acme' } });
    assert.equal(await service.resolve(request, { session: null }), tenant);
  });
});
