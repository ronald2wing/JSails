/**
 * Server-only `parseFrontmatter`: YAML front matter split from a document body.
 */

import { parse as parseYaml } from 'yaml';

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

const FRONTMATTER_ERRORS = {
  expected_string: {
    kind: 'internal',
    message: 'parseFrontmatter: expected a string',
  },
  malformed: {
    kind: 'invalid',
    message: 'parseFrontmatter: malformed document',
  },
  expected_mapping: {
    kind: 'invalid',
    message: 'parseFrontmatter: expected a mapping',
  },
} as const;

/**
 * `parseFrontmatter`'s codes, `frontmatter.*`: a document whose front matter
 * does not parse to a mapping (`invalid`), and a non-string argument. None
 * echoes the document; a YAML error stays on the `cause`.
 *
 * @public
 */
export const FrontmatterErrors: ErrorRegistry<'frontmatter', typeof FRONTMATTER_ERRORS> =
  defineErrors('frontmatter', FRONTMATTER_ERRORS);

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
 * closing `---` or `...` line. The closing delimiter must start its own line,
 * so a value that merely ends in `...` or `---` never terminates the block;
 * the body group is optional so an empty block (`---\n---`) parses as `{}`.
 */
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * Parse a Markdown document's YAML frontmatter.
 *
 * Returns `{ data, content }` where `data` is the parsed frontmatter mapping
 * and `content` is the body with the frontmatter block removed. A document
 * without a frontmatter block yields `{ data: {}, content: input }`. Throws a
 * value-free `frontmatter.*` error on a non-string input, an unterminated block,
 * invalid YAML, or a non-mapping frontmatter value.
 */
export function parseFrontmatter<T = Record<string, unknown>>(input: string): FrontmatterResult<T> {
  if (typeof input !== 'string') {
    throw new FrontmatterErrors.Error('expected_string');
  }

  const source = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (!source.startsWith('---')) {
    return { data: {} as T, content: source };
  }

  const match = FRONTMATTER_RE.exec(source);
  if (match === null) {
    throw new FrontmatterErrors.Error('malformed');
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? '');
  } catch (error) {
    throw new FrontmatterErrors.Error('malformed', {}, { cause: error });
  }

  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FrontmatterErrors.Error('expected_mapping');
  }

  return { data: parsed as T, content: source.slice(match[0].length) };
}
