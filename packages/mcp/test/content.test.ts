/**
 * Content: the toolResult builders, block validation (annotations, resource
 * link size and icons included), resource bodies, and strict JSON
 * serialization.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  InvalidContentError,
  isToolResult,
  jsonByteLength,
  strictJson,
  toolResult,
  wireContent,
  wireContentList,
  wireResourceContent,
} from '../src/content.js';

describe('toolResult', () => {
  it('builds frozen branded results', () => {
    const structured = toolResult.structured({ a: 1 }, [{ type: 'text', text: 'one' }]);
    assert.ok(isToolResult(structured));
    assert.ok(Object.isFrozen(structured));
    assert.deepEqual(structured, {
      structured: { a: 1 },
      content: [{ type: 'text', text: 'one' }],
    });
    assert.ok(isToolResult(toolResult.content([])));
    assert.equal(isToolResult({ structured: 1 }), false);
  });
});

describe('wireContent', () => {
  it('accepts every valid block type', () => {
    assert.deepEqual(wireContent({ type: 'text', text: 'hi' }), { type: 'text', text: 'hi' });
    assert.deepEqual(wireContent({ type: 'image', data: 'aGk=', mimeType: 'image/png' }), {
      type: 'image',
      data: 'aGk=',
      mimeType: 'image/png',
    });
    assert.equal(wireContent({ type: 'audio', data: 'aGk=', mimeType: 'audio/wav' }).type, 'audio');
    assert.deepEqual(
      wireContent({ type: 'resource_link', uri: 'notes://1', name: 'n', title: 'T' }),
      {
        type: 'resource_link',
        uri: 'notes://1',
        name: 'n',
        title: 'T',
      },
    );
    assert.deepEqual(wireContent({ type: 'resource', resource: { uri: 'notes://1', text: 'x' } }), {
      type: 'resource',
      resource: { uri: 'notes://1', text: 'x' },
    });
  });

  it('rejects malformed blocks', () => {
    const invalid: unknown[] = [
      null,
      { type: 'video' },
      { type: 'text', text: 1 },
      { type: 'image', data: 'not base64!', mimeType: 'image/png' },
      { type: 'image', data: 'aGk=', mimeType: 'audio/wav' },
      { type: 'image', data: 'aGk=' },
      { type: 'resource_link', uri: 'relative', name: 'n' },
      { type: 'resource_link', uri: 'notes://1', name: '' },
      { type: 'resource', resource: { text: 'x' } },
      { type: 'resource', resource: { uri: 'notes://1', text: 'x', blob: 'aGk=' } },
    ];
    for (const block of invalid) {
      assert.throws(() => wireContent(block), InvalidContentError, JSON.stringify(block));
    }
    assert.throws(() => wireContentList('text'), InvalidContentError);
  });
});

describe('content annotations and resource link metadata', () => {
  const annotations = {
    audience: ['user', 'user'],
    priority: 0.25,
    lastModified: '2026-11-19T10:00:00.5+01:00',
    extra: 'dropped',
  };

  it('carries annotations on every block type, deduplicating the audience', () => {
    const checked = { audience: ['user'], priority: 0.25, lastModified: annotations.lastModified };
    for (const block of [
      { type: 'text', text: 'hi' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'audio', data: 'AAAA', mimeType: 'audio/wav' },
      { type: 'resource_link', uri: 'x://a', name: 'a' },
      { type: 'resource', resource: { uri: 'x://a', text: 't' } },
    ]) {
      assert.deepEqual(wireContent({ ...block, annotations }), { ...block, annotations: checked });
    }
    assert.deepEqual(wireContent({ type: 'text', text: 'hi', annotations: {} }), {
      type: 'text',
      text: 'hi',
    });
  });

  it('carries a resource link size and icons', () => {
    assert.deepEqual(
      wireContent({
        type: 'resource_link',
        uri: 'x://a',
        name: 'a',
        size: 1024,
        icons: [{ src: 'https://example.com/i.png', sizes: ['48x48'], theme: 'dark' }],
        _meta: { dropped: true },
      }),
      {
        type: 'resource_link',
        uri: 'x://a',
        name: 'a',
        size: 1024,
        icons: [{ src: 'https://example.com/i.png', sizes: ['48x48'], theme: 'dark' }],
      },
    );
  });

  it('rejects malformed annotations, sizes, and icons', () => {
    const text = { type: 'text', text: 'hi' };
    const link = { type: 'resource_link', uri: 'x://a', name: 'a' };
    for (const block of [
      { ...text, annotations: 'x' },
      { ...text, annotations: { audience: 'user' } },
      { ...text, annotations: { audience: ['model'] } },
      { ...text, annotations: { priority: 1.5 } },
      { ...text, annotations: { priority: -0.1 } },
      { ...text, annotations: { priority: Number.NaN } },
      { ...text, annotations: { priority: '1' } },
      { ...text, annotations: { lastModified: 'yesterday' } },
      { ...text, annotations: { lastModified: '2026-11-19' } },
      { ...text, annotations: { lastModified: '2026-13-40T99:00:00Z' } },
      { ...link, size: -1 },
      { ...link, size: 1.5 },
      { ...link, icons: 'x' },
      { ...link, icons: [{ src: 'http://example.com/i.png' }] },
      { ...link, icons: [{ src: 'https://example.com/i.png', sizes: ['big'] }] },
    ]) {
      assert.throws(() => wireContent(block), InvalidContentError);
    }
  });
});

describe('wireResourceContent', () => {
  it('fills the default URI and checks blobs', () => {
    assert.deepEqual(wireResourceContent({ text: 'x', mimeType: 'text/plain' }, 'notes://1'), {
      uri: 'notes://1',
      mimeType: 'text/plain',
      text: 'x',
    });
    assert.deepEqual(wireResourceContent({ blob: 'aGk=' }, 'notes://1'), {
      uri: 'notes://1',
      blob: 'aGk=',
    });
    assert.throws(() => wireResourceContent({ blob: '***' }, 'notes://1'), InvalidContentError);
    assert.throws(() => wireResourceContent({}, 'notes://1'), InvalidContentError);
  });

  it('gives a body for the read URI the declared MIME type unless it names its own', () => {
    assert.deepEqual(wireResourceContent({ text: 'x' }, 'notes://1', 'text/markdown'), {
      uri: 'notes://1',
      mimeType: 'text/markdown',
      text: 'x',
    });
    assert.deepEqual(
      wireResourceContent({ text: 'x', mimeType: 'text/plain' }, 'notes://1', 'text/markdown'),
      { uri: 'notes://1', mimeType: 'text/plain', text: 'x' },
    );
    assert.deepEqual(
      wireResourceContent({ uri: 'notes://2', text: 'x' }, 'notes://1', 'text/markdown'),
      { uri: 'notes://2', text: 'x' },
    );
  });
});

describe('strictJson', () => {
  it('serializes JSON and rejects what JSON cannot carry', () => {
    assert.equal(
      strictJson({ a: [1, 'b', null, { c: true }], skip: undefined }),
      '{"a":[1,"b",null,{"c":true}]}',
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [Number.NaN, Infinity, 1n, () => 1, new Date(), cyclic, undefined]) {
      assert.throws(() => strictJson(value), InvalidContentError);
    }
    const shared = { x: 1 };
    assert.equal(strictJson([shared, shared]), '[{"x":1},{"x":1}]');
  });

  it('measures UTF-8 bytes', () => {
    assert.equal(jsonByteLength('é'), 4);
  });
});
