/**
 * Known holes in the admin panel, each stated as the safe behaviour against a
 * real assembled app (`createTestApp` mounting `adminPlugin`).
 *
 * The scenario is the support desk: a `support` persona the panel admits may
 * work with customers but holds no right on payments. Every surface that shows
 * a resource's rows (its own routes, a relation manager, an inline manager, a
 * relation column, global search) must keep payment data from that persona.
 * The panel is a browser surface, so a header credential (bearer or API token)
 * never opens it (the panel's routes accept the session cookie only, so a
 * header session is no identity there: 401), and a request the panel refuses
 * must cost the server no body bytes.
 *
 * A case that fails today is listed in `scripts/expected-failures/security.json`
 * with the work package that closes it. A case that already holds stays here
 * as an ordinary regression test.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Session } from 'jsails';
import { createTestSession, postForm, type TestApplication } from 'jsails/testing';

import {
  defineAdminAction,
  defineAdminPage,
  defineRelationManager,
  defineResource,
  type AdminResourceAuthorize,
  type Resource,
} from '../src/index.js';
import { createAdminTestApp, SESSION } from './fixtures.js';

/** The marker every payment row carries; it must never reach the support persona. */
const SECRET = 'card-ending-4242';

const PAYMENTS = [
  { id: 'pay1', customer_id: 'c1', reference: `${SECRET} refund` },
  { id: 'pay2', customer_id: 'c1', reference: `${SECRET} charge` },
];

/** Allow the support persona everything on customers. */
const customersAuthorize: AdminResourceAuthorize = () => true;
/** The support persona holds no right on payments. */
const paymentsAuthorize: AdminResourceAuthorize = () => false;

function definePayments(authorize: AdminResourceAuthorize | undefined): Resource {
  return defineResource({
    slug: 'payments',
    label: 'Payments',
    ...(authorize === undefined ? {} : { authorize }),
    // The reference leads, so it is what a search result is labelled with.
    columns: [
      { name: 'reference', label: 'Reference', searchable: true },
      { name: 'id', label: 'ID' },
    ],
    fields: [{ name: 'reference', label: 'Reference', type: 'text' }],
    list: async () => ({ rows: PAYMENTS, total: PAYMENTS.length }),
    get: async ({ id }) => PAYMENTS.find((row) => row.id === id) ?? null,
  });
}

/** Customers, carrying a relation manager and a relation column onto payments. */
function defineCustomers(payments: Resource): Resource {
  const manager = defineRelationManager({
    name: 'customer-payments',
    label: 'Payments',
    related: payments,
    foreignKey: 'customer_id',
    list: async () => ({ rows: PAYMENTS, total: PAYMENTS.length }),
  });
  return defineResource({
    slug: 'customers',
    label: 'Customers',
    authorize: customersAuthorize,
    columns: [
      { name: 'id', label: 'ID' },
      { name: 'name', label: 'Name', searchable: true },
      {
        name: 'payments',
        label: 'Payments',
        type: 'relation',
        related: payments,
        resolve: () => PAYMENTS.map((row) => row.reference),
      },
    ],
    fields: [{ name: 'name', label: 'Name', type: 'text' }],
    relationManagers: [manager],
    list: async () => ({ rows: [{ id: 'c1', name: `Customer ${SECRET.length}` }], total: 1 }),
    get: async ({ id }) => (id === 'c1' ? { id: 'c1', name: 'Customer' } : null),
  });
}

async function supportDesk(): Promise<TestApplication> {
  const payments = definePayments(paymentsAuthorize);
  return createAdminTestApp({ resources: [defineCustomers(payments), payments] });
}

describe('known holes: the panel is a browser surface', () => {
  it('refuses a bearer or API-token session on every panel route', async () => {
    for (const authMethod of ['bearer', 'api-token']) {
      const tokenSession: Session = createTestSession({
        data: { ...SESSION.data, authMethod },
      });
      const payments = definePayments(() => true);
      const app = await createAdminTestApp({
        resolveSession: () => tokenSession,
        resources: [payments],
      });
      try {
        for (const path of [
          '/admin',
          '/admin/payments',
          '/admin/payments/pay1',
          '/admin/_search',
        ]) {
          assert.equal((await app.request(path)).status, 401, `${authMethod} ${path}`);
        }
      } finally {
        await app.close();
      }
    }
    // The same panel opens for the browser session the fixture resolves.
    const app = await createAdminTestApp({ resources: [definePayments(() => true)] });
    try {
      assert.equal((await app.request('/admin/payments')).status, 200);
    } finally {
      await app.close();
    }
  });
});

describe('known holes: a persona without a resource right cannot reach it', () => {
  it("refuses the resource's own routes", async () => {
    const app = await supportDesk();
    try {
      for (const path of ['/admin/payments', '/admin/payments/pay1']) {
        const response = await app.request(path);
        assert.equal(response.status, 403, path);
        assert.doesNotMatch(await response.text(), new RegExp(SECRET));
      }
    } finally {
      await app.close();
    }
  });

  it('refuses it through a relation manager', async () => {
    const app = await supportDesk();
    try {
      const response = await app.request('/admin/customers/customer-payments?parent=c1');
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), new RegExp(SECRET));
    } finally {
      await app.close();
    }
  });

  it('leaves the inline manager off the parent form', async () => {
    const app = await supportDesk();
    try {
      const response = await app.request('/admin/customers/c1');
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.doesNotMatch(body, /class="admin-relation-manager"/);
      assert.doesNotMatch(body, new RegExp(SECRET));
    } finally {
      await app.close();
    }
  });

  it('leaves the relation column off the parent list', async () => {
    const app = await supportDesk();
    try {
      const response = await app.request('/admin/customers');
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), new RegExp(SECRET));
    } finally {
      await app.close();
    }
  });

  it('leaves its rows out of global search', async () => {
    const app = await supportDesk();
    try {
      // The term matches a payment row; the page echoes the term, never the row.
      const response = await app.request('/admin/_search?q=refund');
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), new RegExp(SECRET));
    } finally {
      await app.close();
    }
  });
});

describe('known holes: the support-desk surfaces do show payments to a persona with the right', () => {
  // The twin of the cases above: with the right granted, every surface shows
  // the payment rows, so each refusal above is the gate's doing.
  it('shows payments on every surface once the persona may see them', async () => {
    const payments = definePayments(() => true);
    const app = await createAdminTestApp({ resources: [defineCustomers(payments), payments] });
    try {
      for (const path of [
        '/admin/payments',
        '/admin/customers/customer-payments?parent=c1',
        '/admin/customers',
        '/admin/_search?q=refund',
      ]) {
        const response = await app.request(path);
        assert.equal(response.status, 200, path);
        assert.match(await response.text(), new RegExp(SECRET), path);
      }
      const form = await (await app.request('/admin/customers/c1')).text();
      assert.match(form, /class="admin-relation-manager"/);
    } finally {
      await app.close();
    }
  });
});

describe('known holes: a contribution without authorize is denied', () => {
  it('denies a resource, a page, and a row action that declare no authorize', async () => {
    const runs: string[] = [];
    const notes = defineResource({
      slug: 'notes',
      label: 'Notes',
      authorize: () => true,
      columns: [{ name: 'id', label: 'ID' }],
      fields: [{ name: 'title', label: 'Title', type: 'text' }],
      list: async () => ({ rows: [{ id: 'n1' }], total: 1 }),
      get: async ({ id }) => ({ id }),
      actions: {
        row: [
          defineAdminAction({
            name: 'pin',
            label: 'Pin',
            run: (_context, records) => {
              runs.push(...records.map((record) => String(record['id'])));
            },
          }),
          defineAdminAction({
            name: 'star',
            label: 'Star',
            authorize: () => true,
            run: (_context, records) => {
              runs.push(...records.map((record) => `star:${String(record['id'])}`));
            },
          }),
        ],
      },
    });
    const app = await createAdminTestApp({
      resources: [definePayments(undefined), notes],
      pages: [
        defineAdminPage({ slug: 'reports', label: 'Reports', render: () => SECRET }),
        defineAdminPage({
          slug: 'summary',
          label: 'Summary',
          authorize: () => true,
          render: () => `summary ${SECRET}`,
        }),
      ],
    });
    try {
      assert.equal((await app.request('/admin/payments')).status, 403);
      const page = await app.request('/admin/reports');
      assert.equal(page.status, 403);
      assert.doesNotMatch(await page.text(), new RegExp(SECRET));
      // Its twin with an authorize renders, so the refusal is the missing callback's doing.
      const twin = await app.request('/admin/summary');
      assert.equal(twin.status, 200, 'the page with an authorize renders');
      assert.match(await twin.text(), new RegExp(`summary ${SECRET}`));
      await postForm(app, '/admin/notes/n1/actions/pin', {});
      assert.deepEqual(runs, []);
      // Its twin with an authorize runs, so the refusal is the missing callback's doing.
      await postForm(app, '/admin/notes/n1/actions/star', {});
      assert.deepEqual(runs, ['star:n1']);
    } finally {
      await app.close();
    }
  });
});

describe('known holes: the panel gate runs before the body is read', () => {
  it('reads no body bytes for a POST from a session the panel refuses', async () => {
    const payments = definePayments(() => true);
    const app = await createAdminTestApp({ resolveSession: () => null, resources: [payments] });
    try {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (pulled >= 64 * 1024) {
              controller.close();
              return;
            }
            pulled += 1024;
            controller.enqueue(new Uint8Array(1024).fill(0x61));
          },
        },
        { highWaterMark: 0 },
      );
      const response = await app.request('/admin/payments', {
        method: 'POST',
        headers: {
          origin: app.origin,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        duplex: 'half',
      } as RequestInit);
      assert.equal(response.status, 401);
      assert.equal(pulled, 0, 'body bytes read before the panel refused the session');
    } finally {
      await app.close();
    }
  });
});
