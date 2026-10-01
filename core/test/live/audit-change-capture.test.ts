/**
 * Audit regressions for live change capture (CNT-01): each test states the
 * correct behaviour for one audited defect or critic prediction. Those that
 * fail today are listed, with the failure they show, in
 * `scripts/expected-failures/content.json`.
 *
 * The target (CNT-10) is a key-only change feed: capture records which rows of
 * which collection changed, never their contents, and a write it cannot key (a
 * bulk update or delete by criteria) still marks the collection changed.
 *
 * The critic's soft-delete and restore case has no test: the data API has no
 * soft delete today, so there is no write to miss. It returns with the data
 * cluster's soft delete, which must emit the same collection-level change.
 */

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { BaseEntity, Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import type { JsailsDataSource } from '../../src/database/data-source.js';
import type { LiveChange } from '../../src/live/change-record.js';
import { auditCase, createEmptyDataSource } from '../../src/testing/index.js';

const SECRET_HASH = '$argon2id$v=19$audit-secret-hash';

@Entity('audit_capture_accounts')
class Account extends BaseEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 40, nullable: false })
  status!: string;

  @Column({ type: 'varchar', length: 120, nullable: false })
  passwordHash!: string;
}

const COLLECTION = 'Account';

async function capturing(
  t: TestContext,
): Promise<{ dataSource: JsailsDataSource; changes: LiveChange[] }> {
  const dataSource = await createEmptyDataSource([Account]);
  t.after(() => dataSource.destroy());
  const changes: LiveChange[] = [];
  dataSource.liveCapture.setListener((batch) => {
    changes.push(...batch);
  });
  return { dataSource, changes };
}

async function seed(status = 'active'): Promise<Account> {
  return Account.create({ status, passwordHash: SECRET_HASH }).save();
}

test(
  ...auditCase(
    'live/capture-row-contents',
    'a captured change carries the row key, not its columns',
  ),
  async (t) => {
    const { changes } = await capturing(t);
    await seed();
    assert.equal(changes.length, 1);
    assert.ok(
      !JSON.stringify(changes).includes(SECRET_HASH),
      'the password hash was copied into the change record (and the shared change log)',
    );
  },
);

/**
 * Run `write` and return every statement the driver executed for it, read from
 * the data source's logger so a read through any API (repository, query
 * builder, raw query) is counted. The query runners call the logger for every
 * statement whether or not logging is enabled.
 */
async function statementsOf(
  dataSource: JsailsDataSource,
  write: () => Promise<unknown>,
): Promise<string[]> {
  const statements: string[] = [];
  const logger = dataSource.logger;
  dataSource.logger = new Proxy(logger, {
    get(target, property, receiver) {
      if (property === 'logQuery') {
        return (query: string, ...rest: unknown[]) => {
          statements.push(query);
          return Reflect.apply(target.logQuery, target, [query, ...rest]);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    await write();
    // A flush scheduled past the commit still belongs to this write.
    await nextTurn();
  } finally {
    dataSource.logger = logger;
  }
  return statements;
}

test(
  ...auditCase('live/capture-reread', 'capturing a committed write issues no extra read'),
  async (t) => {
    const { dataSource, changes } = await capturing(t);
    const baselineAccount = await seed();
    const capturedAccount = await seed();
    changes.length = 0;

    dataSource.liveCapture.setListener(undefined);
    const baseline = await statementsOf(dataSource, async () => {
      baselineAccount.status = 'suspended';
      await baselineAccount.save();
    });
    dataSource.liveCapture.setListener((batch) => {
      changes.push(...batch);
    });
    const captured = await statementsOf(dataSource, async () => {
      capturedAccount.status = 'suspended';
      await capturedAccount.save();
    });

    assert.equal(changes.length, 1, 'the captured save produced no change');
    assert.ok(baseline.length > 0, 'the logger saw no statement for the uncaptured save');
    const extra = captured.length - baseline.length;
    assert.deepEqual(
      captured,
      baseline,
      `capture re-read the written row: ${extra} statement(s) beyond the uncaptured save`,
    );
  },
);

test(
  ...auditCase('live/capture-bulk-update', 'an update by criteria marks the collection changed'),
  async (t) => {
    const { changes } = await capturing(t);
    await seed('trial');
    await seed('trial');
    changes.length = 0;
    await Account.update({ status: 'trial' }, { status: 'expired' });
    assert.ok(
      changes.some((change) => change.collection === COLLECTION),
      'a bulk update reached no subscriber: live clients keep showing the old rows',
    );
  },
);

test(
  ...auditCase('live/capture-bulk-delete', 'a delete by criteria marks the collection changed'),
  async (t) => {
    const { changes } = await capturing(t);
    await seed('trial');
    changes.length = 0;
    await Account.delete({ status: 'trial' });
    assert.ok(
      changes.some((change) => change.collection === COLLECTION),
      'a bulk delete reached no subscriber: live clients keep showing deleted rows',
    );
  },
);
