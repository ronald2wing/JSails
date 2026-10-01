/**
 * The media picker: its URL policy, the projection of the library's paged
 * envelope, item labels, the request URL, and the DOM picker (text-only
 * labels, a per-term cache, the fixed failure message, Enter searching
 * instead of submitting the page's form).
 */

import { assertNode, closeEditorDom, editorWindow } from '../editor-dom.js';

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import {
  PICKER_ERROR_TEXT,
  createMediaPicker,
  isMediaPickerUrl,
  mapMediaAssetsToPickerItems,
  pickerItemLabel,
  pickerRequestUrl,
  type MediaPickerItem,
} from '../../../src/prosemirror/ui/media-picker.js';

after(closeEditorDom);

describe('isMediaPickerUrl', () => {
  it('accepts a root-relative path', () => {
    assert.equal(isMediaPickerUrl('/admin/media?format=json'), true);
  });

  it('accepts an absolute http(s) URL', () => {
    assert.equal(isMediaPickerUrl('https://example.com/admin/media?format=json'), true);
    assert.equal(isMediaPickerUrl('http://example.com/media'), true);
  });

  it('rejects blank values', () => {
    assert.equal(isMediaPickerUrl(''), false);
    assert.equal(isMediaPickerUrl('   '), false);
  });

  it('rejects control characters', () => {
    assert.equal(isMediaPickerUrl('/admin/media\u0000'), false);
    assert.equal(isMediaPickerUrl('/admin/media\n'), false);
  });

  it('rejects protocol-relative URLs and forbidden or misrooted shapes', () => {
    assert.equal(isMediaPickerUrl('//example.com/media'), false);
    assert.equal(isMediaPickerUrl('javascript:alert(1)'), false);
    assert.equal(isMediaPickerUrl('data:text/plain,hi'), false);
    assert.equal(isMediaPickerUrl('../media'), false);
    assert.equal(isMediaPickerUrl('/admin/../media'), false);
    assert.equal(isMediaPickerUrl('/admin\\media'), false);
  });
});

describe('mapMediaAssetsToPickerItems', () => {
  it('returns an empty list for anything but the paged envelope', () => {
    assert.deepEqual(mapMediaAssetsToPickerItems(undefined), []);
    assert.deepEqual(mapMediaAssetsToPickerItems(null), []);
    assert.deepEqual(mapMediaAssetsToPickerItems({}), []);
    assert.deepEqual(mapMediaAssetsToPickerItems('[]'), []);
    assert.deepEqual(mapMediaAssetsToPickerItems([]), []);
    assert.deepEqual(mapMediaAssetsToPickerItems({ assets: 'nope' }), []);
  });

  it('accepts the paged { assets, total } envelope', () => {
    const payload = {
      assets: [{ id: 'a1', filename: 'logo.png', mimeType: 'image/png', size: 10 }],
      total: 42,
    };
    const items = mapMediaAssetsToPickerItems(payload);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, 'a1');
  });

  it('projects well-formed assets and skips malformed entries', () => {
    const assets = [
      {
        id: 'a1',
        filename: 'logo.png',
        mimeType: 'image/png',
        size: 123,
        width: 10,
        height: 20,
        alt: 'Logo',
        caption: 'A logo',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      // missing id -> skipped
      { filename: 'no-id.png', mimeType: 'image/png', size: 1 },
      // id not a string -> skipped
      { id: 7, filename: 'num.png', mimeType: 'image/png', size: 1 },
      // negative size -> skipped
      { id: 'bad-size', filename: 'x.png', mimeType: 'image/png', size: -1 },
      // minimal valid entry (alt/caption default to '')
      { id: 'a2', filename: 'photo.jpg', mimeType: 'image/jpeg', size: 2048 },
    ];
    const items = mapMediaAssetsToPickerItems({ assets, total: assets.length });
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
      id: 'a1',
      filename: 'logo.png',
      mimeType: 'image/png',
      size: 123,
      alt: 'Logo',
      caption: 'A logo',
    });
    assert.deepEqual(items[1], {
      id: 'a2',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 2048,
      alt: '',
      caption: '',
    });
  });
});

describe('pickerItemLabel', () => {
  it('joins the filename and MIME type', () => {
    const item: MediaPickerItem = {
      id: 'a1',
      filename: 'logo.png',
      mimeType: 'image/png',
      size: 1,
      alt: '',
      caption: '',
    };
    assert.equal(pickerItemLabel(item), 'logo.png (image/png)');
  });

  it('falls back to the MIME type for a blank filename', () => {
    const item: MediaPickerItem = {
      id: 'a1',
      filename: '',
      mimeType: 'image/png',
      size: 1,
      alt: '',
      caption: '',
    };
    assert.equal(pickerItemLabel(item), 'image/png');
  });
});

describe('pickerRequestUrl', () => {
  it('adds the page size and the search term to the endpoint query', () => {
    assert.equal(pickerRequestUrl('/admin/media', ''), '/admin/media?limit=50');
    assert.equal(
      pickerRequestUrl('/admin/media?format=json', 'cat & dog'),
      '/admin/media?format=json&limit=50&q=cat+%26+dog',
    );
    assert.equal(pickerRequestUrl('/media#top', ''), '/media?limit=50#top');
  });
});

describe('createMediaPicker', () => {
  /** Wait until `condition` holds, yielding to pending callbacks between checks. */
  async function until(condition: () => boolean): Promise<void> {
    for (let turn = 0; turn < 1000 && !condition(); turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(condition(), 'the condition became true');
  }

  function stubFetch(respond: (url: string) => Promise<unknown>): {
    calls: string[];
    restore(): void;
  } {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const calls: string[] = [];
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: (url: string, init: { credentials?: string }) => {
        assert.equal(init.credentials, 'same-origin');
        calls.push(url);
        return respond(url);
      },
    });
    return {
      calls,
      restore() {
        if (previous === undefined) {
          Reflect.deleteProperty(globalThis, 'fetch');
        } else {
          Object.defineProperty(globalThis, 'fetch', previous);
        }
      },
    };
  }

  it('lists assets as text, hands the chosen one over, and caches the page per term', async () => {
    const stub = stubFetch(async () => ({
      ok: true,
      json: async () => ({
        assets: [
          {
            id: 'a1',
            filename: '<img src=x onerror=alert(1)>.png',
            mimeType: 'image/png',
            size: 1,
          },
        ],
        total: 1,
      }),
    }));
    try {
      const chosen: string[] = [];
      const picker = createMediaPicker({
        url: '/admin/media',
        onSelect: (item) => chosen.push(item.id),
      });
      editorWindow.document.body.append(picker as never);
      const show = Array.from(picker.querySelectorAll('button')).find(
        (b) => b.textContent === 'Show media',
      );
      show?.click();
      await until(() => picker.querySelectorAll('li button').length === 1);
      const item = picker.querySelector('li button');
      assert.equal(item?.textContent, '<img src=x onerror=alert(1)>.png (image/png)');
      assertNode(picker.querySelector('img'), null);
      (item as HTMLButtonElement).click();
      assert.deepEqual(chosen, ['a1']);
      show?.click();
      assert.equal(stub.calls.length, 1, 'the same term is served from the cache');
      const search = picker.querySelector('input[type="search"]') as HTMLInputElement;
      search.value = 'logo';
      const enter = new editorWindow.KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
      search.dispatchEvent(enter as unknown as Event);
      assert.equal(enter.defaultPrevented, true);
      await until(() => stub.calls.length === 2);
      assert.equal(stub.calls[1], '/admin/media?limit=50&q=logo');
    } finally {
      stub.restore();
    }
  });

  it('lets only the latest search answer when an earlier response arrives last', async () => {
    const pending = new Map<string, (filename: string) => void>();
    const stub = stubFetch(
      (url) =>
        new Promise((resolve) => {
          pending.set(url, (filename) => {
            resolve({
              ok: true,
              json: async () => ({
                assets: [{ id: filename, filename, mimeType: 'image/png', size: 1 }],
                total: 1,
              }),
            });
          });
        }),
    );
    try {
      const picker = createMediaPicker({ url: '/admin/media', onSelect: () => {} });
      const search = picker.querySelector('input[type="search"]') as HTMLInputElement;
      const enter = (): void => {
        search.dispatchEvent(
          new editorWindow.KeyboardEvent('keydown', {
            key: 'Enter',
            cancelable: true,
          }) as unknown as Event,
        );
      };
      search.value = 'old';
      enter();
      search.value = 'new';
      enter();
      pending.get('/admin/media?limit=50&q=new')?.('new.png');
      await until(() => picker.querySelector('li button') !== null);
      pending.get('/admin/media?limit=50&q=old')?.('old.png');
      // A macrotask turn runs only after every microtask the stale response
      // queued, so its continuations have all settled.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const labels = Array.from(picker.querySelectorAll('li button')).map((b) => b.textContent);
      assert.deepEqual(labels, ['new.png (image/png)']);
    } finally {
      stub.restore();
    }
  });

  it('lets a cached term answer over a request still in flight for another term', async () => {
    const pending = new Map<string, () => void>();
    const stub = stubFetch(
      (url) =>
        new Promise((resolve) => {
          const filename = `${new URL(url, 'https://editor.test').searchParams.get('q') ?? ''}.png`;
          pending.set(url, () => {
            resolve({
              ok: true,
              json: async () => ({
                assets: [{ id: filename, filename, mimeType: 'image/png', size: 1 }],
                total: 1,
              }),
            });
          });
        }),
    );
    try {
      const chosen: string[] = [];
      const picker = createMediaPicker({
        url: '/admin/media',
        onSelect: (item) => chosen.push(item.id),
      });
      const search = picker.querySelector('input[type="search"]') as HTMLInputElement;
      const searchFor = (term: string): void => {
        search.value = term;
        search.dispatchEvent(
          new editorWindow.KeyboardEvent('keydown', {
            key: 'Enter',
            cancelable: true,
          }) as unknown as Event,
        );
      };
      const labels = (): (string | null)[] =>
        Array.from(picker.querySelectorAll('li button')).map((b) => b.textContent);

      searchFor('cat');
      pending.get('/admin/media?limit=50&q=cat')?.();
      await until(() => labels().length === 1);
      searchFor('dog');
      searchFor('cat');
      assert.equal(stub.calls.length, 2, 'cat is served from the cache');
      assert.deepEqual(labels(), ['cat.png (image/png)']);
      pending.get('/admin/media?limit=50&q=dog')?.();
      // A macrotask turn runs only after every microtask the stale response
      // queued, so its continuations have all settled.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      assert.deepEqual(labels(), ['cat.png (image/png)']);
      (picker.querySelector('li button') as HTMLButtonElement).click();
      assert.deepEqual(chosen, ['cat.png']);
      // The superseded response was not cached either: dog asks again.
      searchFor('dog');
      assert.equal(stub.calls.length, 3);
    } finally {
      stub.restore();
    }
  });

  it('shows one fixed message when the request fails or is refused', async () => {
    for (const respond of [
      async () => ({ ok: false, json: async () => ({ assets: [] }) }),
      async () => {
        throw new Error('network down: secret detail');
      },
    ]) {
      const stub = stubFetch(respond);
      try {
        const picker = createMediaPicker({ url: '/admin/media', onSelect: () => {} });
        const status = picker.querySelector('[role="status"]');
        (picker.querySelector('button') as HTMLButtonElement).click();
        await until(() => status?.textContent === PICKER_ERROR_TEXT);
      } finally {
        stub.restore();
      }
    }
  });
});
