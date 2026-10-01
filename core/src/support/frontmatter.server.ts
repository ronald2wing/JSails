/**
 * Server-only `parseFrontmatter` (YAML front matter split from a document body) and `serializeError` for log-safe error records.
 */

import { parse as parseYaml } from 'yaml';

import { JsailsError } from '../errors/jsails-error.js';

// ---------------------------------------------------------------------------
// Domain error
// ---------------------------------------------------------------------------

export type FrontmatterErrorCode = 'invalid_argument';

export class FrontmatterError extends JsailsError {
  readonly code: FrontmatterErrorCode;

  constructor(code: FrontmatterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FrontmatterResult<T = Record<string, unknown>> {
  readonly data: T;
  readonly content: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Frontmatter block: an opening `---` line, an optional YAML body, and a
 * closing `---` or `...` line. The body's final newline is optional so an
 * empty block (`---\n---`) parses as `{}`.
 */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * Parse a Markdown document's YAML frontmatter.
 *
 * Returns `{ data, content }` where `data` is the parsed frontmatter mapping
 * and `content` is the body with the frontmatter block removed. A document
 * without a frontmatter block yields `{ data: {}, content: input }`. Throws a
 * value-free `FrontmatterError` on a non-string input, an unterminated block,
 * invalid YAML, or a non-mapping frontmatter value.
 */
export function parseFrontmatter<T = Record<string, unknown>>(input: string): FrontmatterResult<T> {
  if (typeof input !== 'string') {
    throw new FrontmatterError('invalid_argument', 'parseFrontmatter: expected a string');
  }

  const source = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (!source.startsWith('---')) {
    return { data: {} as T, content: source };
  }

  const match = FRONTMATTER_RE.exec(source);
  if (match === null) {
    throw new FrontmatterError('invalid_argument', 'parseFrontmatter: malformed document');
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? '');
  } catch (error) {
    throw new FrontmatterError('invalid_argument', 'parseFrontmatter: malformed document', {
      cause: error,
    });
  }

  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FrontmatterError('invalid_argument', 'parseFrontmatter: expected a mapping');
  }

  return { data: parsed as T, content: source.slice(match[0].length) };
}
