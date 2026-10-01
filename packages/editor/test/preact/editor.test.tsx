/**
 * Rich-text editor Preact island contract tests.
 *
 * These render `RichTextEditor` and its island registration surface through the
 * shared Preact render-to-string wrapper and assert the server-rendered
 * markup: the wrapper/surface/fallback shape, the hidden form input and its
 * escaped JSON value, and the island name/helper exports. There is no DOM or
 * test-renderer here, so `useEffect` never runs — the mount path (Editor.js
 * attach, change reporting, teardown) is browser-only and exercised by the
 * mount unit tests, not this file. The submit guard runs against a structural
 * form double.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToString } from 'jsails/render-to-string';
import {
  RICH_TEXT_ISLAND,
  RichTextEditor,
  RichTextIsland,
  richTextIsland,
} from '../../src/preact/index.js';
import type { RichTextDocument } from 'jsails/rich-text';

import type { RichTextEditorSnapshot } from '../../src/editorjs/mount.js';
import {
  guardFormSubmit,
  type GuardedForm,
  type GuardedSubmitEvent,
} from '../../src/preact/editor.js';

/** An authored document with one paragraph, for serialization assertions. */
const document: RichTextDocument = {
  version: 1,
  blocks: [{ id: 'intro', type: 'paragraph', text: 'Hello, world.' }],
};

describe('RichTextEditor', () => {
  it('renders the wrapper, surface, and fallback before mount', () => {
    const html = renderToString(<RichTextEditor document={document} />);

    assert.match(html, /class="rich-text-editor"/);
    assert.match(html, /class="rich-text-editor-surface"/);
    assert.match(html, /class="rich-text-editor-fallback"/);
    assert.match(html, /Rich text editing requires JavaScript\./);
  });

  it('renders a hidden input with the serialized JSON when name is given', () => {
    const html = renderToString(<RichTextEditor document={document} name="body" />);

    // The authored document travels as escaped JSON in the hidden input's value,
    // never as inline HTML.
    assert.match(html, /<input type="hidden" name="body"/);
    assert.match(html, /value="{&quot;version&quot;:1,&quot;blocks&quot;:\[/);
    assert.match(html, /&quot;id&quot;:&quot;intro&quot;/);
  });

  it('wraps the hidden value in an editor envelope when an adapter id is given', () => {
    const html = renderToString(
      <RichTextEditor document={document} editor="editorjs" name="body" />,
    );

    assert.match(html, /value="{&quot;version&quot;:1,&quot;editor&quot;:&quot;editorjs&quot;/);
    assert.match(html, /&quot;content&quot;:\{&quot;version&quot;:1,&quot;blocks&quot;:/);
  });

  it('loads an EditorDocument envelope and keeps its editor id', () => {
    const envelope = {
      version: 1 as const,
      editor: 'editorjs',
      content: document,
      native: document,
    };
    const html = renderToString(<RichTextEditor document={envelope} name="body" />);

    assert.match(html, /&quot;editor&quot;:&quot;editorjs&quot;/);
    assert.match(html, /&quot;content&quot;:\{&quot;version&quot;:1,&quot;blocks&quot;:/);
  });

  it('omits the hidden input when name is absent', () => {
    const html = renderToString(<RichTextEditor document={document} />);

    assert.doesNotMatch(html, /type="hidden"/);
  });

  it('applies class, id, and aria-label', () => {
    const html = renderToString(
      <RichTextEditor document={document} class="mine" id="body-editor" ariaLabel="Body" />,
    );

    assert.match(html, /class="rich-text-editor mine"/);
    assert.match(html, /id="body-editor"/);
    assert.match(html, /aria-label="Body"/);
  });

  it('escapes authored text instead of trusting it (no inline HTML)', () => {
    const hostile: RichTextDocument = {
      version: 1,
      blocks: [{ id: 'x', type: 'paragraph', text: '<script>alert(1)</script>' }],
    };
    const html = renderToString(<RichTextEditor document={hostile} name="body" />);

    assert.doesNotMatch(html, /<script>alert/);
  });
});

describe('island registration surface', () => {
  it('exposes the island name constant', () => {
    assert.equal(RICH_TEXT_ISLAND, 'rich-text');
  });

  it('registers the adapter component under the island name', () => {
    assert.equal(typeof richTextIsland[RICH_TEXT_ISLAND], 'function');
    assert.equal(richTextIsland[RICH_TEXT_ISLAND], RichTextIsland);
  });

  it('falls back to an empty document for invalid island props', () => {
    const html = renderToString(<RichTextIsland document="not-a-document" name="body" />);

    assert.match(html, /type="hidden" name="body"/);
  });

  it('passes through data-only island props to the editor', () => {
    const html = renderToString(
      <RichTextIsland
        document={document}
        name="body"
        id="body-editor"
        class="mine"
        ariaLabel="Body"
      />,
    );

    assert.match(html, /type="hidden" name="body"/);
    assert.match(html, /id="body-editor"/);
    assert.match(html, /class="rich-text-editor mine"/);
    assert.match(html, /aria-label="Body"/);
  });
});

/**
 * A form double: `submit` dispatches a user submit through the captured
 * listeners, and `requestSubmit` dispatches synchronously like the DOM does,
 * recording each submission no listener prevented.
 */
function fakeForm() {
  const listeners: ((event: GuardedSubmitEvent) => void)[] = [];
  const submitted: (HTMLElement | null)[] = [];
  const dispatch = (submitter: HTMLElement | null): void => {
    let prevented = false;
    const event: GuardedSubmitEvent = {
      submitter,
      preventDefault: () => {
        prevented = true;
      },
      stopImmediatePropagation: () => {},
    };
    for (const listener of [...listeners]) listener(event);
    if (!prevented) submitted.push(submitter);
  };
  const form: GuardedForm = {
    addEventListener: (_type, listener) => {
      listeners.push(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.splice(listeners.indexOf(listener), 1);
    },
    requestSubmit: (submitter) => dispatch(submitter ?? null),
  };
  return { form, submitted, submit: dispatch, listeners };
}

function snapshotOf(text: string): RichTextEditorSnapshot {
  return { ok: true, document: { version: 1, blocks: [{ id: 'b1', type: 'paragraph', text }] } };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('guardFormSubmit', () => {
  it('holds a submit until the editor is saved, then resubmits with that content', async () => {
    const { form, submitted, submit } = fakeForm();
    const button = { name: 'publish' } as unknown as HTMLElement;
    let release!: (snapshot: RichTextEditorSnapshot) => void;
    const settled: string[] = [];
    guardFormSubmit(form, {
      flush: () => new Promise((resolve) => (release = resolve)),
      active: () => true,
      settle: (snapshot) => {
        settled.push(snapshot.ok ? JSON.stringify(snapshot.document.blocks) : 'invalid');
        // The content must be in the form before the resubmit is dispatched.
        assert.equal(submitted.length, 0);
      },
    });

    submit(button);
    // The keystroke's save has not settled: nothing may be submitted yet.
    assert.deepEqual(submitted, []);
    release(snapshotOf('latest'));
    await settle();
    assert.equal(settled.length, 1);
    assert.match(settled[0] ?? '', /latest/);
    assert.deepEqual(submitted, [button]);
  });

  it('refuses the submit when the content has no rich-text form', async () => {
    const { form, submitted, submit } = fakeForm();
    const settled: boolean[] = [];
    guardFormSubmit(form, {
      flush: async () => ({ ok: false }),
      active: () => true,
      settle: (snapshot) => settled.push(snapshot.ok),
    });

    submit(null);
    await settle();
    assert.deepEqual(settled, [false]);
    assert.deepEqual(submitted, []);
  });

  it('refuses the submit when the save fails', async () => {
    const { form, submitted, submit } = fakeForm();
    const settled: boolean[] = [];
    guardFormSubmit(form, {
      flush: () => Promise.reject(new Error('destroyed')),
      active: () => true,
      settle: (snapshot) => settled.push(snapshot.ok),
    });

    submit(null);
    await settle();
    assert.deepEqual(settled, [false]);
    assert.deepEqual(submitted, []);
  });

  it('resubmits once for submits made while a save runs', async () => {
    const { form, submitted, submit } = fakeForm();
    let flushes = 0;
    guardFormSubmit(form, {
      flush: async () => {
        flushes += 1;
        return snapshotOf('latest');
      },
      active: () => true,
      settle: () => {},
    });

    submit(null);
    submit(null);
    await settle();
    assert.equal(flushes, 1);
    assert.deepEqual(submitted, [null]);
  });

  it('lets a submit through while the editor is not mounted', () => {
    const { form, submitted, submit } = fakeForm();
    guardFormSubmit(form, {
      flush: () => assert.fail('an unmounted editor has nothing to save'),
      active: () => false,
      settle: () => {},
    });

    submit(null);
    assert.deepEqual(submitted, [null]);
  });

  it('removes its listener and drops a pending resubmit when released', async () => {
    const { form, submitted, submit, listeners } = fakeForm();
    let release!: (snapshot: RichTextEditorSnapshot) => void;
    const dispose = guardFormSubmit(form, {
      flush: () => new Promise((resolve) => (release = resolve)),
      active: () => true,
      settle: () => assert.fail('a released guard applies nothing'),
    });

    submit(null);
    dispose();
    assert.equal(listeners.length, 0);
    release(snapshotOf('late'));
    await settle();
    assert.deepEqual(submitted, []);
  });
});
