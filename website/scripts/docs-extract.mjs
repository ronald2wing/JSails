/**
 * The docs extractor: turns Markdown (docs pages, `core/AGENTS.md`, rendered
 * starter guides) into the code fences and marked code references that
 * `check-docs.mjs` compiles and resolves. Pure text in, plain data out; no
 * filesystem access.
 *
 * A fence is compiled when its language is `ts`, `tsx`, or `js`. Words after
 * the language are its attributes:
 *
 *   ```ts                      a whole module (the default)
 *   ```ts fragment             compiled with `website/content/docs/_fixtures.d.ts`
 *                              in scope, for samples that assume an app around them
 *   ```ts run                  also executed under `node --test`; must assert and
 *                              be a whole module (not a fragment)
 *   ```ts no-check reason="…"  not compiled; the reason is required and the
 *                              number of such fences is budgeted
 *
 * A marked code reference is an inline-code token of the form
 * `<package entry>#<export>` (for example `jsails/database#ApplicationRecord`,
 * optionally followed by `()`), which the gate resolves against the API report.
 * Unmarked inline code is prose and is never scanned.
 *
 * Every fence and reference carries a stable anchor: the slug of the nearest
 * heading above it plus, for fences, its ordinal among the compiled fences
 * under that heading. Ledger ids are built from anchors, not line numbers, so
 * an edit elsewhere on a page does not re-key them.
 */

/** Fence languages the gate compiles, with the file extension each becomes. */
export const COMPILED_LANGUAGES = Object.freeze({ ts: '.ts', tsx: '.tsx', js: '.js' });

/** Attribute words a compiled fence may carry. */
const FLAGS = new Set(['fragment', 'run', 'no-check']);

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)(.*)$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const MARKER = /^((?:@jsails\/[a-z0-9-]+|jsails)(?:\/[a-z0-9-]+)*)#([A-Za-z_$][\w$]*)(?:\(\))?$/;

/**
 * Parses the attributes after a fence's language. Returns `{ flags, reason,
 * problems }`; a problem is an unknown word, a malformed attribute, or a
 * `reason` without `no-check` (or the reverse), or a combination that cannot
 * work (`no-check` with anything, `run` with `fragment`).
 */
export function parseFenceAttributes(text) {
  const flags = new Set();
  const problems = [];
  let reason;
  for (const [, key, value, word] of text.matchAll(/([a-z-]+)="([^"]*)"|(\S+)/g)) {
    if (key === 'reason') {
      reason = value.trim();
    } else if (key !== undefined) {
      problems.push(`unknown fence attribute "${key}"`);
    } else if (FLAGS.has(word)) {
      if (flags.has(word)) problems.push(`repeated fence attribute "${word}"`);
      flags.add(word);
    } else {
      problems.push(`unknown fence attribute "${word}"`);
    }
  }
  if (flags.has('no-check')) {
    if (reason === undefined || reason === '') {
      problems.push('a no-check fence needs reason="<why it cannot compile>"');
    }
    if (flags.size > 1) problems.push('no-check cannot be combined with fragment or run');
  } else if (reason !== undefined) {
    problems.push('reason="…" belongs to no-check fences only');
  }
  // Fixtures are type-only `declare global` stubs: a fragment that runs would
  // reach them as values that do not exist.
  if (flags.has('run') && flags.has('fragment')) {
    problems.push('run cannot be combined with fragment: a run fence must be a whole module');
  }
  return { flags, reason, problems };
}

/**
 * GitHub-style heading slug: lowercase, inline-code backticks and punctuation
 * dropped, whitespace to `-`.
 */
export function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** The front matter's line count (`---` … `---` at the top), or 0. */
function frontMatterLines(lines) {
  if (lines[0]?.trim() !== '---') return 0;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') return index + 1;
  }
  return 0;
}

/** Inline-code tokens on one line of prose, with their column (0-based). */
function inlineCode(line) {
  const tokens = [];
  const pattern = /(`+)([^`]|[^`].*?[^`])\1(?!`)/g;
  for (const match of line.matchAll(pattern)) {
    tokens.push({ text: match[2].trim(), column: match.index + match[1].length });
  }
  return tokens;
}

/**
 * Extracts the compiled fences and the marked code references of one Markdown
 * document. `source` is the repo-relative path findings are reported against;
 * `lineOffset` shifts every line (1-based) when the document is part of a file.
 *
 * Returns `{ fences, markers, problems }`:
 * - fence: `{ source, line, language, extension, body, flags, reason, anchor,
 *   ordinal }`, where `line` is the line of the opening fence and the body's
 *   first line is `line + 1`;
 * - marker: `{ source, line, column, token, specifier, name, anchor }`;
 * - problem: `{ source, line, anchor, message }` for a fence whose attributes
 *   are invalid or that is never closed.
 */
export function extractDocument(text, { source, lineOffset = 0 }) {
  const lines = text.split(/\r?\n/);
  const fences = [];
  const markers = [];
  const problems = [];
  const slugCounts = new Map();
  const ordinals = new Map();
  let anchor = '';
  let index = frontMatterLines(lines);

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1 + lineOffset;
    const open = FENCE_OPEN.exec(line);
    if (open !== null) {
      const [, indent, marker, language, attributes] = open;
      const close = new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      const body = [];
      let end = index + 1;
      while (end < lines.length && !close.test(lines[end] ?? '')) {
        const bodyLine = lines[end] ?? '';
        body.push(
          bodyLine.startsWith(indent) ? bodyLine.slice(indent.length) : bodyLine.trimStart(),
        );
        end += 1;
      }
      const extension = COMPILED_LANGUAGES[language.toLowerCase()];
      if (end >= lines.length) {
        problems.push({ source, line: lineNumber, anchor, message: 'code fence is never closed' });
      } else if (extension !== undefined) {
        const parsed = parseFenceAttributes(attributes);
        const ordinal = (ordinals.get(anchor) ?? 0) + 1;
        ordinals.set(anchor, ordinal);
        for (const message of parsed.problems) {
          problems.push({ source, line: lineNumber, anchor: `${anchor}[${ordinal}]`, message });
        }
        if (parsed.problems.length === 0) {
          fences.push({
            source,
            line: lineNumber,
            language: language.toLowerCase(),
            extension,
            body: body.join('\n'),
            flags: parsed.flags,
            reason: parsed.reason,
            anchor,
            ordinal,
          });
        }
      }
      index = end + 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const base = slugify(heading[2]);
      const seen = slugCounts.get(base) ?? 0;
      slugCounts.set(base, seen + 1);
      anchor = seen === 0 ? base : `${base}-${seen}`;
    }
    for (const token of inlineCode(line)) {
      const match = MARKER.exec(token.text);
      if (match === null) continue;
      markers.push({
        source,
        line: lineNumber,
        column: token.column + 1,
        token: token.text,
        specifier: match[1],
        name: match[2],
        anchor,
      });
    }
    index += 1;
  }
  return { fences, markers, problems };
}

/** The `<source>#<anchor>[<ordinal>]` key that names one fence in ledger ids. */
export function fenceKey(fence) {
  return `${fence.source}#${fence.anchor}[${fence.ordinal}]`;
}
