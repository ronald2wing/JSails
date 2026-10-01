---
title: Attachments
order: 44
section: Building
---

# Attachments

`hasOneAttached` gives a record a named file, such as a user's avatar or an
invoice's PDF, without hand-written blob code. The file bytes go to a `Disk`
(the `jsails/filesystem` contract, implemented by `LocalDisk`, `S3Disk`, and
`MemoryDisk` in `@jsails/filesystem`), and a row in the framework-owned
`jsails_attachment` table records where it is. Both come from `jsails/database`
(and the root `jsails` entry).

## Setup

Add the attachment entity to your data source and create its table through
the normal schema history:

```js
// jsails.database.js
import { JsailsDataSource, activeStorageEntities, readDatabaseEnvironment } from 'jsails';

export default new JsailsDataSource({
  ...readDatabaseEnvironment(),
  entities: [...activeStorageEntities],
});
```

```sh
jsails db:push --config jsails.database.js
```

`activeStorageEntities` holds the one entity, `JsailsAttachment`; list it next
to any hand-written entities. The table is never created at runtime.

## Declaring an attachment

```ts
import { hasOneAttached } from 'jsails/database';
import { LocalDisk } from '@jsails/filesystem';

const avatar = hasOneAttached({
  disk: new LocalDisk({ root: 'storage/avatars', maxBytes: 1024 * 1024 * 1024 }),
  name: 'avatar',
  recordType: 'User',
  dataSource,
  urlPrefix: '/avatars', // optional; where the disk's files are served
});
```

- `recordType` and `name` scope every row, so `avatar` on `User` and `avatar`
  on `Team` never collide.
- `dataSource` is the initialized TypeORM data source that owns
  `jsails_attachment`. It is passed in explicitly; there is no global registry.
- `urlPrefix` only builds URLs. Serving the files at that prefix (a public
  directory, a CDN in front of the bucket, or a route that checks access) is up
  to you. Without it, `url()` returns `null`.

## Attaching, reading, detaching

The handle has three functions; each takes the record as `{ id }` with a
numeric id.

```ts
await avatar.detach(user); // replace: remove the previous file first
const attachment = await avatar.attach(user, bytes, 'image/png');
attachment.byteSize; // also: id, key, contentType, recordType, recordId, name, createdAt

await avatar.url(user); // '/avatars/user/7/avatar_3f9c…' or null
await avatar.detach(user); // deletes the blob, then the row; a no-op when absent
```

- `attach(record, data, contentType)` writes `data` (a `Uint8Array`) to the
  disk under `<recordtype>/<id>/<name>_<random>`, then saves the row. The
  random 12-byte suffix makes every key unique, so a new file never overwrites
  an old one in a cache or CDN.
- `attach` adds a row; it does not remove an existing attachment. Call
  `detach` first when replacing a file, or the old blob and row remain and
  `url` may return either one.
- `contentType` is stored as given and is not checked against the bytes.
  Validate the type and size of untrusted uploads before attaching (a
  server-component `uploads` policy does both; see
  [Forms and Uploads](/docs/forms#uploads)), and serve user files with
  `X-Content-Type-Options: nosniff`.
- The disk write and the row insert are separate steps, not one transaction.
  If the insert fails, the blob stays on the disk without a row.
- `attach`, `detach`, and `url` raise no errors of their own; disk and
  database errors propagate unchanged. `ActiveStorageError` is exported for the
  `missing_data_source` code but is not currently thrown.

## Testing

`MemoryDisk` from `@jsails/filesystem` keeps blobs in memory, so a test needs
only a database for the rows (see [Testing](/docs/testing)).

## Next steps

- [Forms and Uploads](/docs/forms) — getting a file from the browser.
- [Services & Utilities](/docs/services#filesystem) — the disk implementations.
- [Models](/docs/models) — the Active Record layer.
