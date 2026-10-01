---
title: Forms and Uploads
order: 43
section: Building
---

# Forms and Uploads

Pages are `GET`-only, so a form posts to an API route or to a server-component
action. An API route reads its body with `readForm`; a server component gets
validated action input and signed file uploads from the runtime. Either way
the cross-site check in
[Security](/docs/security#what-the-pipeline-enforces) applies: an unsafe
request must come from the app's own origin, and there is no token to send.

## Reading a form body

`readForm(request, schema, options?)` from `jsails/api` reads the body with a
hard byte bound, decodes it, and validates it against a schema built from the
same strict field builders as the rest of `jsails/api` (`object`, `string`,
`integer`, `boolean`, `array`, `optional`). It returns a result instead of
throwing, so the handler decides how to show errors:

```ts
// api/subscribe.ts
import { Respond, object, readForm, string } from 'jsails/api';

const Subscribe = object({
  email: string({ trim: true, min: 3, max: 254 }),
  name: string({ trim: true, max: 100, optional: true }),
});

export async function POST(request: Request) {
  const result = await readForm(request, Subscribe);
  if (!result.ok) {
    return Respond.json({ errors: result.errors }, { status: 400 });
  }
  const { email, name } = result.value; // typed
  // ...
  return Respond.noContent();
}
```

- **Content types.** `application/x-www-form-urlencoded` (also assumed when
  the `Content-Type` is missing) and `application/json` (or any `+json` type)
  are read. Anything else, `multipart/form-data` included, fails with
  `unsupported_content_type`; uploads take the paths below.
- **No coercion.** A urlencoded field is always a string, and a repeated key
  becomes an array of strings. An `integer()` or `boolean()` field therefore
  accepts only a JSON body; for an HTML form use `string()` fields and convert
  them in the handler.
- **Strict objects.** `object()` rejects keys it does not declare
  (`unknown_field`) unless you pass `{ allowUnknown: true }`. A field named
  `__proto__` or `constructor` is an ordinary key and is rejected like any
  other.
- **Bounded.** The default limit is 64 KiB (`{ maxBytes }` changes it). A
  `Content-Length` over the limit is refused before reading; a body that grows
  past it while streaming is cut off. The route's body limit (its declared
  `body`, else the app-wide `maxBodyBytes`, default 1 MiB) bounds the read as
  well, and a body past it is answered `413` (see
  [Request bodies](/docs/routing#request-bodies)).
- **Value-free errors.** Each error is `{ path, code, message }`, where `path`
  is the field path (`['email']`). Body-level failures (`body_too_large`,
  `invalid_json`, `unsupported_content_type`) have an empty path. No message
  echoes the submitted value.

`readForm` is browser-safe and has no server dependency, so the same schema
can validate a form on the client before it is sent.

## Submitting from the browser

A browser sends `Origin` with every form POST and `fetch` by itself, so a
plain `<form method="post">` on one of the app's pages passes the cross-site
check, signed in or not; the same POST from another site is refused `403`
`access.cross_site` before the route's access runs. To render errors next to
their fields without a reload, submit the form from script:

```js
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch(form.action, {
    method: 'POST',
    body: new URLSearchParams(new FormData(form)),
  });
  // render response errors next to their fields
});
```

`new URLSearchParams(new FormData(form))` sends the fields urlencoded, which
`readForm` reads; passing the `FormData` itself would send `multipart/form-data`,
which it refuses.

## Server-component forms

A server component renders its form with the `submit(action, args?)` helper.
The runtime posts the signed snapshot, re-runs `authorize`,
and parses the action's `input` Zod schema before `run` sees it, so the
component never reads raw `FormData`. `defineForm` adds typed fields,
validation, and snapshot round-tripping for larger forms. See
[Server Components](/docs/server-components#rendering-with-bind-call-submit)
and [Form objects](/docs/server-components#form-objects).

## Uploads

Files reach the app through one of these:

- **API routes.** A route that declares a `multipart` body reads it part by
  part with `ctx.body.multipart()`, each file a stream it can pipe straight to
  a disk, under limits it states per part (see
  [Streaming a multipart body](#streaming-a-multipart-body) below).
- **Server-component uploads.** A component that declares an `uploads` policy
  accepts files through the runtime's upload endpoint. The runtime checks the
  origin, snapshot, and `authorize` before it reads a single file byte,
  enforces size, type, concurrency, and per-subject quotas while streaming, and
  stages the file under a signed reference that expires after an hour. The
  limits and their defaults are in
  [Server Components](/docs/server-components#file-uploads).
- **Admin and media uploads.** `@jsails/admin` resource forms accept a `file`
  field, and `@jsails/media` stores uploads in a media library with type,
  size, and pixel limits (see [Admin Panel](/docs/admin) and
  [Services](/docs/services#media)).

A component action turns a staged upload into a permanent file with
`resolveUpload(reference, componentName, context)` from
`jsails/server-components`, where `componentName` is the name the component is
registered under, not the field name. It verifies the reference, checks that it
belongs to this component and to the current session (or to the anonymous subject),
and returns a handle with `size`, `contentType`, `open()` (a read stream), and
`delete()`. An invalid, foreign, or expired reference throws a value-free
`UploadError`.

```ts
import { resolveUpload } from 'jsails/server-components';

// inside an action's run(state, args, context)
// 'profile-form' is this component's registered name
const upload = resolveUpload(args.avatar, 'profile-form', context);
const stream = await upload.open();
if (stream === null) return state; // already swept
// The component's uploads.maxBytes bounds this buffer.
const bytes = Buffer.concat(await stream.toArray());
await avatar.attach({ id: user.id }, bytes, upload.contentType); // see Attachments
await upload.delete();
```

Staged files are swept after `retentionMs` (default 1 hour 15 minutes), so an
action that keeps a file must copy it before then. To store it against a
record, see [Attachments](/docs/attachments).

### Streaming a multipart body

A route that takes files declares `body: { kind: 'multipart', maxBytes, parts }`
and reads it with `ctx.body.multipart()`, an async iterable of the body's parts
in the order the client sent them. A text field arrives whole
(`{ kind: 'field', name, value }`); a file arrives as a stream
(`{ kind: 'file', name, filename, contentType, stream }`) read straight from the
request, so the server holds one chunk of it at a time whatever its size. This
route stores an avatar on the default disk of the
[filesystem plugin](/docs/filesystem):

```ts
// api/avatars.ts
import { defineApi, Respond } from 'jsails/api';
import { facade } from 'jsails/facades';
import { filesystemToken } from 'jsails/filesystem';

const Files = facade(filesystemToken);
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export default defineApi('/api/avatars', {
  access: ({ session }) => session !== null,
  body: {
    kind: 'multipart',
    maxBytes: MAX_AVATAR_BYTES + 64 * 1024,
    parts: {
      maxParts: 2,
      maxFieldBytes: 200,
      files: { avatar: { maxBytes: MAX_AVATAR_BYTES, contentTypes: ['image/png', 'image/jpeg'] } },
    },
  },
  POST: async ({ body, signal }) => {
    let caption = '';
    let stored: { key: string; size: number } | undefined;
    for await (const part of body.multipart()) {
      if (part.kind === 'field') {
        if (part.name === 'caption') caption = part.value;
        continue;
      }
      // The key is ours: part.filename is whatever the client sent.
      const key = `avatars/${crypto.randomUUID()}`;
      const { size } = await Files.disk().write(key, part.stream, {
        maxBytes: MAX_AVATAR_BYTES,
        contentType: part.contentType,
        signal,
      });
      stored = { key, size };
    }
    if (stored === undefined) return Respond.json({ error: 'missing_avatar' }, { status: 422 });
    return Respond.json({ caption, ...stored }, { status: 201 });
  },
});
```

`parts` states every limit, and each is enforced as the bytes arrive:

| Member | Limits |
| --- | --- |
| `maxParts` | parts in the body, fields and files together (at most 1000) |
| `maxFieldBytes` | the bytes of one text field |
| `maxHeaderBytes` | one part's header block (default 8 KiB, 256 B to 64 KiB) |
| `files` | the fields that may carry a file: each its `maxBytes` per file, `maxCount` files (default 1), and optionally the `contentTypes` it accepts (`image/png`, or a whole type as `image/*`) |
| `idleMs` | the longest wait for the next chunk while a reader asks for one (default 30 s) |

- **Limits answer `413`.** A part past its limit, one part too many, or a
  second file in a one-file field fails the read with `multipart.too_large`,
  and its file stream errors instead of ending: a disk write fails and stores
  nothing. The request is then answered `413` whatever the handler does with
  the error, as for a body past `maxBytes` (see
  [Request bodies](/docs/routing#request-bodies)). The part count is checked
  at the boundary that would open one more part, so the file before it fails
  too.
- **A file where the route takes none is a `422`.** A part with a filename in
  a field `files` does not name fails with `multipart.unexpected_file`; one of
  a media type its field does not accept with `multipart.unsupported_type`; a
  malformed body with `multipart.invalid`. None echoes a name or a value.
- **Read each file before the next part.** Asking for the next part while a
  file stream is unread reads and discards the rest of that file (still
  counted against its limits) and fails the old stream with
  `multipart.part_abandoned`, so a stream read late never looks complete.
  Breaking out of the loop leaves the file being read readable to its end.
- **A stalled body is cut off.** A read that waits `idleMs` for the client
  fails with `multipart.idle` (`504`), and the route's deadline or the client
  going away aborts a waiting read; either way the body is released.
- **The route table shows every limit.** The route's row holds `parts` with
  each default stated (`maxHeaderBytes`, `idleMs`, each field's `maxCount`),
  its file fields in name order and each field's `contentTypes` lowercased,
  sorted and without repeats, so two declarations with the same effect show
  the same row.
- **Everything from the client is untrusted.** `filename` is the raw name the
  client sent (it may hold a path or `..`); never use it as a key or a path.
  `contentType` is the type the client claims, lowercased: `contentTypes`
  filters on that claim and does not inspect the bytes.

`ctx.body.form()` stays for small forms (urlencoded, or multipart without
files worth streaming): it holds the whole body in memory under the route's
`maxBytes`. Use `multipart` for anything that carries a file.

## Next steps

- [Security](/docs/security) — the cross-site check, sessions, headers, and signed URLs.
- [Attachments](/docs/attachments) — files attached to records.
- [Server Components](/docs/server-components) — stateful, signed components.
