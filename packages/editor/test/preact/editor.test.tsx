/**
 * The Preact editor and the form-field island in a DOM, over the markup
 * `RichTextField` renders on the server.
 *
 * - State 1: before the island hydrates, and until the editor is mounted,
 *   the server's source input is in the form with the original bytes; the
 *   island's first render keeps it, and the server's wrapper, through
 *   hydration.
 * - State 2: once mounted, the source input is gone and the form's
 *   `formdata` event takes the field from the editor state.
 * - State 3: an unreadable value shows the issues with no editor and no
 *   field, until the author confirms "discard and start empty".
 *
 * happy-dom builds a `FormData` without firing `formdata`, so the tests
 * dispatch the event the browser fires; the browser stage of
 * `verify:starter` covers real submissions.
 */

import { assertNode, closeEditorDom, editorWindow } from '../prosemirror/editor-dom.js';

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { hydrate, options, render } from 'preact';

import { renderToString } from 'jsails/render-to-string';
import type { RichTextDocument } from 'jsails/rich-text';

import { RICH_TEXT_SOURCE_ATTRIBUTE } from '../../src/field/contract.js';
import {
  RICH_TEXT_ISLAND,
  RichTextEditor,
  RichTextIsland,
  richTextIsland,
  type RichTextEditorHandle,
} from '../../src/preact/index.js';
import { RichTextField } from '../../src/server/index.js';

// Preact runs `useEffect` after the next frame, through a timer that also
// cancels an animation frame; a timer left after the window closes would
// find no `cancelAnimationFrame`. A macrotask is frame enough here.
options.requestAnimationFrame = (callback) => {
  setImmediate(callback);
};

after(async () => {
  delete options.requestAnimationFrame;
  await closeEditorDom();
});

const DOCUMENT: RichTextDocument = {
  version: 2,
  blocks: [{ type: 'paragraph', content: [{ text: 'Hello, <world>.' }] }],
};

/** Wait until `condition` holds, yielding to pending work between checks. */
async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2000 && !condition(); turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), 'the condition became true');
}

interface Field {
  readonly form: HTMLFormElement;
  readonly island: HTMLElement;
}

/** A form holding the server markup of a field for `value`. */
function serverField(value: unknown): Field {
  const form = editorWindow.document.createElement('form') as unknown as HTMLFormElement;
  form.innerHTML = renderToString(
    <RichTextField name="body" value={value} label="Body" id="field-body" />,
  );
  editorWindow.document.body.append(form as never);
  const island = form.querySelector(`[data-jsails-island="${RICH_TEXT_ISLAND}"]`) as HTMLElement;
  return { form, island };
}

function islandProps(island: HTMLElement): Record<string, unknown> {
  return JSON.parse(island.getAttribute('data-jsails-props') ?? '{}') as Record<string, unknown>;
}

function source(field: Field): HTMLInputElement | null {
  return field.form.querySelector(`[${RICH_TEXT_SOURCE_ATTRIBUTE}]`);
}

/** The entries the browser would submit: the form's controls plus the `formdata` listeners' changes. */
function submission(form: HTMLFormElement): FormData {
  const data = new editorWindow.FormData(form as never) as unknown as FormData;
  const event = new editorWindow.Event('formdata');
  Object.defineProperty(event, 'formData', { value: data });
  form.dispatchEvent(event as unknown as Event);
  return data;
}

function state(field: Field): string | null {
  return field.island.querySelector('[data-state]')?.getAttribute('data-state') ?? null;
}

describe('RichTextIsland', () => {
  it('is registered under the field island name', () => {
    assert.equal(RICH_TEXT_ISLAND, 'rich-text');
    assert.equal(richTextIsland[RICH_TEXT_ISLAND], RichTextIsland);
  });

  it('round-trips the original bytes before hydration and until mounted (state 1)', async () => {
    const field = serverField(DOCUMENT);
    const original = JSON.stringify(DOCUMENT);
    assert.equal(submission(field.form).get('body'), original);
    const fallback = field.island.querySelector('.rich-text-editor-fallback');
    hydrate(<RichTextIsland {...islandProps(field.island)} />, field.island);
    // Until the runtime has read the source, the server's markup stays as written.
    assert.equal(state(field), 'loading');
    assertNode(field.island.querySelector('.rich-text-editor-fallback'), fallback);
    assert.match(field.island.textContent ?? '', /needs JavaScript/);
    assert.equal(source(field)?.value, original);
    assert.equal(source(field)?.getAttribute('name'), 'body');
    assert.equal(submission(field.form).get('body'), original);
    await until(() => state(field) === 'editing');
    render(null, field.island);
    field.form.remove();
  });

  it('keeps the named source input when the editor fails to mount (state 1)', async () => {
    const field = serverField(DOCUMENT);
    const original = JSON.stringify(DOCUMENT);
    // The editor is built into its host element last; a mount that throws
    // there stands for any failure the browser raises while mounting.
    const append = editorWindow.Element.prototype.append;
    editorWindow.Element.prototype.append = function (this: Element, ...nodes) {
      if (this.classList.contains('rich-text-editor-host')) {
        throw new Error('mount failed');
      }
      append.apply(this, nodes);
    };
    try {
      hydrate(<RichTextIsland {...islandProps(field.island)} />, field.island);
      await until(() => state(field) === 'failed');
    } finally {
      editorWindow.Element.prototype.append = append;
    }
    assert.match(field.island.textContent ?? '', /could not start/);
    assertNode(field.island.querySelector('[role="textbox"]'), null);
    assert.equal(source(field)?.getAttribute('name'), 'body');
    assert.equal(source(field)?.value, original);
    assert.equal(field.form.querySelectorAll(`[${RICH_TEXT_SOURCE_ATTRIBUTE}]`).length, 1);
    assert.equal(submission(field.form).get('body'), original, 'a save sends the stored bytes');
    render(null, field.island);
    field.form.remove();
  });

  it('takes the field from the editor once mounted (state 2)', async () => {
    const field = serverField(DOCUMENT);
    hydrate(<RichTextIsland {...islandProps(field.island)} />, field.island);
    await until(() => state(field) === 'editing');
    assert.equal(source(field), null, 'the source input is gone');
    // Hydration reused the server's wrapper: no server fallback is left beside it.
    assert.equal(field.island.children.length, 1);
    assert.doesNotMatch(field.island.textContent ?? '', /needs JavaScript/);
    const surface = field.island.querySelector('[role="textbox"]');
    assert.equal(surface?.id, 'field-body');
    assert.equal(surface?.getAttribute('aria-label'), 'Body');
    assert.equal(submission(field.form).get('body'), JSON.stringify(DOCUMENT));
    // An edit is in the very next submission: nothing is mirrored or debounced.
    const insert = Array.from(field.island.querySelectorAll('button')).find(
      (button) => button.textContent === 'Insert',
    );
    insert?.click();
    const divider = field.island.querySelector('[role="menuitem"]') as HTMLElement;
    divider.click();
    const submitted = JSON.parse(String(submission(field.form).get('body'))) as RichTextDocument;
    assert.deepEqual(
      submitted.blocks.map((block) => block.type),
      ['paragraph', 'divider', 'paragraph'],
    );
    render(null, field.island);
    assert.equal(submission(field.form).has('body'), false, 'the listener left with the island');
    field.form.remove();
  });

  it('shows the issues with no editor and no field, then discards on confirmation (state 3)', async () => {
    const field = serverField({ version: 1, blocks: [] });
    assert.equal(source(field)?.getAttribute('name'), null);
    assert.match(field.island.textContent ?? '', /cannot be edited/);
    assert.equal(submission(field.form).has('body'), false, 'no field without JavaScript');
    const serverPanel = field.island.querySelector('.rich-text-editor-unreadable');
    hydrate(<RichTextIsland {...islandProps(field.island)} />, field.island);
    // While the runtime loads, the server's panel is kept, not replaced by a loading line.
    assertNode(field.island.querySelector('.rich-text-editor-unreadable'), serverPanel);
    // The server already wrote `data-state="unreadable"`; the island's own
    // render is the one without the source input.
    await until(() => source(field) === null);
    assert.equal(state(field), 'unreadable');
    assert.equal(field.island.children.length, 1);
    assert.equal(field.island.querySelectorAll('.rich-text-editor-unreadable').length, 1);
    assertNode(field.island.querySelector('[role="textbox"]'), null);
    const lines = Array.from(field.island.querySelectorAll('li')).map((li) => li.textContent);
    assert.deepEqual(lines, [
      'version: version 1 documents must be upgraded with upgradeRichTextDocument',
    ]);
    assert.equal(submission(field.form).has('body'), false, 'a save keeps the stored value');

    const byText = (text: string): HTMLButtonElement =>
      Array.from(field.island.querySelectorAll('button')).find(
        (button) => button.textContent === text,
      ) as HTMLButtonElement;
    byText('Discard the stored content…').click();
    await until(() => byText('Discard and start empty') !== undefined);
    byText('Keep the stored content').click();
    await until(() => byText('Discard the stored content…') !== undefined);
    byText('Discard the stored content…').click();
    await until(() => byText('Discard and start empty') !== undefined);
    byText('Discard and start empty').click();
    await until(() => state(field) === 'editing');
    assert.equal(submission(field.form).get('body'), JSON.stringify({ version: 2, blocks: [] }));
    render(null, field.island);
    field.form.remove();
  });

  it('reads a source that is not JSON as unreadable, without echoing it', async () => {
    const field = serverField(DOCUMENT);
    const input = source(field) as HTMLInputElement;
    input.value = '{"version":2,"blocks":[ secret';
    hydrate(<RichTextIsland {...islandProps(field.island)} />, field.island);
    await until(() => state(field) === 'unreadable');
    assert.doesNotMatch(field.island.textContent ?? '', /secret/);
    assert.match(field.island.textContent ?? '', /document: value is not a rich-text document/);
    render(null, field.island);
    field.form.remove();
  });
});

describe('RichTextEditor', () => {
  it('mounts, reports changes, takes a new document, and tears down', async () => {
    const container = editorWindow.document.createElement('div') as unknown as HTMLElement;
    editorWindow.document.body.append(container as never);
    let handle: RichTextEditorHandle | undefined;
    const changes: RichTextDocument[] = [];
    const view = (document: RichTextDocument) => (
      <RichTextEditor
        document={document}
        label="Notes"
        class="notes"
        onMount={(mounted) => {
          handle = mounted;
        }}
        onChange={(next) => changes.push(next)}
      />
    );
    render(view(DOCUMENT), container);
    assert.ok(container.querySelector('.rich-text-editor-host.notes') !== null);
    await until(() => handle !== undefined);
    assert.deepEqual(handle?.getDocument(), DOCUMENT);
    handle?.view.dispatch(handle.view.state.tr.insertText('!', 1));
    assert.equal(changes.length, 1);
    // The document the editor reported is no replacement.
    render(view(changes[0] as RichTextDocument), container);
    assert.deepEqual(handle?.getDocument(), changes[0]);
    const replacement: RichTextDocument = { version: 2, blocks: [{ type: 'divider' }] };
    render(view(replacement), container);
    await until(() => handle?.getDocument().blocks[0]?.type === 'divider');
    render(null, container);
    assertNode(container.querySelector('.rich-text-editor-ui'), null);
  });

  it('calls onMountError for a document parseRichText refuses', async () => {
    const container = editorWindow.document.createElement('div') as unknown as HTMLElement;
    let failed = false;
    render(
      <RichTextEditor
        document={{ version: 2, blocks: [{ type: 'paragraph', content: [{ text: '' }] }] }}
        onMountError={() => {
          failed = true;
        }}
      />,
      container,
    );
    await until(() => failed);
    render(null, container);
  });
});
