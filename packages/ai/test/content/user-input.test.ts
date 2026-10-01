/**
 * `parseUserInput` tests: the untrusted boundary accepts only text, image, and
 * file parts, drops cache flags, enforces limits, sniffs media, and refuses
 * URL sources unless allowed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AiError } from '../../src/errors/ai-error.js';
import { parseUserInput, type AiUserInputRejection } from '../../src/content/user-input.js';

const CANARY = 'CANARY-user-input';
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PDF = btoa('%PDF-1.7\n%âãÏÓ\n');
const JPEG = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 0x10));
const GIF = btoa('GIF89a\x01\x00\x01\x00');
const WEBP = btoa('RIFF\x00\x00\x00\x00WEBPVP8 ');

function rejects(value: unknown, reason: AiUserInputRejection, limits = {}): void {
  assert.throws(
    () => parseUserInput(value, limits),
    (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, 'invalid_input');
      assert.equal(error.context.reason, reason);
      assert.equal(error.message.includes(CANARY), false);
      return true;
    },
  );
}

describe('parseUserInput', () => {
  it('turns a string into a frozen user message', () => {
    const message = parseUserInput('hello');
    assert.deepEqual(message, { role: 'user', parts: [{ type: 'text', text: 'hello' }] });
    assert.ok(Object.isFrozen(message) && Object.isFrozen(message.parts));
  });

  it('accepts every allowed media type and drops cache flags and unknown fields', () => {
    const message = parseUserInput([
      { type: 'text', text: 'look', cache: true, role: 'system' },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: PNG } },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/jpeg', data: JPEG } },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/gif', data: GIF } },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/webp', data: WEBP } },
      {
        type: 'file',
        mediaType: 'application/pdf',
        title: 'doc',
        source: { kind: 'base64', mediaType: 'application/pdf', data: PDF },
      },
      {
        type: 'file',
        mediaType: 'text/plain',
        source: { kind: 'base64', mediaType: 'text/plain', data: btoa('plain') },
      },
    ]);
    assert.equal(message.parts.length, 7);
    assert.deepEqual(message.parts[0], { type: 'text', text: 'look' });
  });

  it('refuses every part a browser must not send', () => {
    for (const type of ['tool-result', 'tool-call', 'reasoning']) {
      rejects(
        [{ type, id: 'x', name: 'y', input: {}, output: 'z', isError: false, text: '' }],
        'part_type',
      );
    }
  });

  it('refuses malformed and empty input', () => {
    rejects(42, 'shape');
    rejects([], 'empty');
    rejects('   ', 'empty');
    rejects(['text'], 'shape');
  });

  it('enforces the part, text, and byte limits', () => {
    rejects(
      ['a', 'b', 'c'].map((text) => ({ type: 'text', text })),
      'too_many_parts',
      { maxParts: 2 },
    );
    rejects(
      [
        { type: 'text', text: 'abc' },
        { type: 'text', text: 'def' },
      ],
      'text_too_long',
      { maxTextChars: 5 },
    );
    rejects(
      [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: PNG } }],
      'media_too_large',
      { maxMediaBytes: 10 },
    );
  });

  it('rejects a payload whose bytes do not match its declared type', () => {
    rejects(
      [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: JPEG } }],
      'media_mismatch',
    );
    rejects(
      [
        {
          type: 'file',
          mediaType: 'application/pdf',
          source: { kind: 'base64', mediaType: 'application/pdf', data: PNG },
        },
      ],
      'media_mismatch',
    );
    rejects(
      [
        {
          type: 'file',
          mediaType: 'text/plain',
          source: { kind: 'base64', mediaType: 'text/plain', data: btoa('\xff\xfe\xfd') },
        },
      ],
      'media_mismatch',
    );
  });

  it('rejects media types outside the allowlist or that disagree with the part', () => {
    rejects(
      [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: PNG } }],
      'media_type',
      { mediaTypes: ['application/pdf'] },
    );
    rejects(
      [{ type: 'image', source: { kind: 'base64', mediaType: 'application/pdf', data: PDF } }],
      'media_type',
    );
    rejects(
      [
        {
          type: 'file',
          mediaType: 'text/plain',
          source: { kind: 'base64', mediaType: 'application/pdf', data: PDF },
        },
      ],
      'media_type',
    );
    rejects(
      [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: `${CANARY}==` } }],
      'media_source',
    );
  });

  it('refuses URL sources unless allowUrl admits them, and only over https', () => {
    const image = (url: string): unknown => [{ type: 'image', source: { kind: 'url', url } }];
    rejects(image('https://cdn.example.com/a.png'), 'url_not_allowed');
    rejects(image('https://evil.example.com/a.png'), 'url_not_allowed', {
      allowUrl: (url: URL) => url.hostname === 'cdn.example.com',
    });
    rejects(image('http://cdn.example.com/a.png'), 'media_source', { allowUrl: () => true });
    rejects(image('https://user:pw@cdn.example.com/a.png'), 'media_source', {
      allowUrl: () => true,
    });
    const message = parseUserInput(image('https://cdn.example.com/a.png'), {
      allowUrl: (url) => url.hostname === 'cdn.example.com',
    });
    assert.deepEqual(message.parts[0], {
      type: 'image',
      source: { kind: 'url', url: 'https://cdn.example.com/a.png' },
    });
  });

  it('rejects an invalid limit as an option error', () => {
    assert.throws(
      () => parseUserInput('x', { maxParts: -1 }),
      (error: unknown) => error instanceof AiError && error.code === 'invalid_options',
    );
  });
});
