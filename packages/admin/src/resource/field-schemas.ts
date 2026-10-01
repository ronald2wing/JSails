/**
 * Admin resource field schemas: the strict Zod object schema derived from a
 * resource's validated fields.
 *
 * The schema is `.strict()`, so unknown keys are always rejected. The schema is
 * derived, not author-supplied, so it is left unfrozen while every
 * author-supplied collection is deep-frozen elsewhere. Repeater fields arrive
 * as a set of flat `name[i].sub` keys, so they are lifted into an array value
 * before the strict object schema sees the flat map.
 *
 * The module is ORM-free and performs no I/O; it imports only the field types
 * and the rich-text factory.
 */

import { isRecord } from 'jsails/plugin-sdk';
import {
  normalizeRichText,
  parseRichText,
  richTextSchema,
  type RichTextParseResult,
} from 'jsails/rich-text';
import { z } from 'zod';

import {
  DEFAULT_MAX_REPEATER_ITEMS,
  type ResourceField,
  type ResourceRepeaterItemType,
  type ResourceSelectOption,
} from './field-types.js';
import { repeaterItemKey, repeaterKeyIndex } from './repeater-keys.js';

/** ISO date (`YYYY-MM-DD`) shape. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** ISO datetime shape (local `YYYY-MM-DDTHH:MM` with optional seconds/zone). */
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?$/;

/** Build a strict Zod object schema from the validated fields. */
export function buildSchema(fields: readonly ResourceField[]): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    shape[field.name] = buildFieldSchema(field);
  }
  const objectSchema = withoutAbsentRichText(fields, z.object(shape).strict());
  if (!fields.some((field) => field.type === 'repeater')) {
    return objectSchema;
  }
  // Repeater fields arrive as a set of flat `name[i].sub` keys, so lift them
  // into an array value before the strict object schema sees the flat map.
  return z.preprocess((value) => liftRepeaters(fields, value), objectSchema);
}

/**
 * Drop a `richText` key whose value parsed to `undefined` (a blank
 * submission), so the save sees no key at all: an update then keeps the
 * stored body, and a store's partial update cannot overwrite it with
 * `undefined`.
 */
function withoutAbsentRichText(
  fields: readonly ResourceField[],
  schema: z.ZodType<Record<string, unknown>>,
): z.ZodType<Record<string, unknown>> {
  const names = new Set(
    fields.filter((field) => field.type === 'richText').map((field) => field.name),
  );
  if (names.size === 0) {
    return schema;
  }
  return schema.transform((values) =>
    Object.fromEntries(
      Object.entries(values).filter(([name, value]) => !(names.has(name) && value === undefined)),
    ),
  );
}

/** Build the coercion + presence schema for a single field. */
function buildFieldSchema(field: ResourceField): z.ZodType {
  const { type } = field;
  switch (type) {
    case 'repeater':
      return buildRepeaterSchema(field);
    case 'file':
      // A file field persists as a string (a disk key or a filename reference).
      return applyPresence(z.string(), field.required);
    default:
      return buildScalarFieldSchema({
        type,
        required: field.required,
        options: field.options,
        min: field.min,
        max: field.max,
        step: field.step,
        language: field.language,
        sanitize: field.sanitize,
      });
  }
}

/** Build the coercion + presence schema for a scalar (non-repeater/file) field. */
function buildScalarFieldSchema(field: {
  readonly type:
    ResourceRepeaterItemType | 'keyvalue' | 'code' | 'markdown' | 'autocomplete' | 'richText';
  readonly required?: boolean;
  readonly options?: readonly ResourceSelectOption[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly language?: string;
  readonly sanitize?: (html: string) => string;
}): z.ZodType {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'autocomplete':
      return applyPresence(z.string(), field.required);
    case 'select':
    case 'radio':
      // Radio always carries options (enforced at validation), so it is an enum.
      return buildChoiceSchema(field);
    case 'toggle':
    case 'checkbox':
      // A checkbox submits nothing when unchecked, so an absent key means
      // `false`; `required` is not meaningful for a boolean and is ignored.
      return z.preprocess(coerceCheckbox, z.boolean());
    case 'number':
      return applyPresence(z.preprocess(coerceNumber, z.number()), field.required);
    case 'date':
      return applyPresence(
        z.preprocess(emptyStringToUndefined, z.string().regex(DATE_PATTERN)),
        field.required,
      );
    case 'datetime':
      return applyPresence(
        z.preprocess(emptyStringToUndefined, z.string().regex(DATETIME_PATTERN)),
        field.required,
      );
    case 'slider':
      return applyPresence(
        z.preprocess(coerceNumber, z.number().min(field.min!).max(field.max!)),
        field.required,
      );
    case 'tags':
      return applyPresence(z.string(), field.required);
    case 'color':
      return applyPresence(z.string().regex(/^#[0-9a-fA-F]{6}$/), field.required);
    case 'code':
      return applyPresence(z.string(), field.required);
    case 'keyvalue':
      return applyPresence(
        z.preprocess(parseJsonValue, z.record(z.string(), z.string())),
        field.required,
      );
    case 'markdown':
      return applyPresence(
        z.string().transform((v) => field.sanitize!(v)),
        field.required,
      );
    case 'richText':
      // A submitted value is a JSON string (a direct object passes through for
      // callers that already parsed it); invalid JSON is left as the raw
      // string so it is refused as a non-document rather than raising a parse
      // exception. An absent or blank value is no value, never an empty
      // document: the editor omits a field it cannot read, so on an update
      // absence means "keep the stored body", and a save that needs a body
      // on create (a store's serializer) says so itself.
      return z.preprocess(parseJsonValue, richTextFieldSchema.optional());
  }
}

/** Build a repeater or formset field schema: a bounded array of validated item objects. */
function buildRepeaterSchema(field: ResourceField): z.ZodType {
  const formset = field.formset;
  if (formset !== undefined) {
    const shape: Record<string, z.ZodType> = {};
    for (const subField of formset.fields) {
      shape[subField.name] = buildFieldSchema(subField);
    }
    const itemSchema = z.object(shape).strict();
    const maxItems = formset.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS;
    const minItems = formset.minItems ?? 0;
    const arraySchema = z.array(itemSchema).max(maxItems);
    return minItems > 0 ? arraySchema.min(minItems) : arraySchema;
  }
  const config = field.repeater!;
  const shape: Record<string, z.ZodType> = {};
  for (const itemField of config.fields) {
    shape[itemField.name] = buildScalarFieldSchema(itemField);
  }
  const itemSchema = z.object(shape).strict();
  const arraySchema = z.array(itemSchema).max(config.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS);
  return field.required === false ? arraySchema : arraySchema.min(1);
}

/**
 * Lift every repeater field's flat `name[i].sub` keys into a single array value
 * (and drop those flat keys) so the strict object schema validates the rest.
 * Exported so the CRUD handler can reconstruct the lifted shape for error
 * mapping (a Zod issue path is nested, not flat).
 */
export function liftRepeaters(fields: readonly ResourceField[], value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const source = value;
  const result: Record<string, unknown> = {};
  const consumed = new Set<string>();
  for (const field of fields) {
    if (field.type !== 'repeater') continue;
    const itemFields: readonly { name: string }[] = field.formset?.fields ?? field.repeater!.fields;
    result[field.name] = extractRepeaterItems(field.name, itemFields, source);
    for (const key of Object.keys(source)) {
      if (key === field.name || key.startsWith(`${field.name}[`)) {
        consumed.add(key);
      }
    }
  }
  for (const [key, entryValue] of Object.entries(source)) {
    if (!consumed.has(key)) {
      result[key] = entryValue;
    }
  }
  return result;
}

/** Collect the submitted repeater or formset items (one object per contiguous index). */
function extractRepeaterItems(
  fieldName: string,
  itemFields: readonly { name: string }[],
  source: Record<string, unknown>,
): unknown[] {
  let maxIndex = -1;
  for (const key of Object.keys(source)) {
    const index = repeaterKeyIndex(fieldName, key);
    if (index !== undefined && index > maxIndex) maxIndex = index;
  }
  if (maxIndex < 0) {
    // No indexed keys were submitted; a direct array (defensive) passes through.
    const direct = source[fieldName];
    return Array.isArray(direct) ? direct : [];
  }
  const items: unknown[] = [];
  for (let i = 0; i <= maxIndex; i += 1) {
    const item: Record<string, unknown> = {};
    let present = false;
    for (const sub of itemFields) {
      const key = repeaterItemKey(fieldName, i, sub.name);
      if (Object.hasOwn(source, key)) {
        item[sub.name] = source[key];
        present = true;
      }
    }
    if (present) items.push(item);
  }
  return items;
}

/** A select/radio is either a free string or a constrained enum of its options. */
function buildChoiceSchema(field: {
  readonly required?: boolean;
  readonly options?: readonly ResourceSelectOption[];
}): z.ZodType {
  if (field.options === undefined || field.options.length === 0) {
    return applyPresence(z.string(), field.required);
  }
  const values = field.options.map((option) => option.value) as [string, ...string[]];
  // An empty selection is "no value": required fields reject it, optional
  // fields pass `undefined` through.
  const base = z.preprocess(emptyStringToUndefined, z.enum(values));
  return applyPresence(base, field.required);
}

/** Apply the `required` presence rule (defaults to required). */
function applyPresence(base: z.ZodType, required: boolean | undefined): z.ZodType {
  return required === false ? base.optional() : base;
}

/** Map an empty string to `undefined` so a blank choice is "no selection". */
function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value === '' ? undefined : value;
}

/** Coerce a checkbox submission: absent/blank is `false`, known truths are `true`. */
function coerceCheckbox(value: unknown): unknown {
  if (value === undefined || value === null || value === '') {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value === 'on' || value === 'true' || value === '1' || value === 'yes';
  }
  return false;
}

/** Coerce a number field: numeric strings become numbers, blank becomes absent. */
function coerceNumber(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return undefined;
    }
    return Number(trimmed); // NaN stays NaN so `z.number()` rejects it.
  }
  return value;
}

/**
 * Read a submitted rich-text value as a writer must store it: check it
 * against the schema, normalise it, then read it with `parseRichText`, which
 * adds the budget. A value the schema refuses is read as it is, so the
 * issues name what is wrong with it (version, size, a refused URL).
 */
export function readSubmittedRichText(value: unknown): RichTextParseResult {
  const structured = richTextSchema.safeParse(value);
  return parseRichText(structured.success ? normalizeRichText(structured.data) : value);
}

/** The `richText` field value: a canonical document, with value-free issues otherwise. */
const richTextFieldSchema: z.ZodType = z.unknown().transform((value, context) => {
  const read = readSubmittedRichText(value);
  if (read.ok) {
    return read.value;
  }
  for (const issue of read.issues) {
    context.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
  }
  return z.NEVER;
});

/**
 * Parse a submitted JSON string (a keyvalue map or a rich-text document):
 * blank is absent, a non-string (an object parsed upstream) passes through, and
 * invalid JSON stays a string so the schema rejects it as a field error rather
 * than raising a parse exception.
 */
export function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}
