/**
 * Admin resource CRUD POST handlers: create (`POST <slug>`) and update
 * (`POST <slug>/:id`).
 *
 * Both handlers run the shared default-deny auth gate, then the resource's own
 * `authorize` (`create`/`update`), enforce the same-origin/CSRF mutation guard,
 * and delegate to `runSave`. `runSave` first resolves a repeater add/remove
 * intent (re-rendering the form without saving), then checks every uploaded
 * file part (size cap, sniffed type, active-content refusal, `accept`) and
 * plans a collision-free key, validates the values through the resource's
 * derived Zod schema, and only then writes the uploads through the resource's
 * `resolveFileDisk` seam and saves. A validation failure re-renders the form
 * (422) with per-field, value-free messages and repopulated values and writes
 * nothing; a save failure removes the uploads it wrote. A success
 * 303-redirects to the list, preserving the canonicalized table state.
 *
 * A file field's submitted string is never trusted as a key: only a key the
 * stored record already holds survives (the form's hidden "current" value),
 * and an edit that does not re-select a file keeps the stored key. A
 * read-only resource (no `save`) rejects mutations with a 405.
 */

import type { Context } from 'hono';
import type { ZodError, ZodIssue } from 'zod';

import type { Session } from 'jsails';
import { ValidationError } from 'jsails/api';
import type { Disk } from 'jsails/filesystem';
import { isRecord, valueAtPath } from 'jsails/plugin-sdk';

import { adminHtmlResponse, adminRedirectResponse } from '../../document.js';
import { reportAdminError } from '../../error-report.js';
import { stripFormMarkers } from '../../forms.js';
import {
  assertAdminMutation,
  assertAdminSession,
  readFormBodyAndFiles,
  type UploadedFilePart,
} from '../../guards.js';
import { canonicalizeBack } from '../../list-query.js';
import type { AdminPanel } from '../../panel.js';
import { applyRepeaterIntent, detectRepeaterIntent } from '../../resource/repeater-intent.js';
import { renderFormPage } from '../../resource/render-form.js';
import { liftRepeaters } from '../../resource/field-schemas.js';
import { resourceAllowed } from '../../resource/access.js';
import {
  DEFAULT_MAX_REPEATER_ITEMS,
  DEFAULT_MAX_UPLOAD_BYTES,
  type ResourceField,
} from '../../resource/field-types.js';
import type { Resource, ResourceSaveContext } from '../../resource/index.js';
import { repeaterItemKey } from '../../resource/repeater-keys.js';
import {
  checkUpload,
  diskKeyForUpload,
  sanitizeSegment,
  UPLOAD_TOO_LARGE_MESSAGE,
  UPLOAD_TYPE_MESSAGE,
} from '../../resource/upload-policy.js';
import {
  adminForbiddenResponse,
  adminMethodNotAllowedResponse,
  adminNotFoundResponse,
  adminServerErrorResponse,
} from '../../responses.js';

const READ_ONLY_MESSAGE = 'This resource is read-only.';

/** POST <slug>: create a record. */
export async function handleCreate(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return adminForbiddenResponse();
  }
  if (!(await resourceAllowed(resource, session, 'create', undefined, { report: panel }))) {
    return adminForbiddenResponse();
  }
  const save = resource.save;
  if (save === undefined) {
    return adminMethodNotAllowedResponse(READ_ONLY_MESSAGE);
  }
  const body = await readFormBodyAndFiles(c.req.raw);
  if (!assertAdminMutation(c, session, body.values)) {
    return adminForbiddenResponse();
  }
  return runSave({
    panel,
    resource,
    save,
    session,
    id: null,
    body: body.values,
    files: body.files,
  });
}

/** POST <slug>/:id: update a record. */
export async function handleUpdate(
  panel: AdminPanel,
  resource: Resource,
  c: Context,
): Promise<Response> {
  const session = await assertAdminSession(panel, c.req.raw);
  if (session === null) {
    return adminForbiddenResponse();
  }
  const id = c.req.param('id');
  if (id === undefined) {
    return adminNotFoundResponse();
  }
  if (!(await resourceAllowed(resource, session, 'update', id, { report: panel }))) {
    return adminForbiddenResponse();
  }
  const save = resource.save;
  if (save === undefined) {
    return adminMethodNotAllowedResponse(READ_ONLY_MESSAGE);
  }
  // Verify the record exists (when a `get` callback is available) so an
  // unknown id is a 404 rather than a blind save. The fetched record also
  // back-fills field values (e.g. a file key) on repeater-intent re-renders.
  const get = resource.get;
  let record: Record<string, unknown> | undefined;
  if (get !== undefined) {
    let stored: Record<string, unknown> | null;
    try {
      stored = await get({ session, id });
    } catch (error) {
      reportAdminError(panel, error, {
        surface: 'resource',
        slug: resource.slug,
        operation: 'get',
      });
      return adminServerErrorResponse();
    }
    if (stored === null) {
      return adminNotFoundResponse();
    }
    record = stored;
  }
  const body = await readFormBodyAndFiles(c.req.raw);
  if (!assertAdminMutation(c, session, body.values)) {
    return adminForbiddenResponse();
  }
  return runSave({
    panel,
    resource,
    save,
    session,
    id,
    body: body.values,
    files: body.files,
    ...(record === undefined ? {} : { record }),
  });
}

/** The inputs of one create or update save. */
interface SaveRequest {
  readonly panel: AdminPanel;
  readonly resource: Resource;
  readonly save: (context: ResourceSaveContext) => Promise<void>;
  readonly session: Session;
  /** `null` for a create. */
  readonly id: string | null;
  readonly body: Record<string, string>;
  readonly files: ReadonlyMap<string, UploadedFilePart>;
  /** The stored record, when `get` resolved one for an update. */
  readonly record?: Record<string, unknown>;
}

/** Validate the submitted values; on success save and redirect to the list. */
async function runSave(request: SaveRequest): Promise<Response> {
  const { panel, resource, save, session, id, body, files, record } = request;
  const back = body['_back'];
  const formState = {
    id,
    csrf: session.csrfToken,
    action: `${panel.path}/${resource.slug}${id === null ? '' : `/${id}`}`,
    back: canonicalizeBack(back, resource),
    ...(record === undefined ? {} : { record }),
  };

  // A file field's string value is only ever a key the record already stores
  // (the form's hidden "current" value); anything else the client sent is
  // dropped, so a submission can never point a record at another file.
  const values = keepStoredFileKeys(resource, stripFormMarkers(body), record);

  // A repeater add/remove button submits with the other fields: apply the
  // intent to the submitted values and re-render the form (200) without saving.
  const intent = detectRepeaterIntent(resource, body);
  if (intent !== undefined) {
    return adminHtmlResponse(
      renderFormPage(panel, resource, {
        ...formState,
        values: applyRepeaterIntent(resource, intent, values),
        errors: {},
      }),
      200,
    );
  }

  // Check every upload and plan its key, but write nothing until the values
  // validate, so a rejected submission leaves no object behind.
  const planned = await planUploads(panel, resource, session, files);
  const candidate: Record<string, string> = { ...values };
  for (const upload of planned.uploads) {
    candidate[upload.slot] = upload.key;
  }

  const parsed = resource.schema.safeParse(candidate);
  if (!parsed.success || Object.keys(planned.errors).length > 0) {
    const schemaErrors = parsed.success
      ? {}
      : // Zod issues carry the lifted (nested) path; lift the flat values so
        // `valueAtPath` resolves a present-but-invalid repeater item correctly.
        zodIssuesToFieldErrors(parsed.error, liftRepeaters(resource.fields, candidate));
    return adminHtmlResponse(
      renderFormPage(panel, resource, {
        ...formState,
        values,
        errors: { ...schemaErrors, ...planned.errors },
      }),
      422,
    );
  }

  const written = await writeUploads(panel, resource, planned.uploads);
  if (written === null) {
    return adminServerErrorResponse();
  }
  try {
    await save({ session, id, values: parsed.data });
  } catch (error) {
    await discardUploads(panel, resource, written);
    // A save callback may reject the values itself, as a store-backed resource
    // does through its serializer. That is the admin's input to fix, not a
    // server fault, so it re-renders the form like a schema failure.
    if (!(error instanceof ValidationError)) {
      reportAdminError(panel, error, {
        surface: 'resource',
        slug: resource.slug,
        operation: 'save',
      });
      return adminServerErrorResponse();
    }
    return adminHtmlResponse(
      renderFormPage(panel, resource, {
        ...formState,
        values,
        ...saveIssuesToErrors(resource, error),
      }),
      422,
    );
  }
  const query = canonicalizeBack(back, resource);
  return adminRedirectResponse(`${panel.path}/${resource.slug}${query === '' ? '' : `?${query}`}`);
}

/** One upload slot: a top-level `file` field or one formset row's file sub-field. */
interface FileSlot {
  /** The flat form key (`photo`, or `docs[0].file`). */
  readonly slot: string;
  /** The dotted error path (`photo`, or `docs.0.file`). */
  readonly errorPath: string;
  /** The top-level field the disk is resolved for. */
  readonly fieldName: string;
  /** The field carrying the upload rules. */
  readonly field: ResourceField;
}

/** An upload that passed its checks, with the key it will be stored under. */
interface PlannedUpload {
  readonly slot: string;
  readonly fieldName: string;
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** `null` when no disk is wired: the key is then a filename reference only. */
  readonly disk: Disk | null;
}

/** A stored upload, kept so it can be removed when the save fails. */
interface WrittenUpload {
  readonly key: string;
  readonly fieldName: string;
  readonly disk: Disk;
}

/** Every upload slot a submission can carry, in field order. */
function fileSlots(resource: Resource): FileSlot[] {
  const slots: FileSlot[] = [];
  for (const field of resource.fields) {
    if (field.type === 'file') {
      slots.push({ slot: field.name, errorPath: field.name, fieldName: field.name, field });
      continue;
    }
    const formset = field.formset;
    if (formset === undefined) continue;
    const maxItems = formset.maxItems ?? DEFAULT_MAX_REPEATER_ITEMS;
    for (const sub of formset.fields) {
      if (sub.type !== 'file') continue;
      for (let index = 0; index < maxItems; index += 1) {
        slots.push({
          slot: repeaterItemKey(field.name, index, sub.name),
          errorPath: `${field.name}.${index}.${sub.name}`,
          fieldName: field.name,
          field: sub,
        });
      }
    }
  }
  return slots;
}

/**
 * Keep a file slot's submitted string only when it is a key the stored record
 * already holds for that field; drop it otherwise. A top-level file field the
 * client left out entirely keeps the stored record's key, so editing a record
 * without re-selecting its file never clears or replaces the reference.
 */
function keepStoredFileKeys(
  resource: Resource,
  values: Record<string, string>,
  record: Record<string, unknown> | undefined,
): Record<string, string> {
  const result: Record<string, string> = { ...values };
  for (const slot of fileSlots(resource)) {
    const submitted = result[slot.slot];
    delete result[slot.slot];
    const stored = storedFileKeys(record, slot);
    if (submitted !== undefined && stored.has(submitted)) {
      result[slot.slot] = submitted;
      continue;
    }
    const current = record?.[slot.fieldName];
    if (slot.slot === slot.fieldName && typeof current === 'string' && current !== '') {
      result[slot.slot] = current;
    }
  }
  return result;
}

/** The keys a stored record holds for a slot's field (any formset row for a sub-field). */
function storedFileKeys(
  record: Record<string, unknown> | undefined,
  slot: FileSlot,
): ReadonlySet<string> {
  const keys = new Set<string>();
  const stored = record?.[slot.fieldName];
  if (slot.slot === slot.fieldName) {
    if (typeof stored === 'string' && stored !== '') keys.add(stored);
    return keys;
  }
  if (Array.isArray(stored)) {
    for (const row of stored as readonly unknown[]) {
      const value = isRecord(row) ? row[slot.field.name] : undefined;
      if (typeof value === 'string' && value !== '') keys.add(value);
    }
  }
  return keys;
}

/**
 * Read and check every uploaded part and plan its key. Size and type failures
 * become per-field form errors; nothing is written here.
 */
async function planUploads(
  panel: AdminPanel,
  resource: Resource,
  session: Session,
  files: ReadonlyMap<string, UploadedFilePart>,
): Promise<{ uploads: PlannedUpload[]; errors: Record<string, string> }> {
  const uploads: PlannedUpload[] = [];
  const errors: Record<string, string> = {};
  const disks = new Map<string, Disk | null>();
  for (const slot of fileSlots(resource)) {
    const part = files.get(slot.slot);
    if (part === undefined) continue;
    // Refuse a declared oversize part before buffering it.
    const maxBytes = slot.field.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
    if (part.size !== undefined && part.size > maxBytes) {
      errors[slot.errorPath] = UPLOAD_TOO_LARGE_MESSAGE;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await part.arrayBuffer());
    } catch {
      // An unreadable part is the client's malformed upload, not a server fault.
      errors[slot.errorPath] = UPLOAD_TYPE_MESSAGE;
      continue;
    }
    const checked = checkUpload(bytes, part.name, part.type, slot.field);
    if (!checked.ok) {
      errors[slot.errorPath] = checked.message;
      continue;
    }
    if (!disks.has(slot.fieldName)) {
      disks.set(slot.fieldName, await resolveFileDisk(panel, resource, session, slot.fieldName));
    }
    const disk = disks.get(slot.fieldName) ?? null;
    uploads.push({
      slot: slot.slot,
      fieldName: slot.fieldName,
      // No disk wired: persist the sanitized basename as a reference, not a store.
      key:
        disk === null
          ? sanitizeSegment(part.name) || 'file'
          : diskKeyForUpload(slot.slot, part.name),
      bytes: checked.bytes,
      contentType: checked.contentType,
      disk,
    });
  }
  return { uploads, errors };
}

/** Write the planned uploads; on a failure remove what was written and return `null`. */
async function writeUploads(
  panel: AdminPanel,
  resource: Resource,
  uploads: readonly PlannedUpload[],
): Promise<WrittenUpload[] | null> {
  const written: WrittenUpload[] = [];
  for (const upload of uploads) {
    if (upload.disk === null) continue;
    try {
      await upload.disk.put(upload.key, upload.bytes, { contentType: upload.contentType });
    } catch (error) {
      reportAdminError(panel, error, { surface: 'upload', slug: resource.slug, operation: 'put' });
      await discardUploads(panel, resource, written);
      return null;
    }
    written.push({ key: upload.key, fieldName: upload.fieldName, disk: upload.disk });
  }
  return written;
}

/** Best-effort removal of uploads a failed save no longer references. */
async function discardUploads(
  panel: AdminPanel,
  resource: Resource,
  written: readonly WrittenUpload[],
): Promise<void> {
  for (const upload of written) {
    try {
      await upload.disk.delete(upload.key);
    } catch (error) {
      reportAdminError(panel, error, {
        surface: 'upload',
        slug: resource.slug,
        operation: 'delete',
      });
    }
  }
}

/** Resolve the disk for a `file` field; a missing/throwing resolver yields `null`. */
async function resolveFileDisk(
  panel: AdminPanel,
  resource: Resource,
  session: Session,
  fieldName: string,
): Promise<Disk | null> {
  const resolver = resource.resolveFileDisk;
  if (resolver === undefined) {
    return null;
  }
  try {
    return (await resolver({ session, fieldName })) ?? null;
  } catch (error) {
    reportAdminError(panel, error, { surface: 'upload', slug: resource.slug, operation: 'disk' });
    return null;
  }
}

/**
 * Map a save-time `ValidationError` onto the form: an issue whose path starts
 * at a form field is shown on that field, and the rest are joined into one
 * form-level message. The issue messages are value-free by contract.
 */
function saveIssuesToErrors(
  resource: Resource,
  error: ValidationError,
): { errors: Record<string, string>; formError?: string } {
  const fieldNames = new Set(resource.fields.map((field) => field.name));
  const errors: Record<string, string> = {};
  const unplaced: string[] = [];
  for (const issue of error.issues) {
    const head = issue.path[0];
    if (typeof head === 'string' && fieldNames.has(head)) {
      errors[head] ??= issue.message;
    } else {
      unplaced.push(issue.message);
    }
  }
  return unplaced.length === 0 ? { errors } : { errors, formError: unplaced.join('; ') };
}

/** Map a Zod error to per-field messages, keyed by dotted path. */
function zodIssuesToFieldErrors(error: ZodError, input: unknown): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const path = [...issue.path, key].map(String).join('.');
        errors[path] = 'Unknown field';
      }
      continue;
    }
    const path = issue.path.map(String).join('.');
    if (path === '') {
      continue;
    }
    if (!(path in errors)) {
      errors[path] = describeIssue(issue, input);
    }
  }
  return errors;
}

/** Produce a stable, value-free message for one Zod issue. */
function describeIssue(issue: ZodIssue, input: unknown): string {
  switch (issue.code) {
    case 'invalid_type': {
      const received = valueAtPath(input, issue.path);
      if (received === undefined) {
        return 'This field is required';
      }
      if (received === null) {
        return 'Value must not be null';
      }
      return typeMessage(issue.expected);
    }
    case 'invalid_value': {
      const received = valueAtPath(input, issue.path);
      return received === undefined ? 'This field is required' : 'Invalid value';
    }
    case 'too_small':
      return boundMessage(issue.origin, issue.minimum, false);
    case 'too_big':
      return boundMessage(issue.origin, issue.maximum, true);
    default:
      return 'Invalid value';
  }
}

/** A value-free message for an `invalid_type` issue. */
function typeMessage(expected: string): string {
  switch (expected) {
    case 'string':
      return 'Expected a string';
    case 'number':
    case 'int':
    case 'integer':
      return 'Expected a number';
    case 'boolean':
      return 'Expected a boolean';
    case 'object':
    case 'record':
      return 'Expected an object';
    case 'array':
    case 'tuple':
      return 'Expected an array';
    default:
      return 'Expected a valid value';
  }
}

/** A value-free message for a `too_small`/`too_big` issue. */
function boundMessage(origin: string, bound: number | bigint, isMax: boolean): string {
  const qualifier = isMax ? 'at most' : 'at least';
  switch (origin) {
    case 'string':
      return `Must be ${qualifier} ${bound} characters`;
    case 'number':
    case 'int':
    case 'integer':
      return `Must be ${qualifier} ${bound}`;
    case 'array':
    case 'set':
      return `Must have ${qualifier} ${bound} items`;
    default:
      return 'Invalid value';
  }
}
