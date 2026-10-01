/**
 * Admin export serialization: rows to CSV or JSON plus the matching
 * content-type, for a custom admin page whose `handleGet` returns a download
 * `Response`.
 *
 * CSV output is RFC-4180: every cell is a string, and any value containing
 * commas, double quotes, or newlines is double-quoted with internal quotes
 * escaped. JSON output is a deterministic array of objects restricted to the
 * requested columns. The module is ORM-free and performs no I/O.
 */

/** Export format: CSV or JSON. */
export type ExportFormat = 'csv' | 'json';

/** The serialized export result. */
export interface ExportResult {
  /** The full serialized content (a CSV or JSON string). */
  readonly content: string;
  /** Content-Type header for the download response. */
  readonly contentType: string;
}

/** Content-Type for CSV. */
const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';

/** Content-Type for JSON. */
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * Serialize an array of rows to CSV or JSON.
 *
 * CSV output follows RFC 4180: every cell is stringified, and values
 * containing commas, double-quotes, or newlines are double-quoted
 * with internal quotes escaped (doubled). The header row is always
 * included. JSON output is a deterministic array of objects.
 */
export function serializeExport(
  format: ExportFormat,
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): ExportResult {
  switch (format) {
    case 'csv':
      return { content: serializeCsv(columns, rows), contentType: CSV_CONTENT_TYPE };
    case 'json':
      return { content: serializeJson(columns, rows), contentType: JSON_CONTENT_TYPE };
  }
}

/** Serialize rows to CSV. */
function serializeCsv(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  const lines: string[] = [];
  lines.push(columns.map((c) => escapeCsvValue(c)).join(','));
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCsvValue(stringifyCell(row[c]))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Serialize rows to JSON (deterministic, no trailing newline). */
function serializeJson(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  const objects = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const col of columns) {
      obj[col] = row[col] ?? null;
    }
    return obj;
  });
  return JSON.stringify(objects);
}

/**
 * RFC-4180 CSV escape: quote fields with commas, double-quotes, or newlines.
 * A value that a spreadsheet would evaluate as a formula (`=`, `+`, `-`, `@`,
 * or a leading tab/CR) is prefixed with an apostrophe so exported record data
 * is never executed on the admin's machine.
 */
function escapeCsvValue(value: string): string {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (
    neutralized !== value ||
    neutralized.includes(',') ||
    neutralized.includes('"') ||
    neutralized.includes('\n') ||
    neutralized.includes('\r')
  ) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

/** Stringify a cell value for export; `cell-format.ts` reuses it for display. */
export function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Resolve the export columns: the explicit list or the own-enumerable keys
 * of the first row. Returns an empty array when rows is empty (the caller
 * handles that case).
 */
export function resolveExportColumns(
  explicitColumns: readonly string[] | undefined,
  rows: readonly Record<string, unknown>[],
): readonly string[] {
  if (explicitColumns !== undefined && explicitColumns.length > 0) {
    return explicitColumns;
  }
  if (rows.length === 0) {
    return Object.freeze([]);
  }
  return Object.freeze(Object.keys(rows[0]!));
}
