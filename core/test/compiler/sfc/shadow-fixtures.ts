/**
 * Shadows for the segment and column-map tests: a seeded generator of shadow
 * parts, an oracle that maps a generated offset straight from the segment
 * list (independent of the span table it is compared with), and a hand-built
 * page shadow shaped like the lowering of `docs/design/sfc.md` §2's probe
 * fixture, valid TSX so oxc can compile it.
 */

import {
  alias,
  assembleShadow,
  atom,
  SpanFeature,
  segmentSource,
  SpanKind,
  verbatim,
  type MappedSegment,
  type SegmentSource,
  type Shadow,
  type ShadowParts,
} from '../../../src/compiler/sfc/segments.js';
import { sourceSpan, type SourceSpan } from '../../../src/compiler/sfc/source-span.js';
import type { SeededRandom } from '../../../src/testing/seeded-random.js';

/** Text pieces covering every line terminator, astral and non-ASCII code points, and tokens. */
const PIECES = [
  'a',
  'page',
  '_x1',
  '$',
  ' ',
  '  ',
  '\t',
  '\n',
  '\r\n',
  '\r',
  '\u2028',
  '\u2029',
  'é',
  '𝒳',
  '{{ ',
  ' }}',
  '<li js-for="t of ts">',
  '.',
  '(',
  ')',
  '=>',
  '`',
  '"',
] as const;

const NAMES = ['page', 'title', 'onClick', 'tag', 'count', 'é1'] as const;

/** Random text of `min` to `max` pieces. */
export function randomText(random: SeededRandom, min: number, max: number): string {
  let text = '';
  const count = random.int(min, max + 1);
  for (let index = 0; index < count; index += 1) {
    text += random.pick(PIECES);
  }
  return text;
}

function randomSpan(random: SeededRandom, source: SegmentSource, from?: number) {
  const length = source.text.length;
  const start = from !== undefined && from < length ? from : random.int(0, length);
  const end = random.int(start + 1, Math.min(length, start + 24) + 1);
  return sourceSpan(start, end);
}

/** Random shadow parts over one or two sources, exercising every merge rule. */
export function randomParts(random: SeededRandom): ShadowParts {
  const sources = [segmentSource('pages/post.jsails', randomText(random, 4, 60))];
  if (random.int(0, 3) === 0) {
    sources.push(segmentSource('pages/post/post.ts', randomText(random, 4, 30)));
  }
  const body: MappedSegment[] = [];
  const count = random.int(0, 24);
  for (let index = 0; index < count; index += 1) {
    const previous = body.at(-1);
    const continues = previous !== undefined && random.int(0, 3) === 0;
    const source = continues ? previous.source : random.pick(sources);
    const kind = continues ? previous.kind : random.pick(Object.values(SpanKind));
    if (kind === SpanKind.Verbatim) {
      // A continuation starts where the previous slice ended, so the two merge.
      body.push(
        verbatim(source, randomSpan(random, source, continues ? previous.span.end : undefined)),
      );
    } else if (kind === SpanKind.Alias) {
      body.push(alias(random.pick(NAMES), source, randomSpan(random, source)));
    } else {
      const owner = continues ? previous.span : randomSpan(random, source);
      body.push(atom(randomText(random, 1, 6), source, owner));
    }
  }
  return {
    header: random.int(0, 2) === 0 ? '' : randomText(random, 1, 8),
    body,
    footer: random.int(0, 2) === 0 ? '' : randomText(random, 1, 8),
  };
}

/** What the segment list itself says generated `offset` maps to. */
export type OracleLocation =
  { readonly source: SegmentSource; readonly offset: number; readonly kind: SpanKind } | undefined;

/** Map generated `offset` by walking the segment list. */
export function oracle(parts: ShadowParts, offset: number): OracleLocation {
  let cursor = parts.header.length;
  for (const segment of parts.body) {
    const end = cursor + segment.text.length;
    if (offset >= cursor && offset < end) {
      return {
        source: segment.source,
        offset:
          segment.kind === SpanKind.Verbatim
            ? segment.span.start + offset - cursor
            : segment.span.start,
        kind: segment.kind,
      };
    }
    cursor = end;
  }
  return undefined;
}

/** The probe page: a typo (`pgae`), a wrong prop type, a non-iterable `js-for`. */
export const PAGE_SOURCE = [
  '<script lang="ts">',
  "import { formatDate } from '../shared/format.js';",
  'const total = `first',
  'second\r\nthird`;',
  '</script>',
  '',
  '<template>',
  '  <main>',
  '    <h1>{{ pgae.title }}</h1>',
  '    <p>{{ formatDate(page.date) }} {{ total }}</p>',
  '    <Card :title="42" />',
  '    <ul><li js-for="tag of page.count">{{ tag }}</li></ul>',
  '  </main>',
  '</template>',
  '',
].join('\n');

/** The page's shadow header: generated imports, unmapped. */
export const PAGE_HEADER =
  "import type { ComponentChild } from 'jsails';\n" +
  "import { renderList } from 'jsails/view';\n" +
  "import { Card } from '../ui/card.js';\n";

/** The page's shadow footer: the style import, unmapped. */
export const PAGE_FOOTER = "import './post.css';\n";

/** The features of the generated component name, a declaration callers reach. */
export const DECLARATION_FEATURES: number =
  SpanFeature.Definition | SpanFeature.References | SpanFeature.Hover;

/** The span of the `nth` (0-based) occurrence of `needle` in the page source. */
export function pageSpan(needle: string, nth = 0): SourceSpan {
  let start = -1;
  for (let count = 0; count <= nth; count += 1) {
    start = PAGE_SOURCE.indexOf(needle, start + 1);
    if (start < 0) {
      throw new RangeError('needle not in page source');
    }
  }
  return sourceSpan(start, start + needle.length);
}

/** The span from the start of `open` to the end of the first `close` after it. */
function elementSpan(open: string, close: string): SourceSpan {
  const start = pageSpan(open).start;
  const end = PAGE_SOURCE.indexOf(close, start) + close.length;
  return sourceSpan(start, end);
}

/** The page source as a segment source. */
export const PAGE: SegmentSource = segmentSource('pages/post.jsails', PAGE_SOURCE);

/** The template nodes that own generated chunks. */
export const OWNERS = Object.freeze({
  template: elementSpan('<template>', '</template>'),
  templateTag: pageSpan('<template>'),
  main: elementSpan('<main>', '</main>'),
  h1: elementSpan('<h1>', '</h1>'),
  p: elementSpan('<p>', '</p>'),
  card: elementSpan('<Card', '/>'),
  ul: elementSpan('<ul>', '</ul>'),
  li: elementSpan('<li', '</li>'),
});

/** The page's shadow parts: what SFC-03's lowering of the probe page produces. */
export function pageParts(): ShadowParts {
  const scriptStart = pageSpan('<script lang="ts">').end;
  const scriptEnd = pageSpan('</script>').start;
  const t = OWNERS.template;
  const v = (needle: string, nth = 0): MappedSegment => verbatim(PAGE, pageSpan(needle, nth));
  const page = sourceSpan(pageSpan('page.date').start, pageSpan('page.date').start + 4);
  return {
    header: PAGE_HEADER,
    body: [
      verbatim(PAGE, sourceSpan(scriptStart, scriptEnd)),
      atom('export default function ', PAGE, t),
      atom('Post', PAGE, OWNERS.templateTag, DECLARATION_FEATURES),
      atom(
        '(__props: { page: { date: Date; count: number } }): ComponentChild {\n  const ',
        PAGE,
        t,
      ),
      alias('pgae', PAGE, pageSpan('pgae')),
      atom(' = __props.', PAGE, t),
      alias('pgae', PAGE, pageSpan('pgae')),
      atom(';\n  const ', PAGE, t),
      alias('page', PAGE, page),
      atom(' = __props.', PAGE, t),
      alias('page', PAGE, page),
      atom(';\n  return (\n    ', PAGE, t),
      atom('<main>\n      ', PAGE, OWNERS.main),
      atom('<h1>{', PAGE, OWNERS.h1),
      v('pgae.title'),
      atom('}</h1>\n      ', PAGE, OWNERS.h1),
      atom('<p>{', PAGE, OWNERS.p),
      v('formatDate(page.date)'),
      atom('} {', PAGE, OWNERS.p),
      v('total', 1),
      atom('}</p>\n      ', PAGE, OWNERS.p),
      atom('<Card ', PAGE, OWNERS.card),
      alias('title', PAGE, sourceSpan(pageSpan(':title').start + 1, pageSpan(':title').end)),
      atom('={', PAGE, OWNERS.card),
      v('42'),
      atom('} />\n      ', PAGE, OWNERS.card),
      atom('<ul>{renderList(', PAGE, OWNERS.ul),
      v('page.count'),
      atom(', (', PAGE, OWNERS.li),
      v('tag', 0),
      atom(') => <li>{', PAGE, OWNERS.li),
      v('tag', 1),
      atom('}</li>)}</ul>\n    ', PAGE, OWNERS.li),
      atom('</main>\n  );\n}\n', PAGE, t),
    ],
    footer: PAGE_FOOTER,
  };
}

/** The assembled page shadow. */
export function pageShadow(): Shadow {
  return assembleShadow(pageParts());
}
