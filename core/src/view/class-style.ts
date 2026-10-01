/**
 * `class` and `style` normalization for compiled `.jsails` templates (and for
 * TSX that wants the same rules): a bound `:class` or `:style` may be a
 * string, an array or a record, and merges with the element's static
 * attribute and with an object spread through `js-bind`.
 *
 * Browser-safe and dependency-free. Nothing here throws: a value of a shape
 * the types do not allow is ignored, so a template renders the same on the
 * server and in the browser whatever it is given.
 */

/**
 * A `:class` value: a class string, a record of class names to conditions, or
 * an array of either. Falsy entries add nothing.
 *
 * @public
 */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | { readonly [className: string]: unknown }
  | readonly ClassValue[];

/**
 * A normalized style: property names (as written, `fontSize` or `font-size`,
 * custom properties included) to values. Preact renders it.
 *
 * @public
 */
export type StyleObject = Record<string, string | number>;

/**
 * A `:style` value: a CSS declaration string, a record of properties, or an
 * array of either; later entries win. A property set to `null`, `undefined`
 * or `false` is removed.
 *
 * @public
 */
export type StyleValue =
  | string
  | null
  | undefined
  | false
  | { readonly [property: string]: string | number | null | undefined | false }
  | readonly StyleValue[];

/**
 * The class list of a `:class` value, space-separated, or `undefined` when it
 * names no class, so an element with no class renders no `class` attribute.
 *
 * @public
 */
export function normalizeClass(value: ClassValue): string | undefined {
  const names: string[] = [];
  collectClasses(value, names);
  return names.length === 0 ? undefined : names.join(' ');
}

function collectClasses(value: unknown, names: string[]): void {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    if (text !== '') names.push(text);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectClasses(entry, names);
  } else if (value !== null && typeof value === 'object') {
    for (const [name, condition] of Object.entries(value)) {
      if (condition) names.push(name);
    }
  }
}

/**
 * The style object of a `:style` value, or `undefined` when it sets no
 * property, so an element with no style renders no `style` attribute. A
 * declaration string is split into properties (a `;` inside parentheses, as
 * in `url(data:…;base64,…)`, or inside quotes does not end a declaration),
 * and later entries replace earlier ones.
 *
 * @public
 */
export function normalizeStyle(value: StyleValue): StyleObject | undefined {
  const style: StyleObject = {};
  collectStyle(value, style);
  return Object.keys(style).length === 0 ? undefined : style;
}

const COMMENT = /\/\*[\s\S]*?\*\//g;

/**
 * The declarations of a style string: split at each `;` outside parentheses
 * and quotes, in one pass.
 */
function declarations(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== '') {
      if (char === '\\') index += 1;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      if (depth > 0) depth -= 1;
    } else if (char === ';' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function collectStyle(value: unknown, style: StyleObject): void {
  if (typeof value === 'string') {
    for (const declaration of declarations(value.replace(COMMENT, ''))) {
      const colon = declaration.indexOf(':');
      if (colon <= 0) continue;
      const property = declaration.slice(0, colon).trim();
      const text = declaration.slice(colon + 1).trim();
      if (property !== '' && text !== '') style[property] = text;
    }
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStyle(entry, style);
  } else if (value !== null && typeof value === 'object') {
    for (const [property, entry] of Object.entries(value)) {
      if (typeof entry === 'string' || typeof entry === 'number') {
        style[property] = entry;
      } else if (entry === null || entry === undefined || entry === false) {
        delete style[property];
      }
    }
  }
}

/**
 * The attribute names that insert raw HTML, which a `js-bind` spread drops:
 * `js-html` is the one trusted-HTML door of a template.
 */
type RawHtmlAttribute = 'dangerouslySetInnerHTML' | 'innerHTML';

/**
 * The attributes of an object spread through `js-bind`, without the raw-HTML
 * attributes.
 *
 * @public
 */
export type SpreadAttributes<T> = Omit<T, RawHtmlAttribute>;

/**
 * The attributes of an object spread through `js-bind` onto an element with
 * a `class` or `style` of its own, whose classes and styles merge after the
 * element's instead of replacing them.
 *
 * @public
 */
export type BoundAttributes<T> = Omit<T, RawHtmlAttribute | 'class' | 'style'> & {
  readonly class?: string;
  readonly style?: StyleObject;
};

/**
 * Spread `attributes` onto an element: every attribute but the raw-HTML ones
 * (`dangerouslySetInnerHTML`, `innerHTML`) is copied, so an attribute object
 * that comes from data cannot insert markup.
 *
 * @public
 */
export function bindAttributes<T extends object>(
  attributes: T | null | undefined,
): SpreadAttributes<T>;
/**
 * Spread `attributes` onto an element that has a `class` or `style` of its
 * own (`own`): as the one-argument form, with the classes and styles of both
 * merged, the element's first.
 *
 * @public
 */
export function bindAttributes<T extends object>(
  attributes: T | null | undefined,
  own: { readonly class?: ClassValue; readonly style?: StyleValue },
): BoundAttributes<T>;
export function bindAttributes(
  attributes: object | null | undefined,
  own?: { readonly class?: ClassValue; readonly style?: StyleValue },
): Record<string, unknown> {
  const bound: Record<string, unknown> = { ...attributes };
  delete bound['dangerouslySetInnerHTML'];
  delete bound['innerHTML'];
  if (own === undefined) return bound;
  const spread = bound as { readonly class?: ClassValue; readonly style?: StyleValue };
  const className = normalizeClass([own.class, spread.class]);
  const style = normalizeStyle([own.style, spread.style]);
  delete bound['class'];
  delete bound['style'];
  if (className !== undefined) bound['class'] = className;
  if (style !== undefined) bound['style'] = style;
  return bound;
}
