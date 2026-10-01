/**
 * Tool serialization tests: verbatim strings, JSON with bigint and lossy-value
 * handling, code-point-safe truncation, and the media byte and image count
 * bounds on item lists.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AiToolOutputItem } from '../../src/content/types.js';
import {
  DEFAULT_MAX_TOOL_RESULT_IMAGES,
  DEFAULT_MAX_TOOL_RESULT_MEDIA_BYTES,
  TRUNCATION_MARKER,
  limitToolOutput,
  serializeToolValue,
  truncateText,
} from '../../src/tools/tool-serialization.js';

describe('serializeToolValue', () => {
  it('passes strings verbatim and serializes values as JSON', () => {
    assert.deepEqual(serializeToolValue('plain "text"'), { ok: true, text: 'plain "text"' });
    assert.deepEqual(serializeToolValue(undefined), { ok: true, text: '' });
    assert.deepEqual(serializeToolValue(null), { ok: true, text: 'null' });
    assert.deepEqual(serializeToolValue({ n: 1n, list: [1, 'a'] }), {
      ok: true,
      text: '{"n":"1","list":[1,"a"]}',
    });
  });

  it('refuses values JSON would mangle', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      cyclic,
      new Map(),
      new Set([1]),
      { f: () => 1 },
      { s: Symbol('x') },
      [Number.NaN],
      /re/,
      new Error('x'),
      Promise.resolve(1),
    ]) {
      assert.deepEqual(serializeToolValue(value), { ok: false });
    }
  });
});

describe('truncateText', () => {
  it('keeps text that fits and marks a cut', () => {
    assert.equal(truncateText('short', 10), 'short');
    const cut = truncateText('a'.repeat(100), 40);
    assert.equal(cut.length, 40);
    assert.ok(cut.endsWith(TRUNCATION_MARKER));
  });

  it('never splits a surrogate pair', () => {
    for (let max = TRUNCATION_MARKER.length + 1; max < TRUNCATION_MARKER.length + 12; max += 1) {
      const cut = truncateText('😀'.repeat(20), max);
      assert.ok(cut.length <= max);
      const body = cut.slice(0, cut.length - TRUNCATION_MARKER.length);
      assert.equal(body, '😀'.repeat(body.length / 2));
    }
    assert.equal(truncateText('😀😀', 3), '😀');
  });
});

describe('limitToolOutput', () => {
  it('shares the budget across text items and drops items after the cut', () => {
    const image = {
      type: 'image',
      source: { kind: 'url', url: 'https://example.com/a.png' },
    } as const;
    const output = limitToolOutput(
      [
        { type: 'text', text: 'a'.repeat(10) },
        image,
        { type: 'text', text: 'b'.repeat(100) },
        { type: 'text', text: 'c' },
      ],
      { maxChars: 40 },
    );
    assert.equal(output.length, 3);
    assert.deepEqual(output[1], image);
    const third = output[2];
    assert.ok(typeof third === 'object' && third.type === 'text' && third.text.length === 30);
    assert.deepEqual(limitToolOutput('abc', { maxChars: 10 }), 'abc');
  });

  /** A base64 image item that decodes to `bytes` bytes. */
  function png(bytes: number): AiToolOutputItem {
    return {
      type: 'image',
      source: { kind: 'base64', mediaType: 'image/png', data: 'A'.repeat((bytes / 3) * 4) },
    };
  }

  const marker = { type: 'text', text: TRUNCATION_MARKER.trimStart() };

  it('counts decoded image bytes and drops the image that crosses the budget', () => {
    const output = limitToolOutput(
      [png(300), { type: 'text', text: 'between' }, png(300), png(3), { type: 'text', text: 'x' }],
      { maxChars: 1_000, maxMediaBytes: 500 },
    );
    assert.deepEqual(output, [png(300), { type: 'text', text: 'between' }, marker]);
  });

  it('caps the number of images, URL images included', () => {
    const url: AiToolOutputItem = {
      type: 'image',
      source: { kind: 'url', url: 'https://example.com/a.png' },
    };
    assert.deepEqual(limitToolOutput([url, url, url], { maxChars: 10, maxImages: 2 }), [
      url,
      url,
      marker,
    ]);
  });

  it('applies the media defaults when only the text cap is given', () => {
    const many = Array.from({ length: DEFAULT_MAX_TOOL_RESULT_IMAGES + 5 }, () => png(3));
    const output = limitToolOutput(many, { maxChars: 10 });
    assert.equal(output.length, DEFAULT_MAX_TOOL_RESULT_IMAGES + 1);
    assert.deepEqual(output.at(-1), marker);
    const huge = limitToolOutput([png(DEFAULT_MAX_TOOL_RESULT_MEDIA_BYTES + 1)], { maxChars: 10 });
    assert.deepEqual(huge, [marker]);
  });
});
