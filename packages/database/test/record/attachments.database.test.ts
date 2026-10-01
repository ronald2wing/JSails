/**
 * Attachments on the run's driver: one row per record and name in
 * `jsails_attachments` (unique), replaced rather than appended; the replaced
 * blob deleted only after commit and only when no row names it any more (a
 * blob two records share, or the one already stored, stays); a blob a
 * rolled-back save named deleted only when the record no longer holds it, so
 * a retry saves it with its bytes; a primary-key change moves the rows; a
 * failed cleanup reported without changing the write's outcome; detaching
 * and destroying delete rows in the transaction and blobs after it;
 * `attachmentOf` reads one; malformed values, set writes that cannot delete
 * blobs, and a data source without the attachment options are refused.
 */

import assert from 'node:assert/strict';
import { before, beforeEach, it } from 'node:test';

import { query, type JsailsDataSource } from '../../src/index.js';
import { column, defineModel, type ModelTarget } from '../../src/model/index.js';
import {
  ApplicationRecord,
  attachmentOf,
  attachmentTable,
  JsailsDataSource as DataSource,
  type AttachmentBlob,
} from '../../src/record/index.js';
import { forEachDriver } from '../../src/testing/index.js';
import { suiteLifecycle } from '../query/fixtures/open-data-source.js';
import {
  memoryAttachments,
  openWriteSource,
  recordChanges,
  type MemoryAttachments,
  type MemoryDisk,
} from './fixtures/open-write-source.js';

class Profile extends ApplicationRecord {
  declare id: number;
  declare handle: string;
  declare avatar?: AttachmentBlob | null;
}

/** A model keyed by a string the application chooses, so the key can change. */
class Badge extends ApplicationRecord {
  declare slug: string;
  declare label: string;
  declare icon?: AttachmentBlob | null;
}

/** Saves of handles listed here fail in `afterSave`, after the attachment row was written. */
const FAILING = new Set<string>();

defineModel(
  Profile,
  {
    table: 'at_profiles',
    columns: { handle: column.string(40) },
    attachments: { avatar: { kind: 'one' } },
  },
  {
    hooks: {
      afterSave: ({ record }) => {
        if (FAILING.has(record.handle)) throw new Error('afterSave failed');
      },
    },
  },
);

defineModel(Badge, {
  table: 'at_badges',
  primaryKey: 'slug',
  columns: { slug: column.string(40), label: column.string(40) },
  attachments: { icon: { kind: 'one' } },
});

const MODELS: readonly ModelTarget[] = [Profile, Badge, attachmentTable];

function blob(key: string): AttachmentBlob {
  return { key, contentType: 'image/png', byteSize: 3, filename: `${key}.png` };
}

void forEachDriver('attachments', () => {
  const lifecycle = suiteLifecycle();
  let dataSource: JsailsDataSource;
  let attachments: MemoryAttachments;
  let disk: MemoryDisk;

  before(async () => {
    attachments = memoryAttachments();
    disk = attachments.disk;
    dataSource = await openWriteSource(lifecycle, MODELS, { attachments });
  });

  beforeEach(async () => {
    await query(attachmentTable).deleteAll();
    await Profile.all().deleteAll({ skipHooks: true, skipEffects: true });
    await Badge.all().deleteAll({ skipEffects: true });
    disk.deleted.length = 0;
    disk.failing.clear();
    attachments.cleanupErrors.length = 0;
    FAILING.clear();
  });

  it('writes one row per record and name, replacing it and deleting the old blob after commit', async () => {
    const profile = Profile.build({ handle: 'ann' });
    profile.avatar = blob('a1');
    await profile.save();
    const stored = await attachmentOf(profile, 'avatar');
    assert.ok(stored !== null);
    assert.deepEqual(
      { ...stored, createdAt: stored.createdAt instanceof Date },
      { key: 'a1', contentType: 'image/png', byteSize: 3, filename: 'a1.png', createdAt: true },
    );
    assert.deepEqual(await profile.save().then(() => disk.deleted), [], 'nothing pending');

    await dataSource.transaction(async () => {
      profile.avatar = blob('a2');
      await profile.save();
      assert.deepEqual(disk.deleted, [], 'the replaced blob outlives the transaction');
    });
    assert.deepEqual(disk.deleted, ['a1']);
    assert.equal((await attachmentOf(profile, 'avatar'))?.key, 'a2');
    assert.equal(await query(attachmentTable).count(), 1, 'replaced, not appended');
  });

  it('keeps the blob a rolled-back save still holds, so a retry saves it with its bytes', async () => {
    const profile = Profile.build({ handle: 'bo' });
    profile.avatar = blob('b1');
    await profile.save();
    FAILING.add('bo');
    profile.avatar = blob('b2');
    await assert.rejects(() => profile.save(), /afterSave failed/);
    assert.deepEqual(disk.deleted, [], 'the record still holds b2');
    assert.equal((await attachmentOf(profile, 'avatar'))?.key, 'b1');
    FAILING.clear();
    await profile.save();
    assert.equal(
      (await attachmentOf(profile, 'avatar'))?.key,
      'b2',
      'still pending after the rollback',
    );
    assert.deepEqual(disk.deleted, ['b1'], 'b2 was never deleted; b1 went once replaced');

    // A transaction run again by its retry option saves the same blob again.
    const retried = Profile.build({ handle: 'bea' });
    const upload = blob('b3');
    let runs = 0;
    await dataSource.transaction(
      async () => {
        runs += 1;
        retried.avatar = upload;
        await retried.save();
        if (runs === 1) throw new Error('transient');
      },
      { retry: { attempts: 2, on: (error) => (error as Error).message === 'transient' } },
    );
    assert.equal(runs, 2);
    assert.equal((await attachmentOf(retried, 'avatar'))?.key, 'b3');
    assert.deepEqual(disk.deleted, ['b1'], 'the retried blob keeps its bytes');
  });

  it('deletes a blob a rolled-back transaction named that the record no longer holds', async () => {
    const profile = Profile.build({ handle: 'cal' });
    await assert.rejects(
      dataSource.transaction(async () => {
        profile.avatar = blob('k1');
        await profile.save();
        profile.avatar = blob('k2');
        await profile.save();
        throw new Error('rolled back');
      }),
      /rolled back/,
    );
    assert.deepEqual(disk.deleted, ['k1'], 'k2 is still held, k1 by nothing');
    assert.equal(profile.isPersisted(), false);
    await profile.save();
    assert.equal((await attachmentOf(profile, 'avatar'))?.key, 'k2');
  });

  it('never deletes a blob an attachment row still names', async () => {
    const profile = Profile.build({ handle: 'dee' });
    profile.avatar = blob('kept');
    await profile.save();

    // The stored blob again, renamed, in a transaction that rolls back.
    await assert.rejects(
      dataSource.transaction(async () => {
        profile.avatar = { ...blob('kept'), filename: 'renamed.png' };
        await profile.save();
        profile.avatar = blob('other');
        throw new Error('rolled back');
      }),
      /rolled back/,
    );
    // The stored blob assigned to a loaded record, which remembers nothing as saved.
    const loaded = await Profile.find(profile.id);
    await assert.rejects(
      dataSource.transaction(async () => {
        loaded.avatar = blob('kept');
        await loaded.save();
        loaded.avatar = null;
        throw new Error('rolled back');
      }),
      /rolled back/,
    );
    assert.deepEqual(disk.deleted, [], 'the committed row names kept');
    assert.equal((await attachmentOf(profile, 'avatar'))?.key, 'kept');

    // Two records naming one blob: replacing or destroying one keeps it for the other.
    const twin = Profile.build({ handle: 'dex' });
    twin.avatar = blob('kept');
    await twin.save();
    profile.avatar = blob('own');
    await profile.save();
    assert.deepEqual(disk.deleted, [], 'the twin still names kept');
    await twin.destroy();
    assert.deepEqual(disk.deleted, ['kept'], 'deleted once nothing names it');
  });

  it('moves the attachment rows when save() changes the primary key', async () => {
    const badge = Badge.build({ slug: 'gold', label: 'Gold' });
    badge.icon = blob('gold');
    await badge.save();
    badge.slug = 'gilded';
    await badge.save();
    assert.equal((await attachmentOf(badge, 'icon'))?.key, 'gold', 'the rows follow the key');
    const newcomer = await Badge.create({ slug: 'gold', label: 'Imposter' });
    assert.equal(await attachmentOf(newcomer, 'icon'), null, 'nothing is left under the old key');

    // A key change and a new attachment in one save: the moved row is replaced.
    badge.slug = 'golden';
    badge.icon = blob('golden');
    await badge.save();
    assert.equal((await attachmentOf(badge, 'icon'))?.key, 'golden');
    assert.equal(await query(attachmentTable).count(), 1);
    assert.deepEqual(disk.deleted, ['gold']);
    await badge.destroy();
    assert.equal(await query(attachmentTable).count(), 0);
    assert.deepEqual(disk.deleted, ['gold', 'golden']);
  });

  it("reports a failed cleanup without changing the write's outcome", async () => {
    const profile = Profile.build({ handle: 'eve' });
    profile.avatar = blob('e1');
    await profile.save();
    disk.failing.add('e1');
    profile.avatar = blob('e2');
    await profile.save();
    assert.equal((await attachmentOf(profile, 'avatar'))?.key, 'e2', 'the save committed');
    assert.deepEqual(disk.deleted, []);
    assert.equal(attachments.cleanupErrors.length, 1);
    assert.match(String(attachments.cleanupErrors[0]), /disk unavailable/);

    // A rolled-back write keeps its own failure, not the cleanup's.
    const failure = new Error('the caller failed');
    disk.failing.add('e3');
    await assert.rejects(
      dataSource.transaction(async () => {
        profile.avatar = blob('e3');
        await profile.save();
        profile.avatar = blob('e4');
        await profile.save();
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(attachments.cleanupErrors.length, 2);
    assert.deepEqual(disk.deleted, []);
    profile.avatar = undefined;

    // So does a destroy whose blob cannot be deleted.
    disk.failing.add('e2');
    await profile.destroy();
    assert.equal(await query(attachmentTable).count(), 0);
    assert.equal(attachments.cleanupErrors.length, 3);
  });

  it('detaches with null and deletes rows and blobs on destroy', async () => {
    const profile = Profile.build({ handle: 'cy' });
    profile.avatar = blob('c1');
    await profile.save();
    profile.avatar = null;
    await profile.save();
    assert.equal(await attachmentOf(profile, 'avatar'), null);
    assert.deepEqual(disk.deleted, ['c1']);

    const other = Profile.build({ handle: 'di' });
    other.avatar = blob('d1');
    await other.save();
    const changes = recordChanges(dataSource);
    try {
      await other.destroy();
      assert.deepEqual(disk.deleted, ['c1', 'd1']);
      assert.equal(await query(attachmentTable).count(), 0);
      assert.ok(changes.take().some((record) => record.collection === 'jsails_attachments'));
    } finally {
      changes.stop();
    }
  });

  it('refuses malformed values, unknown names and set writes that would orphan blobs', async () => {
    const profile = Profile.build({ handle: 'ed' });
    profile.avatar = { key: '', contentType: 'image/png', byteSize: 1 };
    await assert.rejects(() => profile.save(), {
      code: 'record.invalid_attachment',
      context: { model: 'Profile', attachment: 'avatar' },
    });
    profile.avatar = undefined;
    await profile.save();
    await assert.rejects(() => attachmentOf(profile, 'banner'), {
      code: 'record.unknown_attachment',
    });
    await assert.rejects(() => Profile.all().deleteAll({ skipHooks: true }), {
      code: 'query.unsupported_set_write',
      context: { model: 'Profile', effect: 'attachment' },
    });
    await assert.rejects(
      () =>
        Profile.where({ id: profile.id }).updateAll({ id: profile.id + 1 }, { skipHooks: true }),
      {
        code: 'query.unsupported_set_write',
        context: { model: 'Profile', effect: 'attachment' },
      },
    );
    await Profile.where({ id: profile.id }).updateAll({ handle: 'renamed' }, { skipHooks: true });
    assert.equal((await Profile.find(profile.id)).handle, 'renamed');
  });

  it('needs a disk and the attachment table on a data source with attachments', () => {
    // The options are checked before the models are bound, so the open data
    // source of this suite does not get in the way.
    const config = { dialect: 'sqlite' } as never;
    const refused = { code: 'data_source.invalid_options', context: { field: 'attachments' } };
    assert.throws(() => new DataSource({ config, models: [Profile, attachmentTable] }), refused);
    assert.throws(() => new DataSource({ config, models: [Profile], attachments }), refused);
    assert.throws(
      () => new DataSource({ config, models: [attachmentTable], attachments: {} as never }),
      refused,
    );
    assert.throws(
      () => new DataSource({ config, models: [attachmentTable], attachments: { disk } as never }),
      refused,
      'a data source with attachments names where a failed cleanup goes',
    );
  });
});
