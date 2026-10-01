/**
 * The `Disk` conformance suite against the three first-party disks: memory,
 * a local directory (with an injected ENOSPC while bytes flow), and S3 over
 * the fake bucket (with an injected 500 on the second part). The local and
 * memory runs are part of the Windows CI leg.
 */

import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import { runDiskContract, type DiskContractSubject } from '../src/testing/index.js';
import { LocalDisk, MemoryDisk, S3Disk } from '../src/index.js';
import { createFakeS3, MIN_PART_BYTES, serviceErrorFor, type FakeS3Options } from './fake-s3.js';

const LOCAL_PART = 64 * 1024;
const TEMP_FILE = /^\.[0-9a-f]{12}\.tmp$/;

/** Every temp file left under `dir`, relative to it. */
async function tempFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return []; // the root was never created
  }
  return entries
    .filter((entry) => entry.isFile() && TEMP_FILE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

async function localSubject(): Promise<DiskContractSubject & { readonly root: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'jsails-disk-contract-'));
  const root = join(dir, 'root');
  return {
    root,
    disk: new LocalDisk({ root }),
    leftovers: () => tempFiles(root),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * A local subject whose file writes fail with ENOSPC once a write has passed
 * one part, injected on the `FileHandle` write stream every write goes through.
 */
async function localSubjectWithFullDisk(): Promise<DiskContractSubject> {
  const subject = await localSubject();
  const probe = await open(join(subject.root, '..', 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe) as {
    createWriteStream(this: unknown, options?: object): Writable;
  };
  await probe.close();
  const original = prototype.createWriteStream;
  prototype.createWriteStream = function createFailingWriteStream(options) {
    const stream = original.call(this, options);
    const write = stream._write.bind(stream);
    let written = 0;
    // Without `_writev`, every buffered chunk goes through the patched `_write`.
    Object.defineProperty(stream, '_writev', { value: undefined });
    stream._write = (chunk: Buffer, encoding, callback) => {
      written += chunk.byteLength;
      if (written <= LOCAL_PART) {
        write(chunk, encoding, callback);
        return;
      }
      callback(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    };
    return stream;
  };
  return {
    disk: subject.disk,
    leftovers: subject.leftovers,
    async close() {
      prototype.createWriteStream = original;
      await subject.close?.();
    },
  };
}

function s3Subject(options: FakeS3Options = {}): DiskContractSubject {
  const fake = createFakeS3(options);
  return {
    disk: new S3Disk({ bucket: fake.bucket, client: fake.client, partSize: MIN_PART_BYTES }),
    leftovers: async () =>
      fake.openUploads === 0 ? [] : [`${fake.openUploads} open multipart upload(s)`],
  };
}

runDiskContract('memory', () => ({ disk: new MemoryDisk(), leftovers: async () => [] }), {
  partSize: LOCAL_PART,
  persistsContentType: true,
});

runDiskContract('local', localSubject, {
  partSize: LOCAL_PART,
  faults: { failingSink: localSubjectWithFullDisk },
});

runDiskContract('s3 (fake)', () => s3Subject(), {
  partSize: MIN_PART_BYTES,
  persistsContentType: true,
  faults: {
    failingSink: () =>
      s3Subject({
        beforeCommand(command) {
          if (command.name === 'UploadPartCommand' && command.input.PartNumber === 2) {
            throw serviceErrorFor('InternalError', 500);
          }
        },
      }),
  },
});
