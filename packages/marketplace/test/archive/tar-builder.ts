/**
 * A deterministic tar writer for the reader's tests: ustar, GNU and pax
 * headers built byte by byte, so a test can state any header a tool might
 * write, including the ones the reader must refuse.
 */

import { gzipSync } from 'node:zlib';

/** One header (and its data) of a fixture archive. */
export interface TarEntry {
  /** The name field; raw bytes for a name that is not UTF-8. */
  readonly name: string | Uint8Array;
  readonly content?: string | Uint8Array;
  /** The typeflag character. Defaults to `0` (regular file). */
  readonly type?: string;
  /** Header magic. Defaults to POSIX `ustar\0` `00`. */
  readonly magic?: 'posix' | 'gnu' | 'v7';
  /** The ustar prefix field. */
  readonly prefix?: string;
  /** Write this size in the header instead of the content length. */
  readonly size?: number;
  /** Link target (field 157). */
  readonly linkName?: string;
}

/** A pax record set as an `x` (or `g`) header entry. */
export function paxEntry(records: Readonly<Record<string, string>>, type = 'x'): TarEntry {
  return { name: 'PaxHeader', type, content: paxRecords(records) };
}

/** pax record text: `"<length> <keyword>=<value>\n"`, the length counting the whole record. */
export function paxRecords(records: Readonly<Record<string, string>>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [keyword, value] of Object.entries(records)) {
    const body = encoder.encode(` ${keyword}=${value}\n`);
    let length = body.length + 1;
    while (String(length).length + body.length !== length) length += 1;
    parts.push(encoder.encode(String(length)), body);
  }
  return concat(parts);
}

const BLOCK = 512;
const encoder = new TextEncoder();

function bytesOf(value: string | Uint8Array | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(0);
  return typeof value === 'string' ? encoder.encode(value) : value;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  const digits = value.toString(8).padStart(length - 1, '0');
  block.set(encoder.encode(digits), offset);
  block[offset + length - 1] = 0;
}

/** Recompute and store a header's checksum (the field counts as spaces). */
export function writeHeaderChecksum(block: Uint8Array): void {
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += block[index] ?? 0;
  block.set(encoder.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
}

const MAGIC = {
  posix: 'ustar\u000000',
  gnu: 'ustar  \u0000',
  v7: '\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000',
} as const;

/** One 512-byte header for `entry` whose data is `size` bytes. */
export function header(entry: TarEntry, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  block.set(bytesOf(entry.name).subarray(0, 100), 0);
  writeOctal(block, 100, 8, entry.type === '5' ? 0o755 : 0o644);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, entry.size ?? size);
  writeOctal(block, 136, 12, 0);
  block[156] = (entry.type ?? '0').charCodeAt(0);
  if (entry.linkName !== undefined) block.set(bytesOf(entry.linkName), 157);
  block.set(encoder.encode(MAGIC[entry.magic ?? 'posix']), 257);
  if (entry.prefix !== undefined) block.set(bytesOf(entry.prefix), 345);
  writeHeaderChecksum(block);
  return block;
}

/** The archive's tar stream, ending with two zero blocks unless `end` is false. */
export function tar(entries: readonly TarEntry[], end = true): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const content = bytesOf(entry.content);
    parts.push(header(entry, content.length));
    const padded = new Uint8Array(Math.ceil(content.length / BLOCK) * BLOCK);
    padded.set(content);
    parts.push(padded);
  }
  if (end) parts.push(new Uint8Array(BLOCK * 2));
  return concat(parts);
}

/** Gzip a tar stream. */
export function gzip(stream: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(stream, { level: 9 }));
}

/** A gzip-compressed archive of `entries`. */
export function tarGz(entries: readonly TarEntry[]): Uint8Array {
  return gzip(tar(entries));
}
