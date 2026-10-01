/**
 * pax extended header records (POSIX.1-2001): `"<length> <keyword>=<value>\n"`,
 * where `<length>` counts the whole record in bytes, its own digits included.
 *
 * The parser is strict where a lenient one would let two readers disagree: the
 * length is plain decimal without leading zeros and must land exactly on the
 * record's newline, the records must fill the header's data exactly, keywords
 * and values are UTF-8, and a keyword may appear once per header.
 */

import { ArchiveErrors } from './archive-errors.js';

/** A pax header larger than this is refused; real ones hold a few short records. */
const MAX_PAX_HEADER_BYTES = 1024 * 1024;

const SPACE = 0x20;
const NEWLINE = 0x0a;
const DIGIT_ZERO = 0x30;
const DIGIT_NINE = 0x39;

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function malformed(): Error {
  return new ArchiveErrors.Error('invalid_header', { problem: 'pax_record' });
}

function decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw malformed();
  }
}

/** Read the decimal length at `start`, returning it and the offset of the space after it. */
function readLength(data: Uint8Array, start: number): { length: number; space: number } {
  let offset = start;
  let length = 0;
  while (offset < data.length && data[offset] !== SPACE) {
    const byte = data[offset] ?? 0;
    if (byte < DIGIT_ZERO || byte > DIGIT_NINE) throw malformed();
    if (offset === start && byte === DIGIT_ZERO) throw malformed();
    length = length * 10 + (byte - DIGIT_ZERO);
    if (length > data.length) throw malformed();
    offset += 1;
  }
  if (offset === start || offset >= data.length) throw malformed();
  return { length, space: offset };
}

/**
 * The keyword-value pairs of one pax header's data. Throws
 * `bundle_archive.invalid_header` (`pax_record`) on any malformed record.
 */
export function parsePaxRecords(data: Uint8Array): ReadonlyMap<string, string> {
  if (data.length > MAX_PAX_HEADER_BYTES) throw malformed();
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const { length, space } = readLength(data, offset);
    const end = offset + length;
    if (end > data.length || end <= space + 1 || data[end - 1] !== NEWLINE) throw malformed();
    const body = decode(data.subarray(space + 1, end - 1));
    const equals = body.indexOf('=');
    if (equals < 1) throw malformed();
    const keyword = body.slice(0, equals);
    if (records.has(keyword)) throw malformed();
    records.set(keyword, body.slice(equals + 1));
    offset = end;
  }
  return records;
}
