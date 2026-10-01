/**
 * Tests for export serialization: column resolution and the CSV/JSON output,
 * including formula neutralization.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveExportColumns, serializeExport } from '../../src/index.js';

// ---------------------------------------------------------------------------
// Column resolution
// ---------------------------------------------------------------------------

describe('resolveExportColumns', () => {
  it('returns explicit columns when provided', () => {
    const columns = resolveExportColumns(['id', 'title'], [{ id: '1', title: 'A', extra: 'x' }]);
    assert.deepEqual(columns, ['id', 'title']);
  });

  it('falls back to own-enumerable keys of the first row', () => {
    const columns = resolveExportColumns(undefined, [{ id: '1', title: 'A', extra: 'x' }]);
    assert.deepEqual(columns, ['id', 'title', 'extra']);
  });

  it('returns empty array for empty rows', () => {
    const columns = resolveExportColumns(undefined, []);
    assert.deepEqual(columns, []);
  });

  it('returns explicit columns even when rows are empty', () => {
    const columns = resolveExportColumns(['id'], []);
    assert.deepEqual(columns, ['id']);
  });
});

// ---------------------------------------------------------------------------
// CSV serialization
// ---------------------------------------------------------------------------

describe('serializeExport (csv)', () => {
  it('serializes rows to RFC-4180 CSV with headers', () => {
    const result = serializeExport(
      'csv',
      ['id', 'title'],
      [
        { id: '1', title: 'Hello' },
        { id: '2', title: 'World' },
      ],
    );
    assert.equal(result.contentType, 'text/csv; charset=utf-8');
    assert.equal(result.content, 'id,title\r\n1,Hello\r\n2,World\r\n');
  });

  it('double-quotes fields with commas', () => {
    const result = serializeExport('csv', ['name'], [{ name: 'Doe, John' }]);
    assert.equal(result.content, 'name\r\n"Doe, John"\r\n');
  });

  it('neutralizes values a spreadsheet would evaluate as formulas', () => {
    const result = serializeExport(
      'csv',
      ['name'],
      [{ name: '=HYPERLINK("http://evil","x")' }, { name: '+1' }, { name: '-1' }, { name: '@x' }],
    );
    const lines = result.content.split('\r\n');
    assert.equal(lines[1], `"'=HYPERLINK(""http://evil"",""x"")"`);
    assert.equal(lines[2], `"'+1"`);
    assert.equal(lines[3], `"'-1"`);
    assert.equal(lines[4], `"'@x"`);
  });

  it('double-quotes fields with double quotes and escapes internal quotes', () => {
    const result = serializeExport('csv', ['name'], [{ name: 'He said "hello"' }]);
    assert.equal(result.content, 'name\r\n"He said ""hello"""\r\n');
  });

  it('double-quotes fields with newlines', () => {
    const result = serializeExport('csv', ['body'], [{ body: 'line1\nline2' }]);
    assert.equal(result.content, 'body\r\n"line1\nline2"\r\n');
  });

  it('renders null/undefined as empty string', () => {
    const result = serializeExport('csv', ['id', 'extra'], [{ id: '1', extra: null }]);
    assert.equal(result.content, 'id,extra\r\n1,\r\n');
  });

  it('stringifies non-string values', () => {
    const result = serializeExport('csv', ['id', 'active'], [{ id: 1, active: true }]);
    assert.equal(result.content, 'id,active\r\n1,true\r\n');
  });

  it('produces an empty body for empty rows', () => {
    const result = serializeExport('csv', ['id', 'title'], []);
    assert.equal(result.content, 'id,title\r\n');
  });
});

// ---------------------------------------------------------------------------
// JSON serialization
// ---------------------------------------------------------------------------

describe('serializeExport (json)', () => {
  it('serializes rows to a JSON array of objects', () => {
    const result = serializeExport(
      'json',
      ['id', 'title'],
      [
        { id: '1', title: 'Hello' },
        { id: '2', title: 'World' },
      ],
    );
    assert.equal(result.contentType, 'application/json; charset=utf-8');
    const parsed = JSON.parse(result.content);
    assert.deepEqual(parsed, [
      { id: '1', title: 'Hello' },
      { id: '2', title: 'World' },
    ]);
  });

  it('maps missing values to null', () => {
    const result = serializeExport('json', ['id', 'extra'], [{ id: '1' }]);
    const parsed = JSON.parse(result.content);
    assert.deepEqual(parsed, [{ id: '1', extra: null }]);
  });

  it('includes only the declared columns, maintaining order', () => {
    const result = serializeExport(
      'json',
      ['title', 'id'],
      [{ id: '1', title: 'Hello', extra: 'x' }],
    );
    const parsed = JSON.parse(result.content);
    const keys = Object.keys(parsed[0]);
    // Ordered: title then id.
    assert.deepEqual(keys, ['title', 'id']);
  });

  it('produces an empty array for empty rows', () => {
    const result = serializeExport('json', ['id'], []);
    assert.equal(result.content, '[]');
  });
});
