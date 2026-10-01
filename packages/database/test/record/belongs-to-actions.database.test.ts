/**
 * A `belongsTo` that declares `onDelete: 'cascade'` or `'set null'` with no
 * inverse `dependent`, on the run's driver: deleting the parent destroys or
 * nullifies the children as that `dependent` would, through the pipeline
 * when the action alone would skip their effects (a counter cache on another
 * parent, an attachment, a `lockVersion` bump), and by the action when it is
 * the whole work; a set delete that cannot run those effects is refused.
 */

import assert from 'node:assert/strict';
import { before, beforeEach, it } from 'node:test';

import { query } from '../../src/index.js';
import { column, defineModel, type ModelTarget } from '../../src/model/index.js';
import { ApplicationRecord, attachmentTable, type AttachmentBlob } from '../../src/record/index.js';
import { forEachDriver } from '../../src/testing/index.js';
import { suiteLifecycle } from '../query/fixtures/open-data-source.js';
import {
  memoryAttachments,
  openWriteSource,
  type MemoryAttachments,
} from './fixtures/open-write-source.js';

class Author extends ApplicationRecord {
  declare id: number;
  declare name: string;
}

class Thread extends ApplicationRecord {
  declare id: number;
  declare title: string;
  declare repliesCount: number;
}

/** Counts on its thread and holds a file: deleting one runs something. */
class Reply extends ApplicationRecord {
  declare id: number;
  declare body: string;
  declare threadId: number;
  declare authorId: number;
  declare file?: AttachmentBlob | null;
}

/** Versioned: clearing its key must bump the version. */
class Draft extends ApplicationRecord {
  declare id: number;
  declare body: string;
  declare authorId: number | null;
  declare lockVersion: number;
}

/** Nothing runs when one is deleted: the action is the whole work. */
class Mention extends ApplicationRecord {
  declare id: number;
  declare authorId: number;
}

defineModel(Author, { table: 'ba_authors', columns: { name: column.string(40) } });

defineModel(Thread, {
  table: 'ba_threads',
  columns: { title: column.string(40), repliesCount: column.integer({ default: 0 }) },
});

defineModel(Reply, {
  table: 'ba_replies',
  columns: { body: column.string(40) },
  attachments: { file: { kind: 'one' } },
  relations: {
    thread: { kind: 'belongsTo', target: () => Thread, counterCache: 'repliesCount' },
    author: { kind: 'belongsTo', target: () => Author, onDelete: 'cascade' },
  },
});

defineModel(Draft, {
  table: 'ba_drafts',
  columns: { body: column.string(40) },
  lockVersion: true,
  relations: {
    author: { kind: 'belongsTo', target: () => Author, nullable: true, onDelete: 'set null' },
  },
});

defineModel(Mention, {
  table: 'ba_mentions',
  columns: {},
  relations: { author: { kind: 'belongsTo', target: () => Author, onDelete: 'cascade' } },
});

const MODELS: readonly ModelTarget[] = [Author, Thread, Reply, Draft, Mention, attachmentTable];

void forEachDriver('belongsTo onDelete actions', () => {
  const lifecycle = suiteLifecycle();
  let attachments: MemoryAttachments;

  before(async () => {
    attachments = memoryAttachments();
    await openWriteSource(lifecycle, MODELS, { attachments });
  });

  beforeEach(async () => {
    await query(attachmentTable).deleteAll();
    await Reply.all().deleteAll({ skipEffects: true });
    await Draft.all().deleteAll();
    await Mention.all().deleteAll();
    await Thread.all().deleteAll();
    await Author.all().deleteAll({ skipEffects: true });
    attachments.disk.deleted.length = 0;
  });

  it("destroys and nullifies the children with their effects when the parent's row goes", async () => {
    const author = await Author.create({ name: 'ann' });
    const other = await Author.create({ name: 'bo' });
    const thread = await Thread.create({ title: 't' });
    const reply = Reply.build({ body: 'r', threadId: thread.id, authorId: author.id });
    reply.file = { key: 'reply.txt', contentType: 'text/plain', byteSize: 1 };
    await reply.save();
    await Reply.create({ body: 'kept', threadId: thread.id, authorId: other.id });
    const draft = await Draft.create({ body: 'd', authorId: author.id });
    await Mention.create({ authorId: author.id });
    assert.equal((await Thread.find(thread.id)).repliesCount, 2);

    await author.destroy();

    assert.equal(await Reply.where({ authorId: author.id }).count(), 0);
    assert.equal((await Thread.find(thread.id)).repliesCount, 1, 'the counter equals COUNT(*)');
    assert.deepEqual(attachments.disk.deleted, ['reply.txt'], 'the reply took its file along');
    assert.equal(await query(attachmentTable).count(), 0);
    const cleared = await Draft.find(draft.id);
    assert.equal(cleared.authorId, null);
    assert.equal(cleared.lockVersion, draft.lockVersion + 1, 'the version was bumped');
    assert.equal(await Mention.all().count(), 0, 'removed by the action');
  });

  it('refuses a set delete of the parent that cannot run the children through the pipeline', async () => {
    const author = await Author.create({ name: 'cy' });
    const thread = await Thread.create({ title: 't' });
    await Reply.create({ body: 'r', threadId: thread.id, authorId: author.id });
    await assert.rejects(() => Author.where({ id: author.id }).deleteAll(), {
      code: 'query.unsupported_set_write',
      context: { model: 'Author', effect: 'dependent' },
    });
    assert.equal(await Reply.all().count(), 1);
  });
});
