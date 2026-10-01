/**
 * `hasOneAttached` over a real sql.js data source and an in-memory `Disk`:
 * attach stores the blob and persists a row, `url` prefixes the key, `detach`
 * removes both, and every attach gets a unique key.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
  ActiveStorageError,
  activeStorageEntities,
  hasOneAttached,
  JsailsAttachment,
} from '../../src/database/active-storage.js';
import type { JsailsDataSource } from '../../src/database/data-source.js';
import type { Disk } from '../../src/filesystem/disk.js';
import { meterByteSource, resolveDiskRange } from '../../src/filesystem/byte-source.js';
import { DiskErrors } from '../../src/filesystem/disk-errors.js';
import { readBytes } from '../../src/filesystem/read-bytes.js';
import { createEmptyDataSource, tempDir } from '../../src/testing/index.js';

/** A `Disk` over a `Map`: enough to observe what ActiveStorage stores and removes. */
function createMapDisk(): Disk {
  const files = new Map<string, Uint8Array>();
  return {
    async write(key, source, options) {
      const metered = meterByteSource(source, options);
      const chunks: Uint8Array[] = [];
      for await (const chunk of metered.chunks) chunks.push(new Uint8Array(chunk));
      files.set(key, Buffer.concat(chunks));
      return metered.result();
    },
    async read(key, options) {
      const bytes = files.get(key);
      if (bytes === undefined) throw new DiskErrors.Error('not_found');
      const { start, end } = resolveDiskRange(options?.range, bytes.byteLength);
      return {
        stream: new Blob([bytes.slice(start, end + 1)]).stream(),
        size: bytes.byteLength,
        start,
        end,
      };
    },
    async stat(key) {
      const bytes = files.get(key);
      return bytes === undefined ? null : { size: bytes.byteLength, modifiedAt: new Date(0) };
    },
    async delete(key) {
      files.delete(key);
    },
    async deletePrefix(prefix) {
      for (const key of [...files.keys()]) if (key.startsWith(`${prefix}/`)) files.delete(key);
    },
    async list(prefix) {
      return { keys: [...files.keys()].filter((key) => key.startsWith(prefix)).sort() };
    },
  };
}

async function createDataSource(t: TestContext): Promise<JsailsDataSource> {
  const dataSource = await createEmptyDataSource([...activeStorageEntities], {
    location: join(tempDir(t), 'active-storage.sqlite'),
  });
  t.after(() => dataSource.destroy());
  return dataSource;
}

async function setup(t: TestContext) {
  const dataSource = await createDataSource(t);
  const disk = createMapDisk();
  const avatar = hasOneAttached({
    disk,
    name: 'avatar',
    recordType: 'User',
    dataSource,
    urlPrefix: '/uploads',
  });
  return { dataSource, disk, avatar };
}

describe('hasOneAttached', () => {
  it('attach stores the blob on the disk and persists a row', async (t) => {
    const { disk, avatar } = await setup(t);

    const data = new Uint8Array([1, 2, 3, 4]);
    const attachment = await avatar.attach({ id: 1 }, data, 'image/png');

    assert.equal(attachment.recordType, 'User');
    assert.equal(attachment.recordId, 1);
    assert.equal(attachment.name, 'avatar');
    assert.equal(attachment.contentType, 'image/png');
    assert.equal(attachment.byteSize, 4);
    assert.ok(attachment.key.length > 0, 'key must be non-empty');
    assert.ok(attachment.createdAt instanceof Date);

    assert.deepEqual(await readBytes(disk, attachment.key, { maxBytes: 64 }), data);

    const count = await JsailsAttachment.countBy({
      recordType: 'User',
      recordId: 1,
      name: 'avatar',
    });
    assert.equal(count, 1);
  });

  it('url returns the prefixed URL for an existing attachment', async (t) => {
    const { avatar } = await setup(t);

    const attachment = await avatar.attach({ id: 1 }, new Uint8Array([0]), 'text/plain');
    assert.equal(await avatar.url({ id: 1 }), `/uploads/${attachment.key}`);
  });

  it('url returns null when no attachment exists', async (t) => {
    const { avatar } = await setup(t);

    assert.equal(await avatar.url({ id: 999 }), null);
  });

  it('url returns null when no urlPrefix is configured', async (t) => {
    const dataSource = await createDataSource(t);
    const avatar = hasOneAttached({
      disk: createMapDisk(),
      name: 'avatar',
      recordType: 'User',
      dataSource,
    });

    await avatar.attach({ id: 1 }, new Uint8Array([0]), 'text/plain');
    assert.equal(await avatar.url({ id: 1 }), null);
  });

  it('detach removes the blob and the row', async (t) => {
    const { disk, avatar } = await setup(t);

    const attachment = await avatar.attach({ id: 1 }, new Uint8Array([0]), 'text/plain');

    await avatar.detach({ id: 1 });

    assert.equal(await disk.stat(attachment.key), null);

    const count = await JsailsAttachment.countBy({
      recordType: 'User',
      recordId: 1,
      name: 'avatar',
    });
    assert.equal(count, 0);
  });

  it('detach is a no-op when no attachment exists', async (t) => {
    const { avatar } = await setup(t);

    await avatar.detach({ id: 999 });
  });

  it('attach / url / detach / url round-trip', async (t) => {
    const { avatar } = await setup(t);

    assert.equal(await avatar.url({ id: 1 }), null);

    const attachment = await avatar.attach(
      { id: 1 },
      new Uint8Array([1, 2, 3]),
      'application/octet-stream',
    );
    assert.ok(attachment.id > 0);

    const url = await avatar.url({ id: 1 });
    assert.ok(typeof url === 'string');

    await avatar.detach({ id: 1 });
    assert.equal(await avatar.url({ id: 1 }), null);
  });

  it('each attach generates a unique key', async (t) => {
    const { avatar } = await setup(t);

    const a1 = await avatar.attach({ id: 1 }, new Uint8Array([1]), 'text/plain');
    const a2 = await avatar.attach({ id: 2 }, new Uint8Array([2]), 'text/plain');

    assert.notEqual(a1.key, a2.key);
  });

  it('re-attaching to the same record keeps both rows and blobs', async (t) => {
    const { avatar, disk } = await setup(t);

    const first = await avatar.attach({ id: 1 }, new Uint8Array([1]), 'text/plain');
    const second = await avatar.attach({ id: 1 }, new Uint8Array([9, 9]), 'text/plain');

    // Replacing an attachment is the caller's job: detach first, then attach.
    const count = await JsailsAttachment.countBy({
      recordType: 'User',
      recordId: 1,
      name: 'avatar',
    });
    assert.equal(count, 2);

    assert.notEqual(await disk.stat(first.key), null);
    assert.notEqual(await disk.stat(second.key), null);
    assert.notEqual(await avatar.url({ id: 1 }), null);
  });
});

describe('activeStorageEntities', () => {
  it('is the only entity in activeStorageEntities', () => {
    assert.deepEqual(activeStorageEntities, [JsailsAttachment]);
  });
});

describe('ActiveStorageError', () => {
  it('carries its code and name', () => {
    const error = new ActiveStorageError('missing_data_source', 'data source is not initialized');
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ActiveStorageError');
    assert.equal(error.code, 'missing_data_source');
  });
});
