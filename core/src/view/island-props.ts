/**
 * The props codec of islands, the one both sides use: the server encodes an
 * island's props into its `data-jsails-props` marker and renders the island
 * from the decoded copy (`island.ts`), and the browser runtime decodes the
 * same marker to hydrate it (`client/islands.ts`). One decoder means the
 * first paint and the hydrating render see the same values, and props the
 * browser would refuse fail the render on the server instead of shipping an
 * island that never hydrates.
 *
 * Decoding uses `JSON.parse` only, never `eval` or `Function`. The input is
 * bounded by length and the result by depth and total key count, and the
 * `__proto__`, `constructor` and `prototype` keys are refused at any depth,
 * so a hostile marker cannot pollute a prototype. Values are taken as they
 * are; only keys are guarded.
 *
 * Browser-safe: the error kernel and the JSON key guard only. The module also
 * holds the marker element's name, its two attribute names and its layout
 * rule, the island id rule (which the
 * compiler checks island paths against), and the `island` error registry the
 * errors of `defineIsland` and `<Island>`.
 */

import { defineErrors, type ErrorRegistry } from '../errors/registry.js';
import { FORBIDDEN_KEYS } from '../json/shape.js';

const ISLAND_ERRORS = {
  invalid_id: {
    kind: 'invalid',
    message: 'an island id is a non-empty path of letters, digits and . _ $ - /',
    suggestion: 'name the island after its file under islands/, as the compiler does',
  },
  redefined: {
    kind: 'conflict',
    message: 'the component is already an island under another id',
    suggestion: 'define each island once, under the id of its file',
  },
  not_defined: {
    kind: 'invalid',
    message: 'the component passed to <Island> is not a defined island',
    suggestion: 'wrap the component with defineIsland(id, component), or write it under islands/',
  },
  props_invalid: {
    kind: 'invalid',
    message: 'island props must be a plain object without __proto__, constructor or prototype keys',
  },
  props_unparseable: {
    kind: 'invalid',
    message: 'island props are not valid JSON',
  },
  props_too_large: {
    kind: 'too_large',
    message: 'island props exceed the length, depth or key bound',
    suggestion: 'pass less data as props, and let the island fetch the rest',
  },
  props_unserializable: {
    kind: 'invalid',
    message: 'island props cannot be serialized to JSON',
    suggestion: 'pass strings, numbers, booleans, null, arrays and plain objects only',
  },
} as const;

/**
 * The errors of islands, `island.*`: an invalid or conflicting id, a
 * component that is not a defined island, and props that cannot cross to the
 * browser as bounded JSON.
 *
 * @public
 */
export const IslandErrors: ErrorRegistry<'island', typeof ISLAND_ERRORS> = defineErrors(
  'island',
  ISLAND_ERRORS,
);

/** The attribute naming the island an element hydrates into. */
export const ISLAND_ATTRIBUTE = 'data-jsails-island';

/** The attribute holding an island's props, as bounded JSON. */
export const ISLAND_PROPS_ATTRIBUTE = 'data-jsails-props';

/** The marker element's tag name. */
export const ISLAND_ELEMENT = 'jsails-island';

/**
 * The rule that lays the island marker out with `display: contents`, so the
 * island's own root takes part in its parent's layout (a flex or grid item,
 * not the marker). It is a stylesheet rule, never a `style` attribute on the
 * marker, because a Content-Security-Policy with a nonce blocks every style
 * attribute. The stylesheet the compiler collects from `.jsails` styles
 * starts with it (`compiler/sfc/style-sheet.ts`); a layout without that
 * sheet includes it in its own stylesheet, or in a `<style>` with the
 * request's `cspNonce`.
 *
 * @public
 */
export const ISLAND_STYLE = 'jsails-island{display:contents}';

/** The longest island id, so a marker attribute stays small. */
const MAX_ISLAND_ID_LENGTH = 200;

/** An island id: path segments of letters, digits and `_ $ . -`, joined by `/`. */
const ISLAND_ID = /^[\w$.-]+(?:\/[\w$.-]+)*$/;

/**
 * Whether `id` is one an island can be defined under: a path of letters,
 * digits and `_ $ . -` segments, at most 200 characters, and no name
 * `Object.prototype` carries. `defineIsland` refuses any other id, and the
 * compiler reports an island file whose path does not give one, so a
 * compiled island never fails when its module loads.
 */
export function isIslandId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length <= MAX_ISLAND_ID_LENGTH &&
    ISLAND_ID.test(id) &&
    !(id in Object.prototype)
  );
}

/** The longest `data-jsails-props` value, in UTF-16 code units. */
export const MAX_ISLAND_PROPS_LENGTH = 65_536;

/** The deepest nesting decoded props may have. */
const MAX_DEPTH = 32;

/** The most object keys decoded props may hold, counted at every depth. */
const MAX_KEYS = 1_000;

/** Decoded island props. */
export type DecodedIslandProps = Record<string, unknown>;

/**
 * Decode an island's `data-jsails-props` value: `{}` when it is absent or
 * empty, otherwise a plain object within the bounds, or an `island.props_*`
 * error.
 */
export function decodeIslandProps(raw: string | null | undefined): DecodedIslandProps {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw !== 'string') throw new IslandErrors.Error('props_invalid');
  if (raw.length > MAX_ISLAND_PROPS_LENGTH) throw new IslandErrors.Error('props_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser's message quotes the input, so it is not kept as a cause.
    throw new IslandErrors.Error('props_unparseable');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new IslandErrors.Error('props_invalid');
  }
  checkShape(parsed);
  return parsed as DecodedIslandProps;
}

/**
 * Encode `props` for the `data-jsails-props` marker, refusing what
 * {@link decodeIslandProps} would refuse, and return the marker text with the
 * decoded copy the server renders from.
 */
export function encodeIslandProps(props: object): {
  readonly text: string;
  readonly decoded: DecodedIslandProps;
} {
  let text: string | undefined;
  try {
    text = JSON.stringify(props);
  } catch {
    // The serializer's message names property paths of the value, so it is not kept as a cause.
    throw new IslandErrors.Error('props_unserializable');
  }
  if (typeof text !== 'string') throw new IslandErrors.Error('props_unserializable');
  return { text, decoded: decodeIslandProps(text) };
}

function checkShape(value: object): void {
  let keys = 0;
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) throw new IslandErrors.Error('props_too_large');
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      keys += 1;
      if (keys > MAX_KEYS) throw new IslandErrors.Error('props_too_large');
      if (FORBIDDEN_KEYS.has(key)) throw new IslandErrors.Error('props_invalid');
      visit((node as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(value, 0);
}
