/**
 * The segment model of the `.jsails` compiler: the generated shadow TSX as a
 * list of segments, each saying where its text came from.
 *
 * Three kinds of mapped segment exist, numbered as TypeScript 7.1's
 * `SpanMapKind` numbers them so a span table is a content-mapper reply
 * without translation (`docs/design/sfc.md` §2, §6.3):
 *
 * - **Verbatim**: the text is a slice of a source, byte for byte. A position
 *   inside maps to the same distance into the slice.
 * - **Alias**: generated text that stands for a source name: the property
 *   name after `__props.` or `__state.` (mapped to the name's first use), and
 *   every lowered attribute name (mapped to the name in the source
 *   attribute). TypeScript reports a missing property and a wrong JSX
 *   attribute at the name, so the name is what must map (§3.3 rules 1 and 2).
 * - **Atom**: generated code owned by a source range, the template node that
 *   produced it. Every position inside maps to the start of the owner, so a
 *   cascade diagnostic in a `js-for` callback lands on the `<li js-for>` tag
 *   (§3.3 rule 3, §6.3 item 1). A generated declaration a caller can reach
 *   (the component function's name) is an Atom too, with navigation features
 *   (§6.3 item 2).
 *
 * A shadow is assembled from three parts: an unmapped header (generated
 * imports), a body of mapped segments only, and an unmapped footer (the
 * client's HMR accept). The type makes the rule of §9
 * correction 4 structural: inside the body nothing can be unmapped, so a
 * diagnostic with no source position is by construction one in the header or
 * footer, which the remapper reports as `sfc_internal`.
 *
 * From one shadow the compiler derives its text, the span table
 * ({@link Shadow.spans}), TypeScript's `SpanMapping[]` ({@link spanMappings})
 * and, in `column-map.ts`, the version 3 source maps; {@link editShadow}
 * replaces generated ranges of an assembled shadow without losing a mapping
 * (`compile.ts` rewrites `.jsails` import specifiers with it). Offsets are
 * UTF-16 code units throughout (`source-span.ts`).
 */

import { SegmentMapError } from './segments-error.js';
import { sourceSpan, type SourceSpan } from './source-span.js';

/** Mapped segment kinds, with TypeScript 7.1's `SpanMapKind` values. */
export const SpanKind: { readonly Verbatim: 0; readonly Atom: 1; readonly Alias: 2 } =
  Object.freeze({ Verbatim: 0, Atom: 1, Alias: 2 });

/** One of the {@link SpanKind} values. */
export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

/** The name of a {@link SpanFeature} bit, or `None` and `All`. */
export type SpanFeatureName =
  | 'None'
  | 'Hover'
  | 'SignatureHelp'
  | 'Completion'
  | 'Definition'
  | 'TypeDefinition'
  | 'Implementation'
  | 'References'
  | 'DocumentHighlights'
  | 'Rename'
  | 'CallHierarchy'
  | 'CodeActions'
  | 'Formatting'
  | 'InlayHints'
  | 'SemanticTokens'
  | 'FoldingRanges'
  | 'SelectionRanges'
  | 'LinkedEditing'
  | 'AutoInsert'
  | 'DocumentSymbols'
  | 'CodeLens'
  | 'All';

/**
 * Language-service features a span takes part in, with TypeScript 7.1's
 * `SpanMapFeature` bit values. Diagnostics are not a feature: TypeScript maps
 * them through every span whatever its bits.
 */
export const SpanFeature: Readonly<Record<SpanFeatureName, number>> = Object.freeze({
  None: 0,
  Hover: 1 << 0,
  SignatureHelp: 1 << 1,
  Completion: 1 << 2,
  Definition: 1 << 3,
  TypeDefinition: 1 << 4,
  Implementation: 1 << 5,
  References: 1 << 6,
  DocumentHighlights: 1 << 7,
  Rename: 1 << 8,
  CallHierarchy: 1 << 9,
  CodeActions: 1 << 10,
  Formatting: 1 << 11,
  InlayHints: 1 << 12,
  SemanticTokens: 1 << 13,
  FoldingRanges: 1 << 14,
  SelectionRanges: 1 << 15,
  LinkedEditing: 1 << 16,
  AutoInsert: 1 << 17,
  DocumentSymbols: 1 << 18,
  CodeLens: 1 << 19,
  All: (1 << 20) - 1,
});

/**
 * The features of a Verbatim segment by default: everything except
 * formatting, because `.jsails` files are formatted by Prettier, and a
 * TypeScript format edit computed on the shadow's indentation would be wrong
 * in the source.
 */
export const VERBATIM_FEATURES: number = SpanFeature.All & ~SpanFeature.Formatting;

/**
 * The features of an Alias by default: the semantic ones that follow a name.
 * Completion, inlay hints and edit-shaped features stay off, because the
 * same source name is also covered by the Verbatim use it aliases, which
 * already carries them; doubling them would show every hint twice.
 */
export const ALIAS_FEATURES: number =
  SpanFeature.Hover |
  SpanFeature.Definition |
  SpanFeature.TypeDefinition |
  SpanFeature.Implementation |
  SpanFeature.References |
  SpanFeature.DocumentHighlights |
  SpanFeature.Rename |
  SpanFeature.CallHierarchy;

/**
 * The features of an Atom by default: none. A gap chunk exists so that a
 * diagnostic lands on its owner; it must not answer a hover or completion
 * request at the owner's position. A generated declaration passes its
 * navigation features explicitly.
 */
export const ATOM_FEATURES: number = SpanFeature.None;

/** A source text a segment points into, named by its POSIX relative path. */
export interface SegmentSource {
  /** The source's path as a source map's `sources` entry: POSIX, relative. */
  readonly name: string;
  readonly text: string;
}

/** A generated chunk and the source range it maps to. */
export interface MappedSegment {
  readonly text: string;
  readonly kind: SpanKind;
  readonly source: SegmentSource;
  /** The original range: the slice (Verbatim), the name (Alias), the owner (Atom). */
  readonly span: SourceSpan;
  /** A {@link SpanFeature} bit set. */
  readonly features: number;
}

/** The three parts a shadow is assembled from; see the module comment. */
export interface ShadowParts {
  /** Unmapped generated text before the body (imports of framework helpers). */
  readonly header: string;
  /** The mapped body: the `<script>` copy, the component function and its wrapper. */
  readonly body: readonly MappedSegment[];
  /** Unmapped generated text after the body (a dev build's HMR accept). */
  readonly footer: string;
}

/**
 * One entry of a span table: a half-open generated range and the original
 * range it maps to, in one of {@link Shadow.sources}.
 */
export interface Span {
  readonly generatedStart: number;
  readonly generatedEnd: number;
  readonly kind: SpanKind;
  /** An index into {@link Shadow.sources}. */
  readonly source: number;
  readonly originalStart: number;
  readonly originalEnd: number;
  readonly features: number;
}

/** An assembled shadow: its text, where the body lies, and its span table. */
export interface Shadow {
  readonly text: string;
  /** The generated offset where the body starts (the header's length). */
  readonly bodyStart: number;
  /** The generated offset where the body ends and the footer starts. */
  readonly bodyEnd: number;
  /** Every source a span points into, in order of first use. */
  readonly sources: readonly SegmentSource[];
  /**
   * The span table: sorted, non-overlapping, covering `[bodyStart, bodyEnd)`
   * without a gap. Adjacent Verbatim segments with contiguous originals, and
   * adjacent Atoms with one owner, are merged when their features agree.
   */
  readonly spans: readonly Span[];
}

/**
 * TypeScript 7.1's `SpanMapping` tuple, the content-mapper `transform` reply
 * and the sidecar span-table row.
 */
export type SpanMapping = readonly [
  generatedStart: number,
  generatedLength: number,
  originalStart: number,
  originalLength: number,
  kind: SpanKind,
  features: number,
];

function invalid(message: string, context?: Readonly<Record<string, number>>): SegmentMapError {
  return new SegmentMapError('invalid_segment', message, context);
}

/**
 * Whether `name` is a normalized POSIX path relative to the project root:
 * non-empty segments separated by `/`, none of them `.` or `..`, and no `\`,
 * `:` or NUL anywhere. One file then has exactly one name, so a shadow's
 * `sources` and span table are the same bytes on every platform and from
 * every caller; a drive letter, a URL scheme and a Windows separator are all
 * refused rather than read differently by different map consumers.
 */
export function isProjectRelativeName(name: string): boolean {
  return name
    .split('/')
    .every(
      (segment) =>
        segment !== '' && segment !== '.' && segment !== '..' && !/[\\:\0]/.test(segment),
    );
}

/**
 * A frozen {@link SegmentSource}. The name must be a normalized POSIX path
 * relative to the project root (`pages/post.jsails`).
 */
export function segmentSource(name: string, text: string): SegmentSource {
  if (!isProjectRelativeName(name)) {
    throw invalid('a segment source is named by a normalized POSIX relative path');
  }
  return Object.freeze({ name, text });
}

function checkFeatures(features: number): number {
  if (!Number.isInteger(features) || (features & ~SpanFeature.All) !== 0 || features < 0) {
    throw invalid('segment features are SpanFeature bits');
  }
  return features;
}

function checkSpan(source: SegmentSource, span: SourceSpan): SourceSpan {
  const { start, end } = span;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw invalid('a segment span is [start, end) with 0 <= start <= end');
  }
  if (end > source.text.length) {
    throw invalid('a segment span lies outside its source', { end, length: source.text.length });
  }
  if (start === end) {
    throw invalid('a mapped segment covers at least one source code unit', { start });
  }
  return sourceSpan(start, end);
}

function mapped(
  text: string,
  kind: SpanKind,
  source: SegmentSource,
  span: SourceSpan,
  features: number,
): MappedSegment {
  if (text === '') {
    throw invalid('a mapped segment has generated text');
  }
  return Object.freeze({ text, kind, source, span, features: checkFeatures(features) });
}

/** A Verbatim segment: the source slice `span`, copied byte for byte. */
export function verbatim(
  source: SegmentSource,
  span: SourceSpan,
  features: number = VERBATIM_FEATURES,
): MappedSegment {
  const checked = checkSpan(source, span);
  return mapped(
    source.text.slice(checked.start, checked.end),
    SpanKind.Verbatim,
    source,
    checked,
    features,
  );
}

/**
 * An Alias segment: generated `text` that stands for the source name at
 * `name` (the property after `__props.`, a lowered attribute name).
 */
export function alias(
  text: string,
  source: SegmentSource,
  name: SourceSpan,
  features: number = ALIAS_FEATURES,
): MappedSegment {
  return mapped(text, SpanKind.Alias, source, checkSpan(source, name), features);
}

/** An Atom segment: generated `text` owned by the source range `owner`. */
export function atom(
  text: string,
  source: SegmentSource,
  owner: SourceSpan,
  features: number = ATOM_FEATURES,
): MappedSegment {
  return mapped(text, SpanKind.Atom, source, checkSpan(source, owner), features);
}

const KINDS: ReadonlySet<number> = new Set(Object.values(SpanKind));

/**
 * Check a segment again at assembly, because a `MappedSegment` is a plain
 * interface and need not come from {@link verbatim}, {@link alias} or
 * {@link atom}: the constructors' rules, plus a Verbatim text equal to its
 * source slice.
 */
function checkSegment(segment: MappedSegment): void {
  if (segment.text === '') {
    throw invalid('a mapped segment has generated text');
  }
  if (!KINDS.has(segment.kind)) {
    throw invalid('a segment kind is a SpanKind value');
  }
  checkSpan(segment.source, segment.span);
  checkFeatures(segment.features);
  if (
    segment.kind === SpanKind.Verbatim &&
    segment.text !== segment.source.text.slice(segment.span.start, segment.span.end)
  ) {
    throw invalid('a Verbatim segment equals its source slice', { start: segment.span.start });
  }
}

function mergeable(previous: Span, next: Span): boolean {
  if (
    previous.kind !== next.kind ||
    previous.source !== next.source ||
    previous.features !== next.features ||
    previous.generatedEnd !== next.generatedStart
  ) {
    return false;
  }
  if (next.kind === SpanKind.Verbatim) {
    return previous.originalEnd === next.originalStart;
  }
  if (next.kind === SpanKind.Atom) {
    return (
      previous.originalStart === next.originalStart && previous.originalEnd === next.originalEnd
    );
  }
  return false;
}

/** Assemble a shadow from its parts; see {@link Shadow}. */
export function assembleShadow(parts: ShadowParts): Shadow {
  const sources: SegmentSource[] = [];
  const sourceIndex = new Map<SegmentSource, number>();
  const sourceNames = new Set<string>();
  const spans: Span[] = [];
  const chunks: string[] = [parts.header];
  let offset = parts.header.length;
  const bodyStart = offset;

  for (const segment of parts.body) {
    checkSegment(segment);
    let index = sourceIndex.get(segment.source);
    if (index === undefined) {
      if (sourceNames.has(segment.source.name)) {
        throw invalid('two segment sources share one name');
      }
      index = sources.length;
      sources.push(segment.source);
      sourceIndex.set(segment.source, index);
      sourceNames.add(segment.source.name);
    }
    const span: Span = {
      generatedStart: offset,
      generatedEnd: offset + segment.text.length,
      kind: segment.kind,
      source: index,
      originalStart: segment.span.start,
      originalEnd: segment.span.end,
      features: segment.features,
    };
    const previous = spans.at(-1);
    if (previous !== undefined && mergeable(previous, span)) {
      spans[spans.length - 1] = {
        ...previous,
        generatedEnd: span.generatedEnd,
        originalEnd: span.originalEnd,
      };
    } else {
      spans.push(span);
    }
    chunks.push(segment.text);
    offset = span.generatedEnd;
  }
  const bodyEnd = offset;
  chunks.push(parts.footer);

  return Object.freeze({
    text: chunks.join(''),
    bodyStart,
    bodyEnd,
    sources: Object.freeze(sources),
    spans: Object.freeze(spans.map((span) => Object.freeze(span))),
  });
}

/** The index of the span containing generated `offset`, or -1. */
export function spanIndexAt(shadow: Shadow, offset: number): number {
  const { spans } = shadow;
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const span = spans[mid] as Span;
    if (offset < span.generatedStart) {
      high = mid - 1;
    } else if (offset >= span.generatedEnd) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

/**
 * How a generated position maps back, with TypeScript 7.1's `SpanMapFidelity`
 * meanings: `exact` through a Verbatim span, `atom` to the start of an Alias
 * or Atom original, `approximate` for a range crossing spans, `none` for a
 * position in the header or footer.
 */
export type MapFidelity = 'exact' | 'atom' | 'approximate' | 'none';

/** A generated position or range mapped back to one source. */
export type OriginalLocation =
  | {
      readonly fidelity: 'exact' | 'atom' | 'approximate';
      /** An index into {@link Shadow.sources}. */
      readonly source: number;
      readonly start: number;
      readonly end: number;
      /** The kind of the span the start lies in. */
      readonly kind: SpanKind;
    }
  | { readonly fidelity: 'none' };

const NONE: OriginalLocation = Object.freeze({ fidelity: 'none' });

/**
 * Map generated `offset` back to its source. A Verbatim span maps it to the
 * same distance into the original; an Alias or Atom to the original's start
 * (with `end` its end, so a remapper can underline the whole owner).
 *
 * Spans are half-open, so `bodyEnd` itself is the footer's first position and
 * maps to `none`. TypeScript's `SpanMap` counts the end of its last segment
 * as inside it; JSails does not, because the footer's first token starts
 * exactly there and must never be attributed to the template.
 */
export function generatedToOriginal(shadow: Shadow, offset: number): OriginalLocation {
  const span = shadow.spans[spanIndexAt(shadow, offset)];
  if (span === undefined) {
    return NONE;
  }
  if (span.kind === SpanKind.Verbatim) {
    const position = Math.min(span.originalStart + offset - span.generatedStart, span.originalEnd);
    return Object.freeze({
      fidelity: 'exact',
      source: span.source,
      start: position,
      end: position,
      kind: span.kind,
    });
  }
  return Object.freeze({
    fidelity: 'atom',
    source: span.source,
    start: span.originalStart,
    end: span.originalEnd,
    kind: span.kind,
  });
}

/**
 * Map the generated range `[start, end)` back. Inside one Verbatim span it
 * maps exactly; inside one Alias or Atom span to that span's original; across
 * spans of one source to the original from the start's mapping to the end's
 * (`approximate`); and to `none` when either end lies outside the body or
 * the ends fall in different sources.
 */
export function generatedRangeToOriginal(
  shadow: Shadow,
  start: number,
  end: number,
): OriginalLocation {
  const last = Math.max(end, start);
  if (last === start) {
    return generatedToOriginal(shadow, start);
  }
  const first = spanIndexAt(shadow, start);
  const final = spanIndexAt(shadow, last - 1);
  const head = shadow.spans[first];
  const tail = shadow.spans[final];
  if (head === undefined || tail === undefined || head.source !== tail.source) {
    return NONE;
  }
  if (first === final) {
    if (head.kind === SpanKind.Verbatim) {
      return Object.freeze({
        fidelity: 'exact',
        source: head.source,
        start: head.originalStart + start - head.generatedStart,
        end: head.originalStart + last - head.generatedStart,
        kind: head.kind,
      });
    }
    return Object.freeze({
      fidelity: 'atom',
      source: head.source,
      start: head.originalStart,
      end: head.originalEnd,
      kind: head.kind,
    });
  }
  const from =
    head.kind === SpanKind.Verbatim
      ? head.originalStart + start - head.generatedStart
      : head.originalStart;
  const to =
    tail.kind === SpanKind.Verbatim
      ? tail.originalStart + last - tail.generatedStart
      : tail.originalEnd;
  return Object.freeze({
    fidelity: 'approximate',
    source: head.source,
    start: Math.min(from, to),
    end: Math.max(from, to),
    kind: head.kind,
  });
}

/**
 * Whether the generated range `[start, end)` is source text an edit can be
 * applied to: non-empty and covered by Verbatim spans whose originals are
 * contiguous in one source. Typed lint applies a fix only when every edited
 * range passes (sfc-plan §3.6).
 */
export function isVerbatimRange(shadow: Shadow, start: number, end: number): boolean {
  if (end <= start) {
    return false;
  }
  let index = spanIndexAt(shadow, start);
  let cursor = start;
  let previous: Span | undefined;
  while (cursor < end) {
    const span = shadow.spans[index];
    if (span?.kind !== SpanKind.Verbatim) {
      return false;
    }
    if (
      previous !== undefined &&
      (previous.source !== span.source || previous.originalEnd !== span.originalStart)
    ) {
      return false;
    }
    previous = span;
    cursor = span.generatedEnd;
    index += 1;
  }
  return true;
}

/** One replacement in a shadow's text: the generated range `[start, end)` becomes `text`. */
export interface ShadowEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * Replace generated ranges of `shadow`, keeping its span table exact.
 *
 * An edit lies wholly in the header, wholly in the footer, or inside one body
 * span, and edits do not overlap. In the header or footer the text changes
 * and every later offset shifts. Inside a Verbatim span the replaced slice
 * becomes an Atom owned by the source range it was copied from, with the
 * Verbatim text on either side kept; inside an Alias or Atom span the span
 * keeps its kind and original and only its generated length changes. A body
 * edit replaces at least one code unit with at least one, so no generated
 * text is left unmapped and no span becomes empty.
 */
export function editShadow(shadow: Shadow, edits: readonly ShadowEdit[]): Shadow {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const length = shadow.text.length;
  let previousEnd = 0;
  for (const edit of sorted) {
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      edit.start < previousEnd ||
      edit.end < edit.start ||
      edit.end > length
    ) {
      throw invalid('shadow edits are ordered, non-overlapping ranges of the shadow text');
    }
    previousEnd = edit.end;
  }

  const inHeader = (edit: ShadowEdit): boolean => edit.end <= shadow.bodyStart;
  const inFooter = (edit: ShadowEdit): boolean => edit.start >= shadow.bodyEnd;
  const delta = (list: readonly ShadowEdit[]): number =>
    list.reduce((total, edit) => total + edit.text.length - (edit.end - edit.start), 0);

  const spanEdits = new Map<number, ShadowEdit[]>();
  for (const edit of sorted) {
    if (inHeader(edit) || inFooter(edit)) continue;
    const index = spanIndexAt(shadow, edit.start);
    if (
      edit.end === edit.start ||
      edit.text === '' ||
      index < 0 ||
      index !== spanIndexAt(shadow, edit.end - 1)
    ) {
      throw invalid('a body edit replaces a non-empty range inside one span with text', {
        start: edit.start,
      });
    }
    const list = spanEdits.get(index) ?? [];
    list.push(edit);
    spanEdits.set(index, list);
  }

  // An insertion where an empty body would be belongs to the header.
  const header = sorted.filter(inHeader);
  const footer = sorted.filter((edit) => !inHeader(edit) && inFooter(edit));
  const spans: Span[] = [];
  let offset = shadow.bodyStart + delta(header);
  const bodyStart = offset;
  shadow.spans.forEach((span, index) => {
    const own = spanEdits.get(index) ?? [];
    if (span.kind !== SpanKind.Verbatim) {
      const size = span.generatedEnd - span.generatedStart + delta(own);
      spans.push({ ...span, generatedStart: offset, generatedEnd: offset + size });
      offset += size;
      return;
    }
    let cursor = span.generatedStart;
    const verbatimTo = (end: number): void => {
      if (end > cursor) {
        const originalStart = span.originalStart + cursor - span.generatedStart;
        spans.push({
          ...span,
          generatedStart: offset,
          generatedEnd: offset + end - cursor,
          originalStart,
          originalEnd: originalStart + end - cursor,
        });
        offset += end - cursor;
      }
      cursor = end;
    };
    for (const edit of own) {
      verbatimTo(edit.start);
      const originalStart = span.originalStart + edit.start - span.generatedStart;
      spans.push({
        generatedStart: offset,
        generatedEnd: offset + edit.text.length,
        kind: SpanKind.Atom,
        source: span.source,
        originalStart,
        originalEnd: originalStart + edit.end - edit.start,
        features: ATOM_FEATURES,
      });
      offset += edit.text.length;
      cursor = edit.end;
    }
    verbatimTo(span.generatedEnd);
  });
  const bodyEnd = offset;

  let text = '';
  let cursor = 0;
  for (const edit of sorted) {
    text += shadow.text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  text += shadow.text.slice(cursor);
  if (text.length !== bodyEnd + (length - shadow.bodyEnd) + delta(footer)) {
    throw invalid('shadow edits changed the text and the span table differently');
  }

  return Object.freeze({
    text,
    bodyStart,
    bodyEnd,
    sources: shadow.sources,
    spans: Object.freeze(spans.map((span) => Object.freeze(span))),
  });
}

/**
 * The span table of `source` as TypeScript 7.1 `SpanMapping` tuples, in
 * generated order. Spans into other sources are left out: a content mapper
 * transforms one file, and its mappings address only that file.
 */
export function spanMappings(shadow: Shadow, source: SegmentSource): readonly SpanMapping[] {
  const index = shadow.sources.indexOf(source);
  if (index < 0) {
    return Object.freeze([]);
  }
  return Object.freeze(
    shadow.spans
      .filter((span) => span.source === index)
      .map((span) =>
        Object.freeze([
          span.generatedStart,
          span.generatedEnd - span.generatedStart,
          span.originalStart,
          span.originalEnd - span.originalStart,
          span.kind,
          span.features,
        ] as const),
      ),
  );
}
