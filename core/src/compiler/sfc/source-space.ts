/**
 * The offset space of one `.jsails` component: the files that hold its
 * blocks laid end to end, so every lowering stage keeps passing plain
 * offsets whichever layout the component uses.
 *
 * A single-file component is one file at offset 0. A component folder
 * (`layout.ts`) puts its template file (`x/x.jsails`) at 0 and each other
 * member after it, one code unit apart, so no offset belongs to two files and
 * an insertion point at the end of one file never reads as the start of the
 * next. Only the two places that turn an offset into a file position resolve
 * it: the {@link SegmentWriter} (`segment-writer.ts`), whose spans name the
 * file's {@link SegmentSource}, and {@link SfcDiagnostics}, whose entries name
 * the file. A range that would cross from one file into another is a
 * compiler bug and throws.
 */

import type { SfcLocator } from './diagnostics.js';
import { SegmentMapError } from './segments-error.js';
import { segmentSource, type SegmentSource } from './segments.js';

/** One file of a component, placed in its offset space. */
export interface SpaceFile {
  /** The file's normalized posix project path. */
  readonly file: string;
  readonly text: string;
  /** The offset of the file's first code unit in the space. */
  readonly base: number;
  readonly source: SegmentSource;
}

/** The files of one component in one offset space; see the module comment. */
export class SourceSpace implements SfcLocator {
  readonly files: readonly SpaceFile[];

  /** Lay `files` out in order, the first at offset 0. */
  constructor(files: readonly { readonly file: string; readonly text: string }[]) {
    const placed: SpaceFile[] = [];
    let base = 0;
    for (const entry of files) {
      placed.push(
        Object.freeze({
          file: entry.file,
          text: entry.text,
          base,
          source: segmentSource(entry.file, entry.text),
        }),
      );
      base += entry.text.length + 1;
    }
    if (placed.length === 0) {
      throw new SegmentMapError('invalid_segment', 'a source space holds at least one file');
    }
    this.files = Object.freeze(placed);
  }

  /** The file the offset lies in, its end (an insertion point) included. */
  fileAt(offset: number): SpaceFile {
    for (let index = this.files.length - 1; index >= 0; index -= 1) {
      const file = this.files[index] as SpaceFile;
      if (offset >= file.base) {
        if (offset > file.base + file.text.length) break;
        return file;
      }
    }
    throw new SegmentMapError('invalid_segment', 'an offset lies outside every file of the space', {
      offset,
    });
  }

  /** The file `[start, end)` lies in; throws when the range crosses files. */
  fileOf(start: number, end: number): SpaceFile {
    const file = this.fileAt(start);
    if (end > file.base + file.text.length) {
      throw new SegmentMapError(
        'invalid_segment',
        'a source range crosses from one file into the next',
        {
          start,
          end,
        },
      );
    }
    return file;
  }

  /** The space offset of `offset` in the file `name`, or `undefined` for a file not in the space. */
  offsetIn(name: string, offset: number): number | undefined {
    const file = this.files.find((entry) => entry.file === name);
    return file === undefined ? undefined : file.base + offset;
  }

  /** The text of `[start, end)`, which must lie in one file. */
  slice(start: number, end: number): string {
    const file = this.fileOf(start, end);
    return file.text.slice(start - file.base, end - file.base);
  }

  locate(offset: number): { readonly file: string; readonly base: number } {
    const file = this.fileAt(offset);
    return { file: file.file, base: file.base };
  }

  baseOf(name: string): number | undefined {
    return this.files.find((entry) => entry.file === name)?.base;
  }
}
