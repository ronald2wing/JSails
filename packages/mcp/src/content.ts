/**
 * MCP content: the blocks a tool result, a prompt message, or a resource read
 * carries, the {@link toolResult} builders, and the checks that turn what a
 * handler returned into wire content.
 *
 * Handler output is untrusted in the sense that it is not checked by the type
 * system at runtime: every block is re-validated here (base64 payloads, MIME
 * types, absolute URIs, annotations, icons), and anything malformed is a
 * serving error reported to the operator, never a half-sent result. The client
 * runs what a remote server sends through the same checks.
 *
 * Blocks keep their annotations (`audience`, `priority`, `lastModified`) in
 * both directions, so content a server marks for the user stays
 * distinguishable from content meant for the model. Members outside the spec's
 * block shapes, `_meta` included, are not carried.
 */

import { isRecord, JsailsError } from 'jsails/plugin-sdk';

/** A JSON value as a handler may return it (readonly containers accepted). */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** One resource body: text or base64 `blob`, with an optional URI and MIME type. */
export type McpResourceContent = {
  /** Defaults to the URI that was read. */
  readonly uri?: string;
  readonly mimeType?: string;
} & ({ readonly text: string } | { readonly blob: string });

/** What a resource read returns: one or more bodies. */
export type McpResourceContents = readonly McpResourceContent[];

/** An icon for a tool, resource, template, prompt, or resource link. */
export interface McpIcon {
  /** An `https:` or `data:` URI. */
  readonly src: string;
  readonly mimeType?: string;
  /** `WxH` sizes such as `48x48`, or `any` for a scalable icon. */
  readonly sizes?: readonly string[];
  readonly theme?: 'light' | 'dark';
}

/** Who a content block is for and how much it matters. */
export interface McpContentAnnotations {
  /** The intended readers: the user, the model (`assistant`), or both. */
  readonly audience?: readonly ('user' | 'assistant')[];
  /** Importance from 0 (least) to 1 (most). */
  readonly priority?: number;
  /** When the content last changed, as an ISO 8601 date-time. */
  readonly lastModified?: string;
}

interface Annotated {
  readonly annotations?: McpContentAnnotations;
}

/** A content block in a tool result or a prompt message. */
export type McpContent =
  | ({ readonly type: 'text'; readonly text: string } & Annotated)
  | ({
      readonly type: 'image' | 'audio';
      readonly data: string;
      readonly mimeType: string;
    } & Annotated)
  | ({
      readonly type: 'resource_link';
      readonly uri: string;
      readonly name: string;
      readonly title?: string;
      readonly mimeType?: string;
      readonly description?: string;
      /** The resource's size in bytes. */
      readonly size?: number;
      readonly icons?: readonly McpIcon[];
    } & Annotated)
  | ({
      readonly type: 'resource';
      readonly resource: { readonly uri: string; readonly mimeType?: string } & (
        { readonly text: string } | { readonly blob: string }
      );
    } & Annotated);

/** One message a prompt renders. */
export interface McpPromptMessage {
  readonly role: 'user' | 'assistant';
  readonly content: McpContent;
}

/** A tool result with explicit content and, optionally, structured output. */
export interface McpToolResult<T = JsonValue> {
  readonly content?: readonly McpContent[];
  readonly structured?: T;
}

const toolResults = new WeakSet<object>();

function brand<T>(result: McpToolResult<T>): McpToolResult<T> {
  const frozen = Object.freeze(result);
  toolResults.add(frozen);
  return frozen;
}

/**
 * Builders for an explicit tool result. A handler that returns a plain value
 * gets the default projection instead (see the tool definition docs).
 */
export const toolResult: Readonly<{
  /** Content blocks only, no structured output. */
  content(content: readonly McpContent[]): McpToolResult<never>;
  /**
   * Structured output, plus optional content. A JSON text block of the value
   * is added unless `content` already holds a text block.
   */
  structured<T>(value: T, content?: readonly McpContent[]): McpToolResult<T>;
}> = Object.freeze({
  content(content: readonly McpContent[]): McpToolResult<never> {
    return brand({ content: Object.freeze([...content]) });
  },
  structured<T>(value: T, content?: readonly McpContent[]): McpToolResult<T> {
    return brand({
      structured: value,
      ...(content === undefined ? {} : { content: Object.freeze([...content]) }),
    });
  },
});

/** True for a value built by {@link toolResult}. */
export function isToolResult(value: unknown): value is McpToolResult<unknown> {
  return typeof value === 'object' && value !== null && toolResults.has(value);
}

/** A wire icon. */
export interface WireIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: 'light' | 'dark';
}

/** Wire content annotations. */
export interface WireAnnotations {
  audience?: ('user' | 'assistant')[];
  priority?: number;
  lastModified?: string;
}

/** A wire content block, as the SDK accepts it. */
export type WireContent = (
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; data: string; mimeType: string }
  | {
      type: 'resource_link';
      uri: string;
      name: string;
      title?: string;
      mimeType?: string;
      description?: string;
      size?: number;
      icons?: WireIcon[];
    }
  | {
      type: 'resource';
      resource:
        | { uri: string; mimeType?: string; text: string }
        | {
            uri: string;
            mimeType?: string;
            blob: string;
          };
    }
) & { annotations?: WireAnnotations };

/** A wire resource body. */
export type WireResourceContent =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType?: string; blob: string };

/**
 * Raised internally when handler output is malformed. The message names the
 * rule that failed, never the value; the serving layer reports it as the
 * cause of an `invalid_result` serving error.
 */
export class InvalidContentError extends JsailsError {
  readonly code = 'invalid_result';
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** RFC 6838 `type/subtype`, with optional parameters. */
const MIME_TYPE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}(?:\s*;.*)?$/;

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new InvalidContentError(`${field} must be a string`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field);
}

function base64(value: unknown, field: string): string {
  if (typeof value !== 'string' || !BASE64.test(value)) {
    throw new InvalidContentError(`${field} must be canonical base64`);
  }
  return value;
}

function mimeType(value: unknown, field: string, family?: 'image' | 'audio'): string {
  if (typeof value !== 'string' || !MIME_TYPE.test(value)) {
    throw new InvalidContentError(`${field} must be a MIME type`);
  }
  if (family !== undefined && !value.toLowerCase().startsWith(`${family}/`)) {
    throw new InvalidContentError(`${field} must be an ${family}/* MIME type`);
  }
  return value;
}

function optionalMimeType(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : mimeType(value, field);
}

/** True for an absolute URI the WHATWG parser accepts. */
export function isAbsoluteUri(value: unknown): value is string {
  return typeof value === 'string' && URL.canParse(value);
}

const ICON_SIZE = /^(?:any|[1-9][0-9]{0,4}x[1-9][0-9]{0,4})$/;
const ICON_MIME_TYPE =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const ICON_FIELDS = new Set(['src', 'mimeType', 'sizes', 'theme']);

/**
 * Check one icon. Returns the wire icon, or the rule it breaks (never the
 * value), so definitions and content can each raise their own error.
 */
export function checkIcon(
  icon: unknown,
):
  { readonly ok: true; readonly icon: WireIcon } | { readonly ok: false; readonly reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!isRecord(icon)) {
    return fail('must be an object');
  }
  if (Object.keys(icon).some((key) => !ICON_FIELDS.has(key))) {
    return fail('has an unknown field');
  }
  if (typeof icon.src !== 'string' || !URL.canParse(icon.src)) {
    return fail('src must be an absolute URI');
  }
  const protocol = new URL(icon.src).protocol;
  if (protocol !== 'https:' && protocol !== 'data:') {
    return fail('src must be an https: or data: URI');
  }
  if (
    icon.mimeType !== undefined &&
    (typeof icon.mimeType !== 'string' || !ICON_MIME_TYPE.test(icon.mimeType))
  ) {
    return fail('mimeType must be a type/subtype MIME type');
  }
  let sizes: string[] | undefined;
  if (icon.sizes !== undefined) {
    if (!Array.isArray(icon.sizes)) {
      return fail('sizes must be an array');
    }
    const entries: unknown[] = icon.sizes;
    if (!entries.every((size) => typeof size === 'string' && ICON_SIZE.test(size))) {
      return fail('sizes must be WxH or any');
    }
    sizes = entries as string[];
  }
  if (icon.theme !== undefined && icon.theme !== 'light' && icon.theme !== 'dark') {
    return fail('theme must be light or dark');
  }
  return {
    ok: true,
    icon: {
      src: icon.src,
      ...(icon.mimeType === undefined ? {} : { mimeType: icon.mimeType }),
      ...(sizes === undefined ? {} : { sizes: [...sizes] }),
      ...(icon.theme === undefined ? {} : { theme: icon.theme }),
    },
  };
}

/** An RFC 3339 date-time, the ISO 8601 profile the spec's `lastModified` uses. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

/** Check a block's annotations; members outside the spec's three are not carried. */
function annotations(value: unknown): { annotations?: WireAnnotations } {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new InvalidContentError('annotations must be an object');
  }
  const checked: WireAnnotations = {};
  if (value.audience !== undefined) {
    if (!Array.isArray(value.audience)) {
      throw new InvalidContentError('annotations audience must be an array');
    }
    const audience: unknown[] = value.audience;
    if (!audience.every((role) => role === 'user' || role === 'assistant')) {
      throw new InvalidContentError('annotations audience may only hold user and assistant');
    }
    checked.audience = [...new Set(audience as ('user' | 'assistant')[])];
  }
  if (value.priority !== undefined) {
    const priority = value.priority;
    if (typeof priority !== 'number' || !(priority >= 0 && priority <= 1)) {
      throw new InvalidContentError('annotations priority must be a number from 0 to 1');
    }
    checked.priority = priority;
  }
  if (value.lastModified !== undefined) {
    const lastModified = value.lastModified;
    if (
      typeof lastModified !== 'string' ||
      !DATE_TIME.test(lastModified) ||
      Number.isNaN(Date.parse(lastModified))
    ) {
      throw new InvalidContentError('annotations lastModified must be an ISO 8601 date-time');
    }
    checked.lastModified = lastModified;
  }
  return Object.keys(checked).length === 0 ? {} : { annotations: checked };
}

function linkSize(value: unknown): { size?: number } {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidContentError('resource_link size must be a non-negative integer');
  }
  return { size: value };
}

function linkIcons(value: unknown): { icons?: WireIcon[] } {
  if (value === undefined) {
    return {};
  }
  if (!Array.isArray(value)) {
    throw new InvalidContentError('resource_link icons must be an array');
  }
  const entries: unknown[] = value;
  return {
    icons: entries.map((entry) => {
      const checked = checkIcon(entry);
      if (!checked.ok) {
        throw new InvalidContentError(`a resource_link icon ${checked.reason}`);
      }
      return checked.icon;
    }),
  };
}

function absoluteUri(value: unknown, field: string): string {
  if (!isAbsoluteUri(value)) {
    throw new InvalidContentError(`${field} must be an absolute URI`);
  }
  return value;
}

/**
 * Validate one resource body. `defaultUri` fills a missing `uri`; a body for
 * that URI with no `mimeType` of its own takes `defaultMimeType`, the type
 * the resource or template declares, so a client that reads without listing
 * first still learns it.
 */
export function wireResourceContent(
  value: unknown,
  defaultUri?: string,
  defaultMimeType?: string,
): WireResourceContent {
  if (!isRecord(value)) {
    throw new InvalidContentError('a resource body must be an object');
  }
  const uri = value.uri === undefined && defaultUri !== undefined ? defaultUri : value.uri;
  const checkedUri = absoluteUri(uri, 'resource uri');
  const type =
    value.mimeType === undefined && checkedUri === defaultUri
      ? defaultMimeType
      : optionalMimeType(value.mimeType, 'resource mimeType');
  const hasText = value.text !== undefined;
  const hasBlob = value.blob !== undefined;
  if (hasText === hasBlob) {
    throw new InvalidContentError('a resource body needs exactly one of text or blob');
  }
  const base = { uri: checkedUri, ...(type === undefined ? {} : { mimeType: type }) };
  return hasText
    ? { ...base, text: text(value.text, 'resource text') }
    : { ...base, blob: base64(value.blob, 'resource blob') };
}

/** Validate one content block. */
export function wireContent(value: unknown): WireContent {
  if (!isRecord(value)) {
    throw new InvalidContentError('a content block must be an object');
  }
  const annotated = annotations(value.annotations);
  switch (value.type) {
    case 'text':
      return { type: 'text', text: text(value.text, 'text'), ...annotated };
    case 'image':
    case 'audio':
      return {
        type: value.type,
        data: base64(value.data, `${value.type} data`),
        mimeType: mimeType(value.mimeType, `${value.type} mimeType`, value.type),
        ...annotated,
      };
    case 'resource_link': {
      const title = optionalText(value.title, 'resource_link title');
      const type = optionalMimeType(value.mimeType, 'resource_link mimeType');
      const description = optionalText(value.description, 'resource_link description');
      const name = text(value.name, 'resource_link name');
      if (name.length === 0) {
        throw new InvalidContentError('resource_link name must not be empty');
      }
      return {
        type: 'resource_link',
        uri: absoluteUri(value.uri, 'resource_link uri'),
        name,
        ...(title === undefined ? {} : { title }),
        ...(type === undefined ? {} : { mimeType: type }),
        ...(description === undefined ? {} : { description }),
        ...linkSize(value.size),
        ...linkIcons(value.icons),
        ...annotated,
      };
    }
    case 'resource': {
      if (!isRecord(value.resource) || value.resource.uri === undefined) {
        throw new InvalidContentError('an embedded resource needs a uri');
      }
      return { type: 'resource', resource: wireResourceContent(value.resource), ...annotated };
    }
    default:
      throw new InvalidContentError('unknown content block type');
  }
}

/** Validate a list of content blocks. */
export function wireContentList(value: unknown): WireContent[] {
  if (!Array.isArray(value)) {
    throw new InvalidContentError('content must be an array');
  }
  const blocks: unknown[] = value;
  return blocks.map((block) => wireContent(block));
}

/**
 * Serialize a value that must be JSON: no `undefined` at the top, no cycles,
 * no non-finite numbers, no functions, no bigints.
 */
export function strictJson(value: unknown): string {
  assertJson(value, new Set());
  return JSON.stringify(value);
}

function assertJson(value: unknown, seen: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidContentError('structured output holds a non-finite number');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new InvalidContentError('structured output is not JSON');
  }
  if (seen.has(value)) {
    throw new InvalidContentError('structured output is cyclic');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    for (const item of items) {
      assertJson(item, seen);
    }
  } else {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidContentError('structured output holds a non-plain object');
    }
    for (const entry of Object.values(value)) {
      if (entry !== undefined) {
        assertJson(entry, seen);
      }
    }
  }
  seen.delete(value);
}

/** The UTF-8 size of a value's JSON serialization. */
export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}
