/**
 * The framework table of attachments, `jsails_attachments`: one row per
 * record and attachment name (unique on record type, record id and name),
 * naming the blob's disk key (indexed, so a blob is deleted only when no
 * row names it), content type, size, optional filename and checksum. A data
 * source whose models declare attachments lists it beside them;
 * `attachments.ts` is what reads and writes it.
 */

import { defineTable, type TableDefinition } from '../model/define-model.js';
import { column } from '../model/model-spec.js';

/** The framework table of attachments; list it in the data source's models. */
export const attachmentTable: TableDefinition = defineTable({
  table: 'jsails_attachments',
  columns: {
    recordType: column.string(100),
    recordId: column.string(64),
    name: column.string(64),
    key: column.string(255),
    filename: column.string(255, { nullable: true }),
    contentType: column.string(127),
    byteSize: column.bigint(),
    checksum: column.string(64, { nullable: true }),
    createdAt: column.timestamp({ default: { now: true } }),
  },
  indexes: [
    { columns: ['recordType', 'recordId', 'name'], unique: true },
    // Whether any row still names a blob, before the blob is deleted.
    { columns: ['key'] },
  ],
});
