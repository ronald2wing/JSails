/**
 * The data migration that upgrades stored blog bodies to the current
 * rich-text version: post and page bodies, and the bodies inside post and
 * page revision snapshots.
 *
 * A body is read only through `parseRichText`, which refuses an older
 * version by number, so a body written before the upgrade is unreadable
 * (`unreadable_body`) until this migration has run. The app lists it in the
 * `dataMigrations` export of its `jsails.database.js`, and `db:push` runs it
 * after the schema phase has dropped the old editor columns.
 *
 * It is idempotent, as every data migration must be: a body `parseRichText`
 * already reads is left untouched. A first pass only reads: when any stored
 * body cannot be upgraded the migration fails with the count of such bodies
 * and their row ids (never their content) before writing anything, so the
 * operator can find the rows that need a hand edit and the tables are left as
 * they were. The second pass writes, inside the migration's transaction, and
 * only over the columns the first pass found a body to upgrade in.
 */

import type { DataMigration, DataMigrationContext } from 'jsails';
import { parseRichText, upgradeRichTextDocument } from 'jsails/rich-text';
import type { EntityManager, EntityTarget } from 'typeorm';

import { BlogContentError } from '../cms/repository.js';
import { JsailsBlogPage, JsailsBlogPost, JsailsBlogRevision } from './entities.js';

/** Rows read per query, so a large table is never held in memory at once. */
const BATCH_SIZE = 200;

/** The keys an editor envelope added to a snapshot before bodies were canonical. */
const RETIRED_SNAPSHOT_KEYS: readonly string[] = ['editor', 'native'];

interface BodyRow {
  readonly id: number;
  readonly value: unknown;
}

/** The upgraded value of one stored column, `unchanged`, or `failed`. */
type Upgraded = { readonly value: unknown } | 'unchanged' | 'failed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Upgrade one stored body. */
function upgradeBody(stored: unknown): Upgraded {
  if (parseRichText(stored).ok) {
    return 'unchanged';
  }
  const upgraded = upgradeRichTextDocument(stored);
  return upgraded.ok ? { value: upgraded.value } : 'failed';
}

/**
 * Upgrade the body inside one revision snapshot and drop the retired editor
 * keys. A snapshot without a body is not a content snapshot and is left as
 * it is; restore validates it against the snapshot schema either way.
 */
function upgradeSnapshot(stored: unknown): Upgraded {
  if (!isRecord(stored) || !Object.hasOwn(stored, 'blocks')) {
    return 'unchanged';
  }
  const body = upgradeBody(stored['blocks']);
  if (body === 'failed') {
    return 'failed';
  }
  const retired = RETIRED_SNAPSHOT_KEYS.some((key) => Object.hasOwn(stored, key));
  if (body === 'unchanged' && !retired) {
    return 'unchanged';
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!RETIRED_SNAPSHOT_KEYS.includes(key)) {
      next[key] = key === 'blocks' && body !== 'unchanged' ? body.value : value;
    }
  }
  return { value: next };
}

/** One stored JSON column and how its values are upgraded. */
interface UpgradedColumn {
  readonly target: EntityTarget<JsailsBlogPost | JsailsBlogPage | JsailsBlogRevision>;
  readonly column: 'blocks' | 'snapshot';
  readonly upgrade: (stored: unknown) => Upgraded;
}

const COLUMNS: readonly UpgradedColumn[] = [
  { target: JsailsBlogPost, column: 'blocks', upgrade: upgradeBody },
  { target: JsailsBlogPage, column: 'blocks', upgrade: upgradeBody },
  { target: JsailsBlogRevision, column: 'snapshot', upgrade: upgradeSnapshot },
];

/** What a read-only pass over one column found. */
interface ColumnScan {
  /** Row ids whose value cannot be upgraded. */
  readonly failed: readonly number[];
  /** Whether any value needs writing. */
  readonly pending: boolean;
}

/** Most failing row ids one error names, so the message stays bounded. */
const MAX_REPORTED_IDS = 20;

/**
 * Walk one column in id order, batch by batch, writing each upgraded value
 * when `write` is set.
 */
async function upgradeColumn(
  manager: EntityManager,
  { target, column, upgrade }: UpgradedColumn,
  write: boolean,
): Promise<ColumnScan> {
  const failed: number[] = [];
  let pending = false;
  let after = 0;
  for (;;) {
    const rows: BodyRow[] = (
      await manager
        .createQueryBuilder(target, 'row')
        .select(['row.id', `row.${column}`])
        .where('row.id > :after', { after })
        .orderBy('row.id', 'ASC')
        .take(BATCH_SIZE)
        .getMany()
    ).map((row) => ({ id: row.id, value: (row as unknown as Record<string, unknown>)[column] }));
    for (const row of rows) {
      const result = upgrade(row.value);
      if (result === 'failed') {
        failed.push(row.id);
      } else if (result !== 'unchanged') {
        pending = true;
        if (write) {
          await manager.update(target, { id: row.id }, { [column]: result.value });
        }
      }
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < BATCH_SIZE) {
      return { failed, pending };
    }
    after = last.id;
  }
}

/**
 * The failing rows as `table#id` references: database row ids, never content,
 * so the operator can find the rows to edit by hand.
 */
function failedRows(manager: EntityManager, scans: readonly ColumnScan[]): string {
  const references = COLUMNS.flatMap((column, index) => {
    const table = manager.getRepository(column.target).metadata.tableName;
    return (scans[index]?.failed ?? []).map((id) => `${table}#${String(id)}`);
  });
  const shown = references.slice(0, MAX_REPORTED_IDS).join(', ');
  return references.length > MAX_REPORTED_IDS ? `${shown}, ...` : shown;
}

async function up({ queryRunner }: DataMigrationContext): Promise<void> {
  const manager = queryRunner.manager;
  // Runs on every `db:push`, so the read-only pass also decides whether a
  // write pass is needed at all: once every body is current it is skipped.
  const scans: ColumnScan[] = [];
  for (const column of COLUMNS) {
    scans.push(await upgradeColumn(manager, column, false));
  }
  const failed = scans.reduce((count, scan) => count + scan.failed.length, 0);
  if (failed > 0) {
    throw new BlogContentError(
      'unreadable_body',
      `${String(failed)} stored blog bodies cannot be upgraded (${failedRows(manager, scans)}); none were written`,
    );
  }
  for (const [index, column] of COLUMNS.entries()) {
    if (scans[index]?.pending === true) {
      await upgradeColumn(manager, column, true);
    }
  }
}

/** The upgrade is one-way: no older reader exists to write bodies back for. */
function down(): Promise<void> {
  return Promise.reject(
    new BlogContentError('unsupported_construct', 'the blog body upgrade cannot be reverted'),
  );
}

/**
 * Upgrade every stored blog body to the current rich-text version. List it
 * in the `dataMigrations` export of `jsails.database.js`.
 *
 * @public
 */
export const blogRichTextUpgrade: DataMigration = Object.freeze({
  name: 'blog_rich_text_upgrade',
  transactional: true,
  up,
  down,
});
