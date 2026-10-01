/**
 * Media picker fetch behavior.
 *
 * The picker is driven through the exported `ImageTool` with a fake `document`
 * and `fetch` installed on `globalThis`, so the real `buildPicker` wiring runs
 * without a browser. Covers the three properties the picker must hold: the
 * request is bounded and carries the search term, reopening reuses the cached
 * page, and a changed term refetches.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ImageTool } from '../../src/index.js';

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

interface FakeNode {
  tagName: string;
  textContent: string;
  value: string;
  attributes: Map<string, string>;
  children: FakeNode[];
  listeners: Map<string, (() => void)[]>;
  appendChild(child: FakeNode): void;
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, fn: () => void): void;
  querySelector(selector: string): { value: string } | null;
  click(): void;
}

function fakeNode(tagName: string): FakeNode {
  let text = '';
  const node: FakeNode = {
    tagName,
    get textContent() {
      return text;
    },
    // A real element drops its children when textContent is assigned, which is
    // how the picker clears a previous list before rendering a new one.
    set textContent(next: string) {
      text = next;
      node.children.length = 0;
    },
    value: '',
    attributes: new Map(),
    children: [],
    listeners: new Map(),
    appendChild(child) {
      node.children.push(child);
    },
    setAttribute(name, value) {
      node.attributes.set(name, value);
    },
    addEventListener(name, fn) {
      const list = node.listeners.get(name) ?? [];
      list.push(fn);
      node.listeners.set(name, list);
    },
    querySelector(selector) {
      const field = selector.match(/data-field="([^"]+)"/)?.[1];
      if (field === undefined) return null;
      const walk = (current: FakeNode): FakeNode | undefined => {
        if (current.attributes.get('data-field') === field) return current;
        for (const child of current.children) {
          const found = walk(child);
          if (found !== undefined) return found;
        }
        return undefined;
      };
      const found = walk(node);
      return found === undefined ? null : { value: found.value };
    },
    click() {
      for (const fn of node.listeners.get('click') ?? []) fn();
    },
  };
  return node;
}

/** Find the first descendant matching a predicate. */
function find(node: FakeNode, predicate: (candidate: FakeNode) => boolean): FakeNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.children) {
    const found = find(child, predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const globals = globalThis as unknown as {
  document?: { createElement(tag: string): FakeNode };
  fetch?: (url: string, init: { credentials: string }) => Promise<unknown>;
};

const originalDocument = globals.document;
const originalFetch = globals.fetch;

afterEach(() => {
  globals.document = originalDocument;
  globals.fetch = originalFetch;
});

/** Install a fake document and a fetch that records every requested URL. */
function install(requested: string[], payload: unknown): void {
  globals.document = { createElement: (tag) => fakeNode(tag) };
  globals.fetch = async (url) => {
    requested.push(url);
    return { ok: true, json: async () => payload };
  };
}

/** Render an image tool and return its picker nodes. */
function renderPicker(): { search: FakeNode; button: FakeNode; host: FakeNode } {
  const tool = new ImageTool({
    data: { mediaId: '' },
    config: { mediaPickerUrl: '/admin/media?format=json' },
  } as never);
  const wrapper = tool.render() as unknown as FakeNode;
  const search = find(
    wrapper,
    (node) => node.tagName === 'input' && node.attributes.get('type') === 'search',
  );
  const button = find(wrapper, (node) => node.tagName === 'button');
  // The picker host is the empty div immediately after the trigger button.
  const buttonIndex = wrapper.children.indexOf(button!);
  const host = wrapper.children[buttonIndex + 1];
  assert.ok(search, 'picker renders a search input');
  assert.ok(button, 'picker renders a trigger button');
  assert.ok(host, 'picker renders a host');
  return { search, button, host };
}

/** Let the picker's promise chain settle, including the rejection path. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('media picker fetch', () => {
  it('requests a bounded page and carries the search term', async () => {
    const requested: string[] = [];
    install(requested, { assets: [], total: 0 });

    const { search, button } = renderPicker();
    search.value = '  logo  ';
    button.click();
    await settle();

    assert.equal(requested.length, 1);
    const url = new URL(requested[0]!, 'http://localhost');
    assert.equal(url.pathname, '/admin/media');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('limit'), '50');
    assert.equal(url.searchParams.get('q'), 'logo', 'the term is trimmed');
  });

  it('omits q when the search box is empty', async () => {
    const requested: string[] = [];
    install(requested, { assets: [], total: 0 });

    const { button } = renderPicker();
    button.click();
    await settle();

    const url = new URL(requested[0]!, 'http://localhost');
    assert.equal(url.searchParams.has('q'), false);
  });

  it('reuses the cached page when reopened with the same term', async () => {
    const requested: string[] = [];
    install(requested, {
      assets: [{ id: 'a1', filename: 'logo.png', mimeType: 'image/png', size: 10 }],
      total: 1,
    });

    const { button, host } = renderPicker();
    button.click();
    await settle();
    assert.equal(requested.length, 1);
    assert.equal(host.children.length, 1, 'one item rendered');

    button.click();
    await settle();
    assert.equal(requested.length, 1, 'reopening must not refetch');
    assert.equal(host.children.length, 1);
  });

  it('refetches when the search term changes', async () => {
    const requested: string[] = [];
    install(requested, { assets: [], total: 0 });

    const { search, button } = renderPicker();
    button.click();
    await settle();
    assert.equal(requested.length, 1);

    search.value = 'hero';
    button.click();
    await settle();
    assert.equal(requested.length, 2);
    assert.equal(new URL(requested[1]!, 'http://localhost').searchParams.get('q'), 'hero');
  });

  it('reports a value-free message when the request fails', async () => {
    globals.document = { createElement: (tag) => fakeNode(tag) };
    globals.fetch = async () => ({ ok: false, json: async () => ({}) });

    const { button, host } = renderPicker();
    button.click();
    await settle();

    assert.equal(host.textContent, 'Media list could not be loaded.');
  });
});
