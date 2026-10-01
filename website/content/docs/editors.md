---
title: Editors
order: 20
section: Extending
---

# Editors

JSails keeps the **content contract** and the **editor implementation** separate. Apps can replace Editor.js with another editor, or build their own, without changing the persisted rich-text schema.

## The two layers

- **Canonical content** — `RichTextDocument` from `jsails/rich-text`. It is rendered by the framework, searched, exported, and used as a fallback. It contains blocks, text, media references, and structured block fields.
- **Editor envelope** — an optional `EditorDocument` that carries canonical content plus the editor’s native JSON:

```ts
interface EditorDocument {
  version: 1;
  editor: string;              // adapter id, e.g. 'editorjs' or 'acme-editor'
  content: RichTextDocument;   // canonical, renderable fallback
  native?: EditorJsonValue;    // editor-owned, opaque to the framework
}
```

The native payload exists for editors whose full state cannot be represented by the canonical document. It is **never rendered by the core renderer**. Canonical `content` is always required, so content survives even when the native payload is missing or the editor changes.

## The adapter contract

```ts
interface RichTextEditorAdapter<TPayload> {
  readonly id: string;
  readonly island: string;
  readonly payloadSchema: z.ZodType<TPayload>;

  toContent(payload: TPayload): RichTextDocument;
  fromContent(content: RichTextDocument): TPayload;
  render?(payload: TPayload, options?: Record<string, unknown>): string;
}
```

- `id` is persisted in the envelope.
- `island` is the browser island the admin form hydrates.
- `payloadSchema` validates the native payload.
- `toContent` / `fromContent` are pure conversions.
- `render` is optional. Omit it when the canonical renderer is sufficient; provide it when the editor has full-fidelity server output.

Define an adapter with `defineRichTextEditorAdapter`; it validates and freezes the definition.

## Using an adapter

An admin `richText` field accepts an adapter:

```ts
import { defineResource } from '@jsails/admin';
import { editorJsAdapter } from '@jsails/editor';

export const posts = defineResource({
  slug: 'posts',
  label: 'Posts',
  columns: [{ name: 'title', label: 'Title' }],
  fields: [
    { name: 'title', label: 'Title', type: 'text' },
    { name: 'body', label: 'Body', type: 'richText', editor: editorJsAdapter },
  ],
});
```

The field stores an `EditorDocument` envelope. Without `editor`, the field keeps the canonical-only `RichTextDocument` behavior.

For image/gallery block authoring, set `mediaPickerUrl` on the same field. It
must point at a same-origin JSON endpoint returning the media assets; the
generated blog uses `/admin/media?format=json`:

```ts
{ name: 'body', label: 'Body', type: 'richText', editor: editorJsAdapter,
  mediaPickerUrl: '/admin/media?format=json' }
```

The image and gallery tools fetch that endpoint with `credentials:
'same-origin'`, render asset names as text, and write the selected id back into
the block. Without the option they fall back to manual media-id inputs.

The picker sends `limit=50` and, when the search box has a term, `q`. It accepts
either a bare JSON array or the paged envelope `{ assets, total }` that
`/admin/media?format=json` returns, so a custom endpoint may serve either shape.
The fetched page is cached per picker instance: reopening the list reuses it, and
only a changed search term triggers another request. Filtering stays server-side,
so the client never holds the whole library.

The media endpoint itself accepts `q`, `mime`, `limit`, and `offset`; `total`
reports the full match count rather than the page length, and an explicit `limit`
is capped at 1000.

The blog admin accepts the same adapter:

```js
import { editorJsAdapter } from '@jsails/editor';

blogAdmin({ repository, editor: editorJsAdapter });
```

It persists `blocks` (canonical), `editor`, and `native` for posts and pages. Legacy canonical records are read as envelopes with no native payload on the next edit.

## Building your own editor

1. Implement the client island. It receives the field name, the `EditorDocument`, and the editor id in `data-jsails-props`, and keeps a hidden input named after the field containing the updated envelope JSON.
2. Implement an adapter with `defineRichTextEditorAdapter`.
3. Pass it to the admin field or blog admin.
4. Register the island in the app client entry:

```ts
import { startClient } from 'jsails/client';
import { myEditorIsland } from 'my-editor/preact';

startClient({ islands: myEditorIsland });
```

Switching editors is then a package + adapter change. The persisted canonical content does not need a migration.

## Rendering

Use the canonical renderer for the safe fallback:

```ts
import { renderRichText } from '@jsails/editor/server';

const html = renderRichText(post.blocks);
```

If an adapter supplies `render`, a server surface can use `EditorRegistry.render(envelope)` for full-fidelity output. The blog plugin also exposes `blogEditorRendererToken`: pass the adapter to `blogPlugin({ repository, editor })` and the starter detail page prefers that renderer, falling back to canonical blocks when it is absent. Keep the canonical renderer as the fallback whenever the adapter is unavailable.

## Security

The native payload is trusted only after `payloadSchema` validation. It must never be rendered as raw HTML by the framework. Canonical text and URLs pass through the allowlisted renderer; client HTML is never trusted.
