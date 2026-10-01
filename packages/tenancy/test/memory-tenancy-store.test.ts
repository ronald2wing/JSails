/**
 * Tests for the in-memory tenancy store: the whole store contract, plus what
 * only the memory store promises. Transactions really interleave (a seat
 * check that skips `lockTenant` over-admits), statements of one transaction
 * run in call order, the statement hook can fail a statement, lock waits time
 * out, a throwing after-commit callback neither undoes the commit nor stops
 * the others, and options are validated.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import {
  createMemoryTenancyStore,
  type TenancyStatementEvent,
} from '../src/memory-tenancy-store.js';
import { at, createTenant, seatLimitedJoin, STORE_CONTRACT_CASES } from './store-contract-cases.js';
import { rejectedCode, thrownCode } from './thrown-code.js';

const run = promisify(execFile);

describe('memory tenancy store: contract', () => {
  for (const contractCase of STORE_CONTRACT_CASES) {
    it(contractCase.name, () => contractCase.run(createMemoryTenancyStore()));
  }
});

describe('memory tenancy store', () => {
  it('lets a seat check that skips lockTenant over-admit, as a database would', async () => {
    const store = createMemoryTenancyStore();
    const tenant = await createTenant(store, 'acme', 'alice');
    await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        seatLimitedJoin(store, tenant.id, `user-${index}`, 4, false),
      ),
    );
    assert.ok((await store.countMembers(tenant.id)) > 4);
  });

  it('runs the statements of one transaction one at a time, in call order', async () => {
    const order: string[] = [];
    let active = 0;
    let overlap = false;
    const store = createMemoryTenancyStore({
      async onStatement(event) {
        if (!event.inTransaction) {
          return;
        }
        active += 1;
        overlap ||= active > 1;
        order.push(event.statement);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
      },
    });
    const tenant = await createTenant(store, 'acme', 'alice');
    order.length = 0;
    await store.transaction(async (tx) => {
      await Promise.all([
        tx.countMembers(tenant.id),
        tx.tenantById(tenant.id),
        tx.membership(tenant.id, 'alice'),
      ]);
    });
    assert.equal(overlap, false);
    assert.deepEqual(order, ['countMembers', 'tenantById', 'membership']);
  });

  it('reports every statement to the hook and fails the ones it rejects', async () => {
    const events: TenancyStatementEvent[] = [];
    let fail = false;
    const store = createMemoryTenancyStore({
      onStatement(event) {
        events.push(event);
        if (fail) {
          throw new Error('injected fault');
        }
      },
    });
    const tenant = await createTenant(store, 'acme', 'alice');
    await store.tenantById(tenant.id);
    assert.deepEqual(events, [
      { statement: 'insertTenant', inTransaction: true },
      { statement: 'insertMembership', inTransaction: true },
      { statement: 'tenantById', inTransaction: false },
    ]);
    fail = true;
    let after: unknown;
    await assert.rejects(
      store.transaction(async (tx) => {
        await tx.lockTenant(tenant.id).catch(() => undefined);
        after = await rejectedCode(tx.tenantById(tenant.id));
      }),
      /injected fault/,
    );
    assert.equal(after, 'transaction_aborted');
    await assert.rejects(store.tenantById(tenant.id), /injected fault/);
  });

  it('refuses a lock wait longer than lockTimeoutMs', async () => {
    const store = createMemoryTenancyStore({ lockTimeoutMs: 20 });
    const tenant = await createTenant(store, 'acme', 'alice');
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = store.transaction(async (tx) => {
      await tx.lockTenant(tenant.id);
      locked();
      await held;
    });
    await isLocked;
    assert.equal(
      await rejectedCode(store.transaction((tx) => tx.lockTenant(tenant.id))),
      'transaction_conflict',
    );
    release();
    await holder;
  });

  it('keeps the commit and the other callbacks when an after-commit callback throws', async () => {
    const errors: unknown[] = [];
    const store = createMemoryTenancyStore({ onAfterCommitError: (error) => errors.push(error) });
    const ran: string[] = [];
    const failure = new Error('listener failed');
    const tenant = await store.transaction(async (tx) => {
      const created = await tx.insertTenant({
        slug: 'acme',
        name: 'Acme',
        plan: null,
        ownerUserId: 'alice',
        settings: '{}',
        createdAt: at(0),
      });
      await tx.insertMembership({
        tenantId: created.id,
        userId: 'alice',
        role: 'owner',
        invitedBy: null,
        createdAt: at(0),
      });
      tx.afterCommit(() => {
        throw failure;
      });
      tx.afterCommit(() => {
        ran.push('second');
      });
      return created;
    });
    assert.deepEqual(errors, [failure]);
    assert.deepEqual(ran, ['second']);
    assert.equal((await store.tenantById(tenant.id))?.slug, 'acme');
  });

  it('rethrows a failed after-commit callback on a microtask by default', async () => {
    const module = import.meta.resolve('../src/memory-tenancy-store.js');
    const script = [
      `const { createMemoryTenancyStore } = await import(${JSON.stringify(module)});`,
      "process.on('uncaughtException', (error) => { console.log('caught:' + error.message); });",
      'const store = createMemoryTenancyStore();',
      "await store.transaction(async (tx) => { tx.afterCommit(() => { throw new Error('listener failed'); }); });",
      "console.log('committed');",
    ].join('\n');
    const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', script]);
    assert.deepEqual(stdout.trim().split('\n').sort(), ['caught:listener failed', 'committed']);
  });

  it('refuses a callback that is not a function', async () => {
    const store = createMemoryTenancyStore();
    await store.transaction(async (tx) => {
      assert.equal(
        thrownCode(() => tx.afterCommit(JSON.parse('null') as () => void)),
        'invalid_store_input',
      );
    });
  });

  it('validates its options', () => {
    for (const options of [
      { lockTimeoutMs: 0 },
      { lockTimeoutMs: 600_001 },
      { lockTimeoutMs: 1.5 },
    ]) {
      assert.equal(
        thrownCode(() => createMemoryTenancyStore(options)),
        'invalid_store_options',
      );
    }
    assert.equal(
      thrownCode(() => createMemoryTenancyStore(JSON.parse('null') as Record<string, never>)),
      'invalid_store_options',
    );
  });

  it('keeps separate stores separate', async () => {
    const first = createMemoryTenancyStore();
    const second = createMemoryTenancyStore();
    const tenant = await createTenant(first, 'acme', 'alice');
    assert.equal(await second.tenantById(tenant.id), null);
    assert.equal((await createTenant(second, 'acme', 'bob')).id, tenant.id);
  });
});
