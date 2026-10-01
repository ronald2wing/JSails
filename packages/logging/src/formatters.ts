/**
 * Built-in log formatters: single-line JSON and a plain-text line.
 *
 * Neither formatter throws — a failure while serializing the context yields
 * the fixed placeholder `"[unserializable]"` rather than propagating into the
 * log path. Only `level`, `message`, `context`, and `at` are serialized;
 * `Error` stack traces, `cause` chains, and other internals never appear.
 */

import type { LogFormatter, LogRecord } from './contract.js';

const UNSERIALIZABLE = '[unserializable]';

/**
 * `JSON.stringify` replacer that drops functions, symbols, and `undefined`
 * values instead of letting them surface as `null` or break the output.
 */
function dropUnserializable(_key: string, value: unknown): unknown {
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    return undefined;
  }
  return value;
}

/**
 * Serialize the context to JSON text. Any failure — a circular structure, a
 * throwing getter or `toJSON`, a `BigInt` — collapses the whole context to the
 * placeholder so the record still logs.
 */
function serializeContext(context: LogRecord['context']): string {
  try {
    return JSON.stringify(context, dropUnserializable);
  } catch {
    return JSON.stringify(UNSERIALIZABLE);
  }
}

/**
 * A formatter that renders every record as a single-line JSON object with the
 * key order `level`, `message`, `context`, `at`. The envelope is assembled by
 * hand so a context that fails to serialize degrades to the placeholder on its
 * own while `level`, `message`, and `at` still reach the sink.
 */
export function jsonFormatter(): LogFormatter {
  return {
    format(record: LogRecord): string {
      return (
        `{"level":${JSON.stringify(record.level)},` +
        `"message":${JSON.stringify(record.message)},` +
        `"context":${serializeContext(record.context)},` +
        `"at":${JSON.stringify(record.at)}}`
      );
    },
  };
}

/**
 * A formatter that renders every record as one line:
 *
 *   <ISO timestamp> <LEVEL> <message> [<json context>]
 *
 * The context segment is omitted when the context is empty.
 */
export function lineFormatter(): LogFormatter {
  return {
    format(record: LogRecord): string {
      const iso = new Date(record.at).toISOString();
      const level = record.level.toUpperCase();
      const context =
        Object.keys(record.context).length === 0 ? '' : ' ' + serializeContext(record.context);
      return `${iso} ${level} ${record.message}${context}`;
    },
  };
}
