/**
 * Cell-value formatting shared by the list table, the infolist, and the
 * relation manager table: one value plus a column-shaped format descriptor in,
 * escaped Preact markup out.
 *
 * Keeping it apart from `render-list.ts` and `render-form.ts` avoids a
 * list<->form dependency: both import from here, never from each other. The
 * module is ORM-free and performs no I/O.
 */

import { h, type ComponentChild } from 'preact';

import type { ResourceColumnFormat } from './columns.js';
import { stringifyCell } from './export.js';

/** The format fields a column or infolist entry carries. */
export interface CellFormat {
  readonly format?: ResourceColumnFormat;
  readonly colors?: Readonly<Record<string, string>>;
  readonly imageBaseUrl?: string;
  readonly tagSeparator?: string;
}

/** Render a value according to a cell format; escaping owned by Preact. */
export function renderFormattedValue(value: unknown, cell: CellFormat): ComponentChild {
  const { format, colors, imageBaseUrl, tagSeparator } = cell;
  switch (format) {
    case 'badge': {
      const text = stringifyCell(value);
      const color = colors?.[String(value ?? '')];
      return h(
        'span',
        { class: 'admin-badge', ...(color === undefined ? {} : { style: { color } }) },
        text,
      );
    }
    case 'boolean': {
      const bool = value === true || value === 'true' || value === 1;
      const text = bool ? 'Yes' : 'No';
      const color = colors?.[String(bool)];
      return h(
        'span',
        { class: 'admin-boolean', ...(color === undefined ? {} : { style: { color } }) },
        text,
      );
    }
    case 'date':
      return h('span', { class: 'admin-date' }, formatDate(value));
    case 'image':
      return h('img', {
        src: `${imageBaseUrl ?? ''}${stringifyCell(value)}`,
        alt: '',
      });
    case 'icon':
      return h('span', { class: 'admin-icon' }, stringifyCell(value));
    case 'color':
      return h('span', { class: 'admin-color', style: { backgroundColor: stringifyCell(value) } });
    case 'tags': {
      const separator = tagSeparator ?? ',';
      const tags = stringifyCell(value)
        .split(separator)
        .map((t) => t.trim())
        .filter((t) => t !== '');
      return h('span', null, ...tags.map((t) => h('span', { class: 'admin-tag' }, t)));
    }
    default:
      return stringifyCell(value);
  }
}

/** Render a date cell value, extracting the date portion of an ISO string. */
function formatDate(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value);
  // `YYYY-MM-DD...` -> `YYYY-MM-DD`; anything else is passed through escaped.
  return text.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
}
