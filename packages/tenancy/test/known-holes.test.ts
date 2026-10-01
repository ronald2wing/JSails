/**
 * Known holes where tenancy meets request security, each stated as the safe
 * behaviour against a real assembled app (`createTestApp` with
 * `tenancyPlugin` and the subdomain resolver the saas starter uses).
 *
 * A tenant lives on its own subdomain under the app's public origin, so a
 * cookie-carrying write from that subdomain to itself is same-origin and must
 * pass the cross-site check, while a write from a sibling tenant's origin is
 * cross-site and must fail it. Membership must be decided for the same user id
 * every other gate reads (`data.user.id`).
 *
 * The app serves `server.origin` plus the `*.example.com` host allowlist, so
 * each tenant subdomain resolves to its own request origin and the cross-site
 * check compares a write with that. A blanket refusal would also refuse the
 * sibling, so the sibling case first requires the same-subdomain POST to pass.
 *
 * A case that fails today is listed in `scripts/expected-failures/security.json`
 * with the work package that closes it. A case that already holds stays here
 * as an ordinary regression test.
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import type { Session } from 'jsails';
import { createTestApp, createTestSession, tempDir, type TestApplication } from 'jsails/testing';

import {
  subdomainTenantResolver,
  Tenant,
  TenantMembership,
  tenancyPlugin,
  type MembershipLookup,
} from '../src/index.js';

/** The apex the app is published at; tenants are one label under it. */
const PUBLIC_ORIGIN = 'https://example.com';
const ACME = 'https://acme.example.com';
const GLOBEX = 'https://globex.example.com';
const CSRF_HEADER = 'X-CSRF-Token';

/**
 * An API route answering with the tenant the request ran under. It imports the
 * same `jsails/database` module instance the plugin uses, by resolved URL,
 * because the fixture lives outside the workspace.
 */
const TENANT_ECHO = `import { currentTenantId } from ${JSON.stringify(import.meta.resolve('jsails/database'))};

const echo = () => Response.json({ tenant: currentTenantId() ?? null });
export const GET = echo;
export const POST = echo;
`;

function makeTenant(id: number, slug: string): Tenant {
  return Object.assign(new Tenant(), { id, slug, name: slug, status: 'active', metadata: null });
}

const TENANTS = new Map([
  ['acme', makeTenant(1, 'acme')],
  ['globex', makeTenant(2, 'globex')],
]);

function sessionFor(data: Session['data']): Session {
  return createTestSession({ id: 'tenant-session', csrfToken: 'tenant-csrf-token-0123', data });
}

/** Members by tenant slug. */
const MEMBERS: Readonly<Record<string, readonly string[]>> = { acme: ['u1'], globex: ['u2'] };

async function startTenantApp(
  t: TestContext,
  session: Session,
  findMembership?: MembershipLookup,
): Promise<TestApplication> {
  const root = tempDir(t);
  mkdirSync(join(root, 'api'), { recursive: true });
  writeFileSync(join(root, 'api', 'whoami.mjs'), TENANT_ECHO);
  const app = await createTestApp({
    config: {
      rootDir: root,
      port: 0,
      server: { origin: PUBLIC_ORIGIN, hosts: ['*.example.com'] },
      resolveSession: () => session,
      authorize: () => true,
      extensions: [
        tenancyPlugin({
          resolveTenant: subdomainTenantResolver({
            rootDomain: 'example.com',
            findTenant: (slug) => TENANTS.get(slug) ?? null,
          }),
          findMembership:
            findMembership ??
            ((tenant, userId) =>
              (MEMBERS[tenant.slug] ?? []).includes(userId)
                ? Object.assign(new TenantMembership(), { id: 1, tenant, userId, role: 'member' })
                : null),
        }),
      ],
    },
  });
  t.after(() => app.close());
  return app;
}

/** A cookie-carrying form-style POST to `host`, sent from the page at `origin`. */
function cookiePost(host: string, origin: string, session: Session): Request {
  return new Request(`${host}/api/whoami`, {
    method: 'POST',
    headers: { origin, cookie: 'session=browser', [CSRF_HEADER]: session.csrfToken },
  });
}

describe('known holes: tenant subdomains and the cross-site check', () => {
  it('accepts a cookie POST from a tenant subdomain to itself', async (t) => {
    const session = sessionFor({ user: { id: 'u1' } });
    const app = await startTenantApp(t, session);
    const response = await app.fetch(cookiePost(ACME, ACME, session));
    assert.equal(response.status, 200, 'a tenant posting to its own subdomain is same-origin');
    assert.deepEqual(await response.json(), { tenant: 1 });
  });

  it("refuses a cookie POST from a sibling tenant's origin", async (t) => {
    const session = sessionFor({ user: { id: 'u1' } });
    const app = await startTenantApp(t, session);
    // The twin: the same POST from acme's own origin passes. Without it the
    // refusal below cannot tell a sibling check from refusing every subdomain.
    const own = await app.fetch(cookiePost(ACME, ACME, session));
    assert.equal(own.status, 200, 'the twin from the tenant origin itself passes');
    const response = await app.fetch(cookiePost(ACME, GLOBEX, session));
    assert.equal(response.status, 403, 'a sibling tenant origin is cross-site');
    // The same cookie POST on the apex, from the apex, passes too.
    const apex = await app.fetch(cookiePost(PUBLIC_ORIGIN, PUBLIC_ORIGIN, session));
    assert.equal(apex.status, 200);
  });
});

describe('known holes: membership is decided for the canonical user id', () => {
  it('asks about data.user.id, never a second id the session carries', async (t) => {
    const asked: string[] = [];
    const lookup: MembershipLookup = (tenant, userId) => {
      asked.push(userId);
      return (MEMBERS[tenant.slug] ?? []).includes(userId)
        ? Object.assign(new TenantMembership(), { id: 1, tenant, userId, role: 'member' })
        : null;
    };
    // `data.userId` names a member of acme; `data.user.id`, the id every
    // other gate reads, does not, so the tenant is refused.
    const mixed = await startTenantApp(t, sessionFor({ userId: 'u1', user: { id: 'u2' } }), lookup);
    const refused = await mixed.fetch(new Request(`${ACME}/api/whoami`));
    assert.deepEqual(await refused.json(), { tenant: null });
    assert.deepEqual(asked, ['u2']);

    // The member's own session is granted the tenant.
    const member = await startTenantApp(t, sessionFor({ user: { id: 'u1' } }), lookup);
    const granted = await member.fetch(new Request(`${ACME}/api/whoami`));
    assert.deepEqual(await granted.json(), { tenant: 1 });
  });
});
