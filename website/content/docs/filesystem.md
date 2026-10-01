---
title: Filesystem
order: 50
section: Reference
---

# Filesystem

A **disk** is a keyed store of byte objects. The `Disk` contract lives in
`jsails/filesystem`; `@jsails/filesystem` ships three disks and a plugin:

- `LocalDisk` stores objects as files under a root directory.
- `S3Disk` stores them in AWS S3 or an S3-compatible service (Cloudflare R2,
  MinIO, SeaweedFS, RustFS).
- `MemoryDisk` holds them in process memory, for tests and demos.

`filesystemPlugin({ disks, default? })` provides a `FileSystem` service under
`filesystemToken`. It looks disks up by name, and `disk()` with no argument
returns the default disk (or the sole one). It is a `definePlugin` plugin: each
disk is described as data, never passed in, and a malformed description fails
with `config.invalid_options` when the factory is called, before anything runs.

| Disk spec | Builds |
| --- | --- |
| `{ driver: 'local', root, maxBytes? }` | a `LocalDisk` under `root`; a relative root resolves against the app root |
| `{ driver: 'memory', maxBytes? }` | a `MemoryDisk` |
| `{ driver: 'env' }` | the disk the `FILESYSTEM_*` and `S3_*` variables select |

```js
// jsails.app.js
export default {
  plugins: {
    use: [
      [
        '@jsails/filesystem',
        {
          disks: { files: { driver: 'env' }, scratch: { driver: 'memory', maxBytes: 1024 ** 2 } },
          default: 'files',
        },
      ],
    ],
  },
};
```

The plugin declares the variables the `env` disk reads (the S3 credentials as
secrets), so `jsails env` lists them and a malformed one, such as an
`S3_ENDPOINT` that is not a URL, fails with `config.invalid_env` before setup.

```ts
import { readText } from 'jsails/filesystem';
import { MemoryDisk } from '@jsails/filesystem';

const disk = new MemoryDisk();
const { size, sha256 } = await disk.write('notes/today.txt', new TextEncoder().encode('hello'), {
  maxBytes: 1024 * 1024,
  contentType: 'text/plain',
});
console.log(size, sha256, await readText(disk, 'notes/today.txt', { maxBytes: 1024 }));
```

## The Disk contract

Each disk implements every method below. No method is optional, so code that
accepts a `Disk` needs no capability checks.

| Method | Result |
| --- | --- |
| `write(key, source, { maxBytes, contentType?, ifAbsent?, signal? })` | `{ size, sha256 }` |
| `read(key, { range?, signal? })` | `{ stream, size, start, end, contentType? }` |
| `stat(key)` | `{ size, modifiedAt, contentType? }`, or `null` when nothing is stored |
| `delete(key)` | Removes the object. Deleting a key that does not exist succeeds. |
| `deletePrefix(prefix)` | Removes every object under `prefix/` |
| `list(prefix, { limit, cursor? })` | `{ keys, cursor? }`: one page in UTF-8 byte order |

### Writes stream and hash

The `source` is a `Uint8Array`, a web `ReadableStream<Uint8Array>`, or any
`AsyncIterable<Uint8Array>`, such as a Node stream.

- **Streaming.** The disk reads the source one chunk at a time and never holds
  the whole object in memory. `LocalDisk` writes to a temp file next to the
  target and renames it into place. `S3Disk` buffers one part (`partSize`,
  8 MiB by default) and sends each part as soon as it is full.
- **Hash.** Every write returns the object's SHA-256 as 64 lowercase hex
  characters (the `Sha256` type), computed from the bytes as they pass. Store
  the hash with your record to detect duplicates or verify a download.
- **Atomicity.** A write either stores the whole object or stores nothing. A
  failed write leaves no partial object, temp file, or open multipart upload,
  and any earlier object under the key stays as it was.

`maxBytes` is required. The write fails with `disk.too_large` as soon as the
source passes the limit, so an upload of unknown length cannot fill the disk.
Each disk also accepts its own `maxBytes` option, which caps its total stored
bytes (except `S3Disk`). For `LocalDisk`, that total is checked exactly even
when writes run concurrently.

`ifAbsent: true` creates the object only if the key is empty. If an object
already exists, the write fails with `disk.conflict`; when two writers race,
exactly one wins. `S3Disk` sends `If-None-Match: *` for this, and a store that
answers that it does not support the header fails with `disk.unsupported`.
SeaweedFS (the store `jamal` provisions) ignores the header and overwrites, so
declare it with `conditionalWrites: false` (or `S3_CONDITIONAL_WRITES=false`);
`ifAbsent` then fails with `disk.unsupported` instead of overwriting.

An aborted `signal` stops the write promptly, even while the source is waiting
on the network, and it fails with `disk.aborted`.

### Reads are ranged streams

`read` returns a web `ReadableStream` of the object, or of one inclusive byte
range: `{ start, end? }`. An `end` past the last byte is clamped. A `start`
beyond the object fails with `disk.invalid_range`. The result reports the
object's full `size` alongside the `start` and `end` it delivers, which is
everything an HTTP `206` response needs. `S3Disk` serves a range with a single
ranged `GET`.

To load a small object into memory, use `readBytes(disk, key, { maxBytes })` or
`readText`. Both refuse an object larger than `maxBytes` before reading it.

### Keys

A key is a `/`-separated path of 1 to 1024 characters. These keys fail with
`disk.invalid_key`:

- a leading `/`
- a backslash
- a drive prefix
- an empty, `.` or `..` segment
- a control character

`isDiskKey` and `assertDiskKey` apply the same rules. `LocalDisk` also refuses
names Windows cannot store (`CON`, `a:b`, a trailing dot) when it runs on
Windows.

`LocalDisk` also refuses to follow a symlink out of its root. A key cannot be
both an object and a directory. On `LocalDisk`, writing over a directory, or
under a key that is a file, fails with `disk.key_collision`.

### Listing

`list` returns at most `limit` keys (1 to 1000) under a prefix, in UTF-8 byte
order. A prefix covers the whole segment: `a` matches `a/1` but not `ab`.
`LocalDisk`, `MemoryDisk`, and `S3Disk` on AWS S3, R2 and MinIO use the same
order; SeaweedFS lists a directory's keys before a sibling that sorts ahead of
`/` (`a/1` before `a-x`). While more keys remain, the page carries a
`cursor`; pass it back to get the next page. To list everything, loop until a
page has no cursor:

```ts
import type { Disk } from 'jsails/filesystem';

async function allKeys(disk: Disk, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await disk.list(prefix, { limit: 1000, ...(cursor ? { cursor } : {}) });
    keys.push(...page.keys);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return keys;
}
```

## Errors

Every failure is a value-free `disk.*` error from the `DiskErrors` registry.
These errors never include a key, a path, a bucket name, or object bytes. Test
for a code with `DiskErrors.is(error, 'not_found')`.

| Code | Meaning |
| --- | --- |
| `disk.invalid_key`, `disk.invalid_range`, `disk.invalid_cursor`, `disk.invalid_option`, `disk.invalid_source` | The call was malformed |
| `disk.not_found` | `read` of a missing key |
| `disk.conflict` | `ifAbsent` found an object already stored |
| `disk.key_collision` | The key is, or lies under, a directory or file of the other kind |
| `disk.too_large` | The write passed `maxBytes` or the disk's quota |
| `disk.aborted` | The `signal` fired |
| `disk.source_failed` | The source stream threw; its error is the `cause` |
| `disk.unsupported` | The store cannot perform the operation |
| `disk.io_failed` | The store failed; the original error is the `cause` |

A missing S3 bucket is never mistaken for a missing object. `stat` confirms the
bucket with `HeadBucket` before it returns `null`, so a misconfigured bucket
fails with `disk.io_failed` instead of looking empty.

## Signed URLs

An `S3Disk` can also sign URLs: it implements `DiskUrlSigner`, and
`isDiskUrlSigner(disk)` checks for it. `signedUrl(key, options)` returns a
presigned `GetObject` URL that reads the object straight from the store, so a
download skips the app. The URL is signed locally, with no network call.

```ts
import { isDiskUrlSigner, type Disk } from 'jsails/filesystem';

async function downloadLink(disk: Disk, key: string): Promise<string | undefined> {
  if (!isDiskUrlSigner(disk)) return undefined; // serve the bytes through a route
  return disk.signedUrl(key, {
    expiresInMs: 10 * 60 * 1000,
    contentDisposition: { type: 'attachment', filename: 'Q3 report.pdf' },
    contentType: 'application/pdf',
  });
}
```

All three options are required, so a signed URL always fixes its lifetime, its
disposition and its media type. The holder cannot change them.

- **Lifetime.** The lifetime runs from 1 second to 7 days
  (`SIGNED_URL_MAX_EXPIRES_IN_MS`) and is rounded up to whole seconds. A
  signed URL works for anyone who holds it until it expires, so keep lifetimes
  short.
- **Validation.** A filename with control characters, or a media type outside
  RFC 9110 syntax, fails with `disk.invalid_option`.
- **Other disks.** `LocalDisk` and `MemoryDisk` have no origin to give a
  client, so they do not sign URLs; serve their objects through an app route.
- **Injected clients.** An `S3Disk` built around an injected `client` that is
  not a real `S3Client` fails with `disk.unsupported`.

## Configuring disks

```ts
import { createDiskFromEnv, LocalDisk, S3Disk } from '@jsails/filesystem';

const local = new LocalDisk({ root: './storage', maxBytes: 10 * 1024 ** 3 });
const s3 = new S3Disk({
  bucket: 'uploads',
  region: 'eu-west-1',
  prefix: 'site',
  partSize: 16 * 1024 * 1024, // 5 MiB to 1 GiB
});
// FILESYSTEM_DISK=local|s3|memory, plus S3_*; a relative local root resolves against rootDir.
const fromEnv = createDiskFromEnv(process.env, { rootDir: import.meta.dirname });
console.log(local, s3, fromEnv.name);
```

### LocalDisk

`LocalDisk` creates its root on first write. Pass `createRoot: true` to create
it at construction instead.

Each write lands in a temp file named `.<12 hex>.tmp` beside its target. These
files are never listed and do not count toward the quota. The first write
removes temp files older than `staleTempMs` (1 hour by default) that a crash
left behind.

A write is flushed to disk before its rename, and on POSIX the parent directory
is synced after it. On Windows a rename that hits a sharing violation is
retried briefly.

`LocalDisk` does not persist `contentType`.

### S3Disk

`S3Disk` keeps at most one part in memory per write. A write that fits in one
part is sent as a single `PutObject`. A larger write starts a multipart upload
when its second part begins, and if the write fails it aborts that upload.

`connectionTimeoutMs` (default 5000) and `requestTimeoutMs` (default 30000)
bound each request. A `prefix` scopes every key, and listing skips folder
markers. A list cursor wraps the store's continuation token, so a cursor the
disk did not issue fails with `disk.invalid_cursor` before any request. A
range read checks the `Content-Range` the store answers with, so a store that
answers an out-of-range request with a `206` still fails with
`disk.invalid_range`.

`createDiskFromEnv` reads `S3_CONDITIONAL_WRITES` (on by default) for
`conditionalWrites`.

`createDiskFromEnv(env, { rootDir? })` builds only the disk that
`FILESYSTEM_DISK` selects, from the environment it is given; the plugin's `env`
disk passes the variables it declares. A missing or invalid variable fails with
`filesystem.invalid_environment`, which names the variable but never its
value. A `FILESYSTEM_DISK` that is set but blank is refused too: by
`createDiskFromEnv` itself, and, for the plugin's `env` disk, by the plugin's
declaration (`config.invalid_env` before any setup), so an empty templated
value never quietly selects the local disk.

## Variants

`defineVariant` and `DiskVariantResolver` derive objects from a stored source
and cache them, such as a thumbnail of an upload. You supply the transform, so
the package does not depend on an image library.

Variants are stored under `_variants/<sha256(source key)>/<sha256(seed)>`.
Call `resolver.purge(sourceKey)` when you remove a source to delete all of its
variants. `sourceMaxBytes` (64 MiB by default) caps how much of a source the
resolver reads. Failures are `variant.*` errors from `VariantErrors`.

## Testing a disk

`@jsails/filesystem/testing` exports `runDiskContract`, the suite every
first-party disk passes. Run it against your own `Disk` to check it against the
same contract:

- round trips at part boundaries, with each size and hash checked
- every source shape
- `maxBytes` and `ifAbsent`
- range edges
- key validation
- listing order and paging
- aborts, and a failing source

After each scenario, the suite asks the subject for its leftovers: temp files,
open uploads, or anything else a failed write should have cleaned up. It also
fails if the disk causes an uncaught exception or an unhandled rejection.

```ts
import { describe } from 'node:test';
import { MemoryDisk } from '@jsails/filesystem';
import { runDiskContract } from '@jsails/filesystem/testing';

describe('my disk', () => {
  runDiskContract('memory', () => ({ disk: new MemoryDisk(), leftovers: async () => [] }), {
    persistsContentType: true,
  });
});
```

`faults.failingSink` lets the suite test a store that fails mid-write. Give it
a factory whose disk fails after the first part, and the suite checks that the
write fails with `disk.io_failed` and leaves nothing stored.

## See also

- [Attachments](/docs/attachments): files attached to records, stored on a
  disk.
- [Services & Utilities](/docs/services#media): the media library built on a
  disk.
