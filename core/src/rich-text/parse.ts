/**
 * {@link parseRichText}: the one reader of a rich-text document, for stored
 * rows and submitted values alike. It never repairs input; a value it refuses
 * comes back as value-free issues (a path and a code, never the offending
 * text or URL).
 */

import type { z } from 'zod';

import { firstNonCanonicalPath } from './canonical.js';
import {
  MAX_BLOCK_CHARS,
  MAX_BLOCKS,
  MAX_DOCUMENT_BYTES,
  MAX_LIST_ITEMS,
  RICH_TEXT_VERSION,
  richTextSchema,
  type RichTextCheckCode,
  type RichTextDocument,
} from './document.js';
import { measureRichText, utf8Length } from './measure.js';
import { mapZodIssues } from '../validation/zod-issues.js';

/**
 * One reason a value is not a readable document. `code` is one of
 * {@link RichTextIssueCode} or a Zod issue code (`invalid_type`, `too_big`,
 * `unknown_field`, ...); `message` is derived from the rule, never the input.
 *
 * @public
 */
export interface RichTextIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

/**
 * The issue codes rich text adds to Zod's.
 *
 * @public
 */
export type RichTextIssueCode =
  | 'invalid_text'
  | 'invalid_link'
  | 'invalid_embed'
  | 'unsupported_version'
  | 'too_large'
  | 'too_many_blocks'
  | 'block_too_long'
  | 'too_many_list_items'
  | 'not_canonical';

/**
 * The outcome of {@link parseRichText}.
 *
 * @public
 */
export type RichTextParseResult =
  | { readonly ok: true; readonly value: RichTextDocument }
  | { readonly ok: false; readonly issues: readonly RichTextIssue[] };

const CHECK_MESSAGES: Readonly<Record<RichTextCheckCode, string>> = {
  invalid_text: 'text contains a control character, a bidi control, or an unpaired surrogate',
  invalid_link: 'link is not a path, fragment, http(s), mailto or tel URL',
  invalid_embed: 'embed is not an https URL',
};

function issue(
  path: readonly (string | number)[],
  code: RichTextIssueCode | 'invalid_type',
  message: string,
): RichTextParseResult {
  return { ok: false, issues: [{ path, code, message }] };
}

function checkCode(raw: z.core.$ZodIssue): RichTextCheckCode | undefined {
  if (raw.code === 'custom') {
    const code = (raw.params as { richText?: unknown } | undefined)?.richText;
    return typeof code === 'string' && Object.hasOwn(CHECK_MESSAGES, code)
      ? (code as RichTextCheckCode)
      : undefined;
  }
  // Only the text rules use a pattern.
  return raw.code === 'invalid_format' && raw.format === 'regex' ? 'invalid_text' : undefined;
}

function schemaIssues(error: z.ZodError): RichTextIssue[] {
  return error.issues.flatMap((raw): RichTextIssue[] => {
    const code = checkCode(raw);
    if (code === undefined) {
      return mapZodIssues([raw]);
    }
    return [
      {
        path: raw.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
        code,
        message: CHECK_MESSAGES[code],
      },
    ];
  });
}

function jsonBytes(input: unknown): number | undefined {
  try {
    return utf8Length(JSON.stringify(input));
  } catch {
    // A cycle or a BigInt: not JSON, so not a document.
    return undefined;
  }
}

/**
 * Read a document: check its version, its size, the schema, the budget, and
 * that it is already canonical. Writers normalise with `normalizeRichText`
 * before storing, so a refused value means corrupt or foreign data, which
 * callers surface instead of coercing. A version 1 document is refused here;
 * `upgradeRichTextDocument` is the explicit, one-time path from it.
 *
 * @public
 */
export function parseRichText(input: unknown): RichTextParseResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return issue([], 'invalid_type', 'value is not a rich-text document');
  }
  const version = (input as { version?: unknown }).version;
  if (version !== RICH_TEXT_VERSION) {
    return issue(
      ['version'],
      'unsupported_version',
      version === 1
        ? 'version 1 documents must be upgraded with upgradeRichTextDocument'
        : `only version ${RICH_TEXT_VERSION} documents are readable`,
    );
  }
  // Size first, so an oversized value is refused before the schema walks it.
  const bytes = jsonBytes(input);
  if (bytes === undefined) {
    return issue([], 'invalid_type', 'value is not JSON');
  }
  if (bytes > MAX_DOCUMENT_BYTES) {
    return issue([], 'too_large', `document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  }
  const parsed = richTextSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: schemaIssues(parsed.error) };
  }
  const document: RichTextDocument = parsed.data;
  const measure = measureRichText(document);
  const issues: RichTextIssue[] = [];
  if (measure.blocks > MAX_BLOCKS) {
    issues.push({
      path: ['blocks'],
      code: 'too_many_blocks',
      message: `more than ${MAX_BLOCKS} blocks`,
    });
  }
  if (measure.maxBlockChars > MAX_BLOCK_CHARS) {
    issues.push({
      path: ['blocks'],
      code: 'block_too_long',
      message: `a block holds more than ${MAX_BLOCK_CHARS} characters`,
    });
  }
  if (measure.maxListItems > MAX_LIST_ITEMS) {
    issues.push({
      path: ['blocks'],
      code: 'too_many_list_items',
      message: `a list holds more than ${MAX_LIST_ITEMS} items`,
    });
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const path = firstNonCanonicalPath(document);
  if (path !== undefined) {
    return issue(path, 'not_canonical', 'block is not in canonical form; normalize before storing');
  }
  return { ok: true, value: document };
}
