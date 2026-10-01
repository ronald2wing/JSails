---
title: Editors
order: 20
section: Extending
---

# Editors

JSails keeps the **rich-text model** and the **editor** separate. The model,
`RichTextDocument` from `jsails/rich-text`, is what a store holds, what the
renderer reads, and what search indexes. An editor is only a way to produce
one: it loads a document, lets an author change it, and hands back a document.
Nothing editor-specific is persisted, so replacing the editor never needs a
data migration.

## The model

A document is a version number and a list of blocks. Text lives in **inline
runs**: each run is a string with optional marks (`bold`, `italic`, `strike`,
`code`) and an optional link.

```ts
import { parseRichText } from 'jsails/rich-text';

const result = parseRichText({
  version: 2,
  blocks: [
    { type: 'heading', level: 2, content: [{ text: 'Release notes' }] },
    {
      type: 'paragraph',
      content: [
        { text: 'Read the ' },
        { text: 'upgrade guide', marks: ['bold'], href: '/docs/upgrading' },
        { text: ' first.' },
      ],
    },
    {
      type: 'list',
      style: 'task',
      items: [{ content: [{ text: 'Back up the database' }], checked: true }],
    },
  ],
});
```

The block kinds are `paragraph`, `heading` (levels 2 to 6), `quote` (with an
optional `citation`), `callout` (`info`, `success`, `warning`, `danger`),
`code` (with an optional `language`), `list` (`ordered`, `unordered`, or
`task`, nested up to three levels), `image` and `gallery` (media-library ids),
`embed` (an `https:` URL), `cta` (a label and a link), and `divider`. A `\n` in
a run is a hard line break; headings, labels, alt text and captions hold none.

Links are accepted by `isLinkHref`: a same-origin path (`/pricing`, never
`//host`), a fragment (`#top`), an `http://` or `https://` URL with a host and
no userinfo, `mailto:` or `tel:`. Embeds are accepted by `isEmbedUrl`: an
`https://` URL with a host and no userinfo. Both are allowlists, so
`javascript:`, `data:`, upper-case schemes, backslashes and whitespace are
refused rather than repaired. Text may not hold control characters (except
`\n`, and `\t` in code), bidi override or isolate characters, or unpaired
surrogates.

A document also has a budget: 256 KiB of JSON (`MAX_DOCUMENT_BYTES`), 500
blocks (`MAX_BLOCKS`), 20 000 characters of text per block
(`MAX_BLOCK_CHARS`), and 500 items per list (`MAX_LIST_ITEMS`).
`measureRichText(document)` reports all four, so an editor can refuse an edit
that would leave the budget.

## Reading and writing

`parseRichText(value)` is the only reader of a stored or submitted document. It
checks the version, the size, the schema, the budget, and that the document is
already in **canonical form**, and returns `{ ok: true, value }` or
`{ ok: false, issues }`. Each issue is a path and a code (`invalid_link`,
`not_canonical`, `too_large`, ...); no issue ever repeats the offending text or
URL. It never repairs a value.

Canonical form is the one spelling of a document's content: no empty runs,
adjacent runs with the same marks and link merged, marks sorted and `code`
alone when present, no empty optional fields, `checked` on every task item and
on no other item, no empty list or gallery. A writer builds whatever
schema-valid document is convenient and stores its canonical form:

```ts
import { normalizeRichText, parseRichText, type RichTextDocument } from 'jsails/rich-text';

function toStored(draft: RichTextDocument): RichTextDocument {
  const read = parseRichText(normalizeRichText(draft));
  if (!read.ok) {
    throw new Error('the document is over budget');
  }
  return read.value;
}
```

`richTextToPlainText(document)` is the text projection used for search and
excerpts: every block's runs concatenated, list items one per line, code, alt
text, captions, citations and button labels included, lines joined with `\n`.
It is plain text, not HTML.

## Upgrading stored documents

A document of any version other than the current one is refused by number.
`upgradeRichTextDocument(value)` is the explicit path from version 1: it turns
each version 1 text into one run, drops block ids, brings text within the
current rules, turns a call to action or embed whose URL is now refused into a
paragraph of its text, and returns the result of `parseRichText` on the
normalised document. A current document passes through unchanged.

The blog ships this as a data migration. List it in the `dataMigrations` export
of `jsails.database.js` and run `npm run db:push`:

```js
import { blogRichTextUpgrade } from '@jsails/blog';

export const dataMigrations = { blogRichTextUpgrade };
```

Until it has run, reading a version 1 post or page fails with
`BlogContentError` code `unreadable_body`. The migration upgrades post and page
bodies and the bodies inside revision snapshots. It reads every row first and,
if any body cannot be upgraded, fails with the count of such bodies and their
row ids (`jsails_blog_content_post#12`, never their content) and writes nothing, so
you can fix those rows by hand and push again. It runs on every push and is
idempotent: once every body is current it only reads.

## The admin field

An admin `richText` field stores a canonical `RichTextDocument`:

```ts
import { defineResource } from '@jsails/admin';

export const articles = defineResource({
  slug: 'articles',
  label: 'Articles',
  columns: [{ name: 'title', label: 'Title' }],
  fields: [
    { name: 'title', label: 'Title', type: 'text' },
    {
      name: 'body',
      label: 'Body',
      type: 'richText',
      mediaPickerUrl: '/admin/media?format=json',
    },
  ],
  list: async () => ({ rows: [], total: 0 }),
});
```

A submitted value is checked against the schema, normalised, and read with
`parseRichText`, so the value a resource's `save` receives is always canonical
and within budget; anything else is a validation error with value-free
messages. An absent or blank value is no value: `save` receives no `body` key
at all, never an empty document, so an update keeps the stored body. That is
why `required` is refused on a `richText` field; a save that needs a body on
create (a store's serializer, for instance) says so itself. `blogAdmin` uses
the same field for post and page bodies: a create without a body starts
empty, and an update without one keeps the stored body.

The form renders the field as the `rich-text` island's markup. Register the
island from `@jsails/editor/preact` in the app client entry:

```ts
import { startClient } from 'jsails/client';
import { richTextIsland } from '@jsails/editor/preact';

await startClient({ islands: richTextIsland });
```

For image and gallery blocks, set `mediaPickerUrl` on the field. It must point
at a same-origin JSON endpoint returning media assets; the generated blog uses
`/admin/media?format=json`. The image and gallery blocks fetch it with
`credentials: 'same-origin'`, send `limit=50` and, when the search box has a
term, `q`, read the paged envelope `{ assets, total }`, list asset names as
text, and write the chosen id into the block. The fetched page is cached per
picker, and filtering stays server-side. Without the option the blocks take
media ids typed by hand.

## The editor

`@jsails/editor` is a ProseMirror editor whose schema is generated from the
model: every node, mark and attribute mirrors a block kind, a mark or a field,
and every attribute is checked with the model's own rules. A pasted
`javascript:` link loses its link at parse, a value the model refuses never
enters the editor, and an edit that would take the document over its budget
is refused with a polite status message. `getDocument()` decodes the editor
state, so the document it returns is canonical and within budget by
construction.

Around the editable surface (`role="textbox"`, labelled by the field's label)
the editor builds:

- a **toolbar** (`role="toolbar"`, one tab stop, Left/Right/Home/End between
  its controls): the block type (paragraph, headings 2 to 6, quote, callout,
  code block), bold, italic, strikethrough, inline code, link, bulleted,
  numbered and task lists, outdent, indent, an **Insert** menu, undo and redo.
  Toggles carry `aria-pressed`; a control that does not apply is
  `aria-disabled` and stays reachable.
- an **Insert** menu (`role="menu"`) for a divider, an image, a gallery, an
  embed and a call to action, each placed after the block holding the cursor.
- one inline **dialog** for a link and for the values a new block needs. Each
  field is checked with the model's rule (`isLinkHref` for links, the schema's
  attribute rules otherwise) and a refused value is reported next to it,
  never applied.
- a real **checkbox** before every task item; clicking it (or Mod-Enter in
  the item) ticks the item as one undoable step.
- labelled controls for the values of blocks that are not typed text: an
  image's media id, alt text and caption, a gallery's ids, an embed's URL, a
  call to action's label and link, a callout's tone, a quote's citation and a
  code block's language, each checked before it is written.

Keys: Mod-b, Mod-i, Mod-Shift-s and Mod-e toggle the marks; Mod-k opens the
link dialog; Mod-Alt-0 makes a paragraph and Mod-Alt-2 to Mod-Alt-6 a
heading; Mod-Shift-8, -7 and -9 toggle a bulleted, numbered and task list;
Tab and Shift-Tab are left to the browser, Mod-] and Mod-[ indent and outdent
a list item; Alt-F10 moves focus to the toolbar and Escape returns to the
text; Mod-z and Mod-Shift-z (or Mod-y) undo and redo; Shift-Enter inserts a
line break. Markdown-style input rules turn `## `, `> `, three backticks,
`- `, `1. ` and `[ ] ` at the start of a paragraph into the matching block.

`mountRichTextEditor` builds it in any element, for a page that is not Preact:

```ts
import { mountRichTextEditor } from '@jsails/editor';
import type { RichTextDocument } from 'jsails/rich-text';

declare const element: HTMLElement;
declare const stored: RichTextDocument;

const editor = mountRichTextEditor({ element, document: stored, label: 'Body' });
const current: RichTextDocument = editor.getDocument();
editor.destroy();
```

It throws `rich_text_editor.invalid_document` (with the issues) for a document
`parseRichText` refuses, so a caller shows the issues instead of an editor.
`RichTextEditor` from `@jsails/editor/preact` is the same editor as a Preact
component (`document`, `onChange`, `onMount`). Both save nothing on their own.
A mount that fails part way leaves nothing behind: no view, no listener.

The editor brings its own styles, adopted by the document as constructed
stylesheets when it mounts (no `<style>` element, so a Content-Security-Policy
without `'unsafe-inline'` styles does not block them): the rules ProseMirror
requires, above all `white-space: break-spaces` on the editable surface so
runs of spaces show as stored, and a layout for the toolbar, menu, dialog and
block controls. Every layout selector is wrapped in `:where()`, so any rule of
your stylesheet wins, and it sets no text or background colour. The classes
are `rich-text-editor-ui`, `-toolbar`, `-menu`, `-dialog`, `-picker`,
`-surface`, `-block` and `-status`.

### Loading

`@jsails/editor/preact` is a small shell: the island and `RichTextEditor` load
the editor itself (ProseMirror, the toolbar, `parseRichText`) with `import()`
when the first field hydrates, so registering `richTextIsland` in a client
entry that every page loads costs a page without an editor about 2.5 KB gzip,
not the editor. Until the editor has read the field, the island keeps the
server's markup as it is.

The starters load their entry as `app.js?v=<hash>`. A lazy chunk that imported
the entry would name it `app.js`, a second URL, and run a second copy of the
client, so the starters' Vite config sets
`rolldownOptions.preserveEntrySignatures: 'strict'`: no chunk imports the
entry, and a module the editor chunk shares with it goes into a hashed chunk
both import. Keep that option if you write your own Vite config and serve the
entry under a query string.

## The form field

A rich-text form field is an island marker, a hidden **source input** holding
the document's JSON, and a fallback for readers without JavaScript.
`RichTextField` from `@jsails/editor/server` renders it for your own forms;
the admin renders the same markup for a `richText` field:

```tsx
import { RichTextField } from '@jsails/editor/server';
import type { RichTextDocument } from 'jsails/rich-text';

declare const post: { body: RichTextDocument };

export function PostForm() {
  return (
    <form method="post" action="/posts/1">
      <label for="post-body">Body</label>
      <RichTextField name="body" value={post.body} label="Body" id="post-body" />
      <button type="submit">Save</button>
    </form>
  );
}
```

The document travels in the source input, not in the island props, whose
JSON is capped at 65 536 characters while a document may reach 256 KiB. The
field has three states, and in none of them can a submit send something the
author did not see:

1. **Not started.** Before the island hydrates, and when the editor fails to
   start, the source input stays in the form with the original bytes, so a
   submit sends the stored value back unchanged.
2. **Editing.** Once the editor is mounted the island removes the source
   input and, on the form's `formdata` event, sets the field to the editor's
   current document. Nothing is mirrored into an input, debounced or held: the
   submitted value is the editor state at the moment of the submit.
3. **Unreadable.** A stored value `parseRichText` refuses is shown as a
   read-only panel listing the issues (paths and messages, never the stored
   text), with no editor and no field. The server renders the source input
   without a `name`, so a submit omits the field and the stored value is
   kept. Replacing it is an explicit, confirmed **Discard and start empty**.

The island element holds exactly the source input and one wrapper element
(`<div class="rich-text-editor" data-state="loading">`, or
`data-state="unreadable"` around the issues panel): the island's first render
is the same two elements, so hydration keeps the input, and the wrapper with
its content, as the server wrote them until the editor has read the source.
The wrapper's `data-state` (`loading`, `editing`, `unreadable` or `failed`) is
there for styling.

## Building your own editor

An editor is a document producer. Register your own island under another name
on a page you render, follow the same field contract (read the source input,
take over the field on `formdata` once mounted, never invent a value for a
document you cannot read), and emit a `RichTextDocument`: there is no adapter
registry and no editor-native payload, and the server reads the submission
with `parseRichText`. Normalise before emitting (`normalizeRichText`) and check
`measureRichText` while editing, so the author never builds a document the
server will refuse.

## Rendering

`renderRichText` from `@jsails/editor/server` turns a document into HTML built
from a fixed set of elements and attributes:

```ts
import { renderRichText } from '@jsails/editor/server';
import type { RichTextDocument } from 'jsails/rich-text';

declare const body: RichTextDocument;

const html = renderRichText(body, {
  resolveMedia: (mediaId) => ({ src: `/media/${encodeURIComponent(mediaId)}` }),
  embedHostAllowlist: ['.youtube.com', 'player.vimeo.com'],
});
```

Marks render as `strong`, `em`, `s` and `code`, links as `<a>` (with
`rel="noopener noreferrer"` for an absolute URL), and a task list as a list of
disabled checkboxes. The renderer reads its input with `parseRichText` and
throws `rich_text_render.invalid_document` (`RichTextRenderErrors`) for a
value it refuses, so a document that skipped the reader cannot reach the
page; a malformed option is `rich_text_render.invalid_option` and a media
descriptor without a usable `src` is `rich_text_render.invalid_media`. An embed whose
host is not on the allowlist (empty by default) and a media id the resolver
does not know render a placeholder.

## Security

Every text and attribute value is escaped, and there is no raw-HTML block.
Link and embed URLs are checked once, by the model's predicates, when a
document is read; the renderer emits only what passed them. Client HTML is
never trusted: an editor's output is a document, and a document holds text.
Pasted HTML goes through the editor's schema, so a `javascript:` link, an
`<img onerror>` or Word's markup arrive as plain text and allowed marks only.
