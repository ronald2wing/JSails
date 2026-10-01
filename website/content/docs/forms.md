---
title: Forms and Uploads
order: 43
section: Building
---

# Forms and Uploads

Pages are `GET`-only, so a form posts to an API route or to a server-component
action. An API route reads its body with `readForm`; a server component gets
validated action input and signed file uploads from the runtime. Either way
the CSRF rules in [Security](/docs/security#csrf-tokens) apply.

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
  past it while streaming is cut off. The app-wide `maxBodyBytes` in
  `jsails.app.js` (default 1 MiB) caps every request before `readForm` runs,
  unless the route declares its own cap (see
  [Request body limits](/docs/routing#request-body-limits)).
- **Value-free errors.** Each error is `{ path, code, message }`, where `path`
  is the field path (`['email']`). Body-level failures (`body_too_large`,
  `invalid_json`, `unsupported_content_type`) have an empty path. No message
  echoes the submitted value.

`readForm` is browser-safe and has no server dependency, so the same schema
can validate a form on the client before it is sent.

## Submitting from the browser

With a session, an API route requires the `X-CSRF-Token` header, which a plain
`<form method="post">` cannot send. Submit the form from script:

```js
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const response = await fetch(form.action, {
    method: 'POST',
    headers: { 'X-CSRF-Token': form.dataset.csrfToken },
    body: new URLSearchParams(new FormData(form)),
  });
  // render response errors next to their fields
});
```

`new URLSearchParams(new FormData(form))` sends the fields urlencoded, which
`readForm` reads; passing the `FormData` itself would send `multipart/form-data`,
which it refuses. Without a session, the CSRF check does not apply and the
route's `authorize` decides.

## Server-component forms

A server component renders its form with the `submit(action, args?)` helper.
The runtime posts the signed snapshot with the CSRF token, re-runs `authorize`,
and parses the action's `input` Zod schema before `run` sees it, so the
component never reads raw `FormData`. `defineForm` adds typed fields,
validation, and snapshot round-tripping for larger forms. See
[Server Components](/docs/server-components#rendering-with-bind-call-submit)
and [Form objects](/docs/server-components#form-objects).

## Uploads

Core has no general multipart parser for API routes. Files reach the app
through one of these:

- **Server-component uploads.** A component that declares an `uploads` policy
  accepts files through the runtime's upload endpoint. The runtime checks the
  snapshot, origin, CSRF, and `authorize` before it reads a single file byte,
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

## Next steps

- [Security](/docs/security) — CSRF, sessions, headers, and signed URLs.
- [Attachments](/docs/attachments) — files attached to records.
- [Server Components](/docs/server-components) — stateful, signed components.
