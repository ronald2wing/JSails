/**
 * Built-in log formatters: single-line JSON and a plain-text line.
 *
 * Neither formatter throws — a failure while serializing the context yields
 * the fixed placeholder `"[unserializable]"` rather than propagating into the
 * log path. Only `level`, `message`, `context`, and `at` are serialized. An
 * `Error` in the context renders as `{ name, message, code? }`, so
 * `logger.error('failed', { error })` keeps what an operator acts on; stack
 * traces, `cause` chains, and other internals never appear.
 *
 * The line formatter escapes control characters in the message, so a message
 * built from request data cannot start a forged log line or send terminal
 * escape sequences.
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
  if (value instanceof Error) {
    return describeError(value);
  }
  return value;
}

/** The loggable surface of an `Error`: its name, message, and string/number code. */
function describeError(error: Error): Record<string, unknown> {
  const code: unknown = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
  };
}

/** C0 and C1 control characters, DEL, and the Unicode line/paragraph separators. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Escape one control character as `\n`, `\r`, `\t`, or `\uXXXX`. */
function escapeControl(character: string): string {
  switch (character) {
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    default:
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  }
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
 * The context segment is omitted when the context is empty. Control
 * characters in the message are escaped, so one record is always one line.
 */
export function lineFormatter(): LogFormatter {
  return {
    format(record: LogRecord): string {
      const iso = new Date(record.at).toISOString();
      const level = record.level.toUpperCase();
      const context =
        Object.keys(record.context).length === 0 ? '' : ' ' + serializeContext(record.context);
      const message = record.message.replace(CONTROL_CHARACTERS, escapeControl);
      return `${iso} ${level} ${message}${context}`;
    },
  };
}
