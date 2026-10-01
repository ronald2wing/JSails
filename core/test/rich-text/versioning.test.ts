/**
 * The versioning gate of the rich-text model. The committed corpus under
 * `corpus/v<version>/` states the language a version accepts: every
 * `accept.jsonl` line is a document `parseRichText` returns unchanged, every
 * `reject.jsonl` line an input it refuses with the stated issue code, and
 * together they hold every case of the URL table. The SHA-256 of both files
 * and of the contract's JSON Schema are pinned in `RICH_TEXT_FINGERPRINT`, so
 * changing the schema or the corpus without bumping `RICH_TEXT_VERSION` (and
 * adding the next version's corpus) fails here.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RICH_TEXT_VERSION, parseRichText, richTextContract } from '../../src/rich-text/index.js';
import { RICH_TEXT_FINGERPRINT } from '../../src/rich-text/document.js';
import { URL_CASES } from './url-cases.js';

const CORPUS_DIR = fileURLToPath(
  new URL(`../../../test/rich-text/corpus/v${RICH_TEXT_VERSION}/`, import.meta.url),
);

const BUMP =
  'bump RICH_TEXT_VERSION, add the next corpus directory, and pin the new RICH_TEXT_FINGERPRINT';

interface AcceptLine {
  readonly case: string;
  readonly document: unknown;
}

interface RejectLine {
  readonly case: string;
  readonly code: string;
  readonly input: unknown;
}

function read(name: string): { readonly bytes: Buffer; readonly lines: unknown[] } {
  const bytes = readFileSync(`${CORPUS_DIR}${name}`);
  const lines = bytes
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown);
  return { bytes, lines };
}

const accept = read('accept.jsonl');
const reject = read('reject.jsonl');
const acceptLines = accept.lines as AcceptLine[];
const rejectLines = reject.lines as RejectLine[];

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** JSON with object keys sorted at every depth, so the hash ignores key order. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Every string anywhere in a JSON value. */
function strings(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) strings(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) strings(item, out);
  }
  return out;
}

describe(`rich-text corpus v${RICH_TEXT_VERSION}`, () => {
  it('names every case once', () => {
    const names = [...acceptLines, ...rejectLines].map((line) => line.case);
    assert.equal(new Set(names).size, names.length);
  });

  for (const line of acceptLines) {
    it(`accepts ${line.case}`, () => {
      const result = parseRichText(line.document);
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(result.value, line.document);
    });
  }

  for (const line of rejectLines) {
    it(`rejects ${line.case} with ${line.code}`, () => {
      const result = parseRichText(line.input);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.ok(
          result.issues.some((issue) => issue.code === line.code),
          `got ${result.issues.map((issue) => issue.code).join(', ')}`,
        );
      }
    });
  }

  it('holds every URL table case on the side the predicates put it', () => {
    const accepted = strings(acceptLines.map((line) => line.document));
    const refusedLinks = strings(
      rejectLines.filter((line) => line.code === 'invalid_link').map((line) => line.input),
    );
    const refusedEmbeds = strings(
      rejectLines.filter((line) => line.code === 'invalid_embed').map((line) => line.input),
    );
    const embedded = strings(
      acceptLines.map((line) =>
        (line.document as { blocks: { type: string; url?: string }[] }).blocks
          .filter((block) => block.type === 'embed')
          .map((block) => block.url),
      ),
    );
    for (const { value, link, embed } of URL_CASES) {
      const name = JSON.stringify(value.slice(0, 60));
      assert.ok(link ? accepted.has(value) : refusedLinks.has(value), `link case ${name}`);
      assert.ok(embed ? embedded.has(value) : refusedEmbeds.has(value), `embed case ${name}`);
    }
  });

  it('matches the pinned fingerprint', () => {
    assert.equal(RICH_TEXT_FINGERPRINT.version, RICH_TEXT_VERSION, BUMP);
    assert.equal(
      sha256(stableJson(richTextContract.jsonSchema)),
      RICH_TEXT_FINGERPRINT.schema,
      `the JSON Schema of version ${RICH_TEXT_VERSION} changed: ${BUMP}`,
    );
    assert.equal(
      sha256(accept.bytes),
      RICH_TEXT_FINGERPRINT.accept,
      `accept.jsonl of version ${RICH_TEXT_VERSION} changed: ${BUMP}`,
    );
    assert.equal(
      sha256(reject.bytes),
      RICH_TEXT_FINGERPRINT.reject,
      `reject.jsonl of version ${RICH_TEXT_VERSION} changed: ${BUMP}`,
    );
  });
});
