/** Tests for `parseFrontmatter` and `serializeError`. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { serializeError } from '../../src/errors/serialize.js';
import { FrontmatterErrors, parseFrontmatter } from '../../src/support/frontmatter.server.js';

describe('parseFrontmatter', () => {
  it('parses YAML frontmatter into data + content', () => {
    const doc = ['---', 'title: Hello', 'tags:', '  - a', '  - b', '---', '# Body', 'text'].join(
      '\n',
    );
    const { data, content } = parseFrontmatter<{ title: string; tags: string[] }>(doc);
    assert.equal(data.title, 'Hello');
    assert.deepEqual(data.tags, ['a', 'b']);
    assert.match(content, /# Body/);
    assert.equal(content.includes('title: Hello'), false);
  });

  it('returns empty data when there is no frontmatter block', () => {
    const { data, content } = parseFrontmatter('Just body text');
    assert.deepEqual(data, {});
    assert.match(content, /Just body text/);
  });

  it('throws frontmatter.expected_string value-free for a non-string input', () => {
    assert.throws(
      () => parseFrontmatter(42 as unknown as string),
      (error: unknown) => {
        assert.ok(FrontmatterErrors.is(error));
        assert.equal(error.code, 'frontmatter.expected_string');
        return true;
      },
    );
  });

  it('wraps a malformed document as frontmatter.malformed', () => {
    // An unterminated YAML flow sequence inside frontmatter makes the YAML parser throw.
    const doc = '---\ntitle: [unterminated\n---\nbody';
    assert.throws(
      () => parseFrontmatter(doc),
      (error: unknown) => {
        assert.ok(FrontmatterErrors.is(error));
        assert.equal(error.code, 'frontmatter.malformed');
        return true;
      },
    );
  });
});

describe('parseFrontmatter delimiters', () => {
  it('does not end the block at a value ending in an ellipsis or dashes', () => {
    const doc = [
      '---',
      'title: Hello',
      'summary: To be continued...',
      'sep: a ---',
      'draft: true',
      '---',
      'Body',
    ].join('\n');
    const { data, content } = parseFrontmatter<Record<string, unknown>>(doc);
    assert.equal(data.summary, 'To be continued...');
    assert.equal(data.sep, 'a ---');
    assert.equal(data.draft, true);
    assert.equal(content, 'Body');
  });

  it('parses an empty block and a `...` terminator', () => {
    assert.deepEqual(parseFrontmatter('---\n---\nBody'), { data: {}, content: 'Body' });
    assert.deepEqual(parseFrontmatter('---\r\na: 1\r\n...\r\nBody'), {
      data: { a: 1 },
      content: 'Body',
    });
  });
});

describe('serializeError', () => {
  it('serializes an Error into a plain JSON-safe object', () => {
    const result = serializeError(new Error('boom'));
    assert.equal(result.message, 'boom');
    assert.equal(result.name, 'Error');
    // JSON-safe: it round-trips.
    assert.doesNotThrow(() => JSON.stringify(result));
  });

  it('serializes a non-Error value without throwing', () => {
    const result = serializeError('a string');
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.equal(typeof result, 'object');
  });

  it('captures a custom error code property', () => {
    const error = Object.assign(new Error('x'), { code: 'custom_code' });
    assert.equal(serializeError(error).code, 'custom_code');
  });
});
