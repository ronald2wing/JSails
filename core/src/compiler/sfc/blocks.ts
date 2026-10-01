/**
 * The block scanner of `.jsails` files (sfc-plan §2.1 with docs/design/sfc.md
 * §9): it splits a file into its `<script lang="ts">`, `<script setup
 * lang="ts">`, `<template>`, `<template static>` and `<style>` blocks.
 *
 * The scanner is tag-aware, not line-anchored. `<script>` and `<style>` end
 * at the first `</script>` or `</style>` (HTML's raw-text rule). A
 * `<template>` ends at its own `</template>`, found by the template parser
 * itself, so nested `<template>` elements are counted exactly as the parser
 * sees them and the two can never disagree. Same-line content and one-line
 * blocks are legal. Comments may sit between blocks; a leading one is the
 * file's header. `<script>` must carry `lang="ts"`.
 *
 * Every block records the file that holds it and offsets into that file, so a
 * block read from a file of its own (the multi-file layout, where `x/x.ts` is
 * the `<script>` and `x/x.css` the `<style>`) has the same shape: see
 * {@link fileBlock}. The scanner never throws on input; each problem is a
 * positioned diagnostic (`diagnostics.ts`).
 */

import { parseSync, type ESTree } from 'rolldown/utils';

import { SfcDiagnostics, type SfcDiagnostic, type SfcFix } from './diagnostics.js';
import type { TemplateRoot } from './template-ast.js';
import { parseTemplateBlock } from './template-parse.js';

/** What a block is. */
export type SfcBlockType = 'script' | 'script-setup' | 'template' | 'template-static' | 'style';

/** An attribute of a block's start tag. */
export interface SfcBlockAttribute {
  readonly name: string;
  readonly value: string | null;
  readonly start: number;
  readonly end: number;
}

/** One block, with offsets into the file that holds it. */
export interface SfcBlock {
  readonly type: SfcBlockType;
  /** Posix path of the file the block was read from. */
  readonly file: string;
  readonly attributes: readonly SfcBlockAttribute[];
  /** The block's content, exactly as written (not trimmed). */
  readonly content: string;
  readonly contentStart: number;
  readonly contentEnd: number;
  /** Offset of the start tag's `<`, or 0 for a block that is a whole file. */
  readonly start: number;
  /** Offset just past the end tag, or the file length for a whole file. */
  readonly end: number;
}

/** A `<style>` block. */
export interface SfcStyleBlock extends SfcBlock {
  readonly type: 'style';
  readonly scoped: boolean;
}

/** A `<template>` or `<template static>` block with its parsed content. */
export interface SfcTemplateBlock extends SfcBlock {
  readonly type: 'template' | 'template-static';
  readonly root: TemplateRoot;
}

/** A comment between blocks. */
export interface SfcComment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** A scanned `.jsails` file. */
export interface SfcFile {
  readonly file: string;
  readonly script: SfcBlock | null;
  readonly scriptSetup: SfcBlock | null;
  readonly template: SfcTemplateBlock | null;
  readonly templateStatic: SfcTemplateBlock | null;
  readonly styles: readonly SfcStyleBlock[];
  /** The leading `<!-- … -->`, the module header of a file without `<script>`. */
  readonly header: SfcComment | null;
  readonly diagnostics: readonly SfcDiagnostic[];
}

/**
 * The config exports of the removed component format; their values now go in
 * `defineLive({...})`.
 */
const LEGACY_CONFIG_EXPORTS: ReadonlySet<string> = new Set([
  'stateSchema',
  'writableKeys',
  'initialState',
  'authorize',
  'actions',
  'derived',
  'staticFallback',
  'urlBinding',
]);

const HTML_WHITESPACE = /[ \t\n\f\r]/;
const TAG_NAME = /[A-Za-z][^\s/>]*/y;
const ATTRIBUTE_NAME = /[^\s/>=]+/y;

interface StartTag {
  readonly name: string;
  readonly start: number;
  readonly attributes: readonly SfcBlockAttribute[];
  /** Offset of the `>` or of the `/` of `/>`, or the stop position when unclosed. */
  readonly closeAt: number;
  readonly end: number;
  readonly selfClosing: boolean;
  readonly closed: boolean;
}

/** Scan a `.jsails` file into its blocks. `file` is the posix path diagnostics name. */
export function parseSfcBlocks(source: string, file: string): SfcFile {
  return new BlockScanner(source, file).scan();
}

/**
 * A block that is a whole file of its own: the `<script>` of the multi-file
 * layout (`x/x.ts`) or its `<style>` (`x/x.css`, scoped when `x/x.scoped.css`).
 * Offsets are offsets into that file. The block is not checked here; pass a
 * script block to {@link checkScriptBlock}, as the scanner does for its own.
 */
export function fileBlock(
  type: 'script' | 'style',
  source: string,
  file: string,
): SfcBlock | SfcStyleBlock {
  const block = {
    type,
    file,
    attributes: Object.freeze([]),
    content: source,
    contentStart: 0,
    contentEnd: source.length,
    start: 0,
    end: source.length,
  };
  return Object.freeze(
    type === 'style' ? { ...block, type, scoped: file.endsWith('.scoped.css') } : block,
  );
}

class BlockScanner {
  private index = 0;
  private readonly diagnostics: SfcDiagnostics;
  private script: SfcBlock | null = null;
  private scriptSetup: SfcBlock | null = null;
  private template: SfcTemplateBlock | null = null;
  private templateStatic: SfcTemplateBlock | null = null;
  private readonly styles: SfcStyleBlock[] = [];
  private header: SfcComment | null = null;
  private sawBlock = false;

  constructor(
    private readonly source: string,
    private readonly file: string,
  ) {
    this.diagnostics = new SfcDiagnostics(file);
  }

  scan(): SfcFile {
    const { source } = this;
    if (source.startsWith('﻿')) {
      this.index = 1;
    }
    while (this.index < source.length) {
      const at = this.index;
      const char = source[at] ?? '';
      if (HTML_WHITESPACE.test(char)) {
        this.index += 1;
        continue;
      }
      if (source.startsWith('<!--', at)) {
        this.readComment();
        continue;
      }
      if (char === '<' && /[A-Za-z]/.test(source[at + 1] ?? '')) {
        this.readBlock();
        continue;
      }
      if (source.startsWith('</', at) && /[A-Za-z]/.test(source[at + 2] ?? '')) {
        const gt = source.indexOf('>', at);
        this.index = gt === -1 ? source.length : gt + 1;
        this.diagnostics.error(
          'sfc.unexpected_end_tag',
          'End tag outside any block',
          at,
          this.index,
          {
            fix: {
              message: 'Remove the end tag',
              edits: [{ start: at, end: this.index, text: '' }],
            },
          },
        );
        continue;
      }
      this.readStrayText();
    }
    if (this.template === null) {
      this.diagnostics.error(
        'sfc.missing_template',
        'A .jsails file needs a <template> block',
        0,
        0,
      );
    }
    return Object.freeze({
      file: this.file,
      script: this.script,
      scriptSetup: this.scriptSetup,
      template: this.template,
      templateStatic: this.templateStatic,
      styles: Object.freeze(this.styles),
      header: this.header,
      diagnostics: this.diagnostics.list(),
    });
  }

  private readComment(): void {
    const start = this.index;
    const close = this.source.indexOf('-->', start + 4);
    if (close === -1) {
      this.diagnostics.error(
        'sfc.unclosed_comment',
        'Comment is not closed with -->',
        start,
        start + 4,
      );
      this.index = this.source.length;
      return;
    }
    this.index = close + 3;
    if (!this.sawBlock && this.header === null) {
      this.header = Object.freeze({
        text: this.source.slice(start + 4, close),
        start,
        end: this.index,
      });
    }
    this.sawBlock = true;
  }

  private readStrayText(): void {
    const start = this.index;
    const next = this.source.indexOf('<', start + 1);
    let end = next === -1 ? this.source.length : next;
    while (end > start && HTML_WHITESPACE.test(this.source[end - 1] ?? '')) {
      end -= 1;
    }
    this.index = next === -1 ? this.source.length : next;
    this.diagnostics.error(
      'sfc.text_outside_block',
      'Only blocks and comments may appear at the top level of a .jsails file',
      start,
      end,
    );
    this.sawBlock = true;
  }

  private readStartTag(): StartTag {
    const { source } = this;
    const start = this.index;
    TAG_NAME.lastIndex = start + 1;
    const name = TAG_NAME.exec(source)?.[0] ?? '';
    this.index = start + 1 + name.length;
    const attributes: SfcBlockAttribute[] = [];
    for (;;) {
      while (this.index < source.length && HTML_WHITESPACE.test(source[this.index] ?? '')) {
        this.index += 1;
      }
      const at = this.index;
      if (at >= source.length || source[at] === '<') {
        return { name, start, attributes, closeAt: at, end: at, selfClosing: false, closed: false };
      }
      if (source[at] === '>') {
        this.index += 1;
        return {
          name,
          start,
          attributes,
          closeAt: at,
          end: at + 1,
          selfClosing: false,
          closed: true,
        };
      }
      if (source.startsWith('/>', at)) {
        this.index += 2;
        return {
          name,
          start,
          attributes,
          closeAt: at,
          end: at + 2,
          selfClosing: true,
          closed: true,
        };
      }
      ATTRIBUTE_NAME.lastIndex = at;
      const attributeName = ATTRIBUTE_NAME.exec(source)?.[0] ?? source[at] ?? '';
      this.index = at + attributeName.length;
      let value: string | null = null;
      if (source[this.index] === '=') {
        const quote = source[this.index + 1];
        if (quote === '"' || quote === "'") {
          const close = source.indexOf(quote, this.index + 2);
          const valueEnd = close === -1 ? source.length : close;
          value = source.slice(this.index + 2, valueEnd);
          this.index = close === -1 ? source.length : close + 1;
        } else {
          let end = this.index + 1;
          while (end < source.length && !/[\s>]/.test(source[end] ?? '')) {
            end += 1;
          }
          value = source.slice(this.index + 1, end);
          this.index = end;
        }
      }
      attributes.push(Object.freeze({ name: attributeName, value, start: at, end: this.index }));
    }
  }

  private readBlock(): void {
    this.sawBlock = true;
    const tag = this.readStartTag();
    if (!tag.closed) {
      this.diagnostics.error(
        'sfc.unclosed_start_tag',
        'Start tag is not closed with >',
        tag.start,
        tag.end,
      );
      return;
    }
    if (tag.selfClosing) {
      this.diagnostics.error(
        'sfc.self_closing_block',
        'A block cannot be self-closing',
        tag.start,
        tag.end,
      );
      return;
    }
    switch (tag.name) {
      case 'script':
      case 'style':
        this.readRawTextBlock(tag);
        return;
      case 'template':
        this.readTemplateBlock(tag);
        return;
      case 'server':
        this.diagnostics.error(
          'sfc.server_block_removed',
          'The <server> block is removed; move its functions to the component file ending in .server.ts',
          tag.start,
          tag.end,
        );
        this.skipToEndTag(tag);
        return;
      default:
        this.diagnostics.error(
          'sfc.unknown_block',
          'Unknown block; a .jsails file has <script>, <template> and <style> blocks',
          tag.start,
          tag.end,
        );
        this.skipToEndTag(tag);
    }
  }

  /** Find `</name` followed by whitespace, `/` or `>` (case-insensitive), from `from`. */
  private findEndTag(name: string, from: number): { start: number; end: number } | undefined {
    const pattern = new RegExp(`</${name}[\\s/>]`, 'ig');
    pattern.lastIndex = from;
    const match = pattern.exec(this.source);
    if (match === null) {
      return undefined;
    }
    const gt = this.source.indexOf('>', match.index);
    return { start: match.index, end: gt === -1 ? this.source.length : gt + 1 };
  }

  private skipToEndTag(tag: StartTag): void {
    const close = this.findEndTag(tag.name, tag.end);
    if (close === undefined) {
      this.reportUnclosed(tag);
    }
    this.index = close === undefined ? this.source.length : close.end;
  }

  private reportUnclosed(tag: StartTag): void {
    this.diagnostics.error('sfc.unclosed_block', 'Block has no end tag', tag.start, tag.end, {
      fix: {
        message: 'Add the end tag',
        edits: [{ start: this.source.length, end: this.source.length, text: `</${tag.name}>\n` }],
      },
    });
  }

  private readRawTextBlock(tag: StartTag): void {
    const close = this.findEndTag(tag.name, tag.end);
    if (close === undefined) {
      this.reportUnclosed(tag);
    }
    const contentEnd = close?.start ?? this.source.length;
    this.index = close?.end ?? this.source.length;
    const block = {
      file: this.file,
      attributes: tag.attributes,
      content: this.source.slice(tag.end, contentEnd),
      contentStart: tag.end,
      contentEnd,
      start: tag.start,
      end: this.index,
    };
    if (tag.name === 'style') {
      this.checkStyleAttributes(tag);
      this.styles.push(
        Object.freeze({
          ...block,
          type: 'style',
          scoped: tag.attributes.some((attribute) => attribute.name === 'scoped'),
        }),
      );
      return;
    }
    const setup = tag.attributes.some((attribute) => attribute.name === 'setup');
    this.checkScriptAttributes(tag);
    const scanned: SfcBlock = Object.freeze({ ...block, type: setup ? 'script-setup' : 'script' });
    const existing = setup ? this.scriptSetup : this.script;
    if (existing !== null) {
      this.reportDuplicate(tag, existing);
      return;
    }
    if (setup) {
      this.scriptSetup = scanned;
    } else {
      this.script = scanned;
    }
    checkScriptBlock(scanned, this.diagnostics);
  }

  private readTemplateBlock(tag: StartTag): void {
    const isStatic = tag.attributes.some((attribute) => attribute.name === 'static');
    this.checkTemplateAttributes(tag);
    const parsed = parseTemplateBlock(this.source, tag.end, this.diagnostics);
    if (parsed.closeTag === null) {
      this.reportUnclosed(tag);
    }
    this.index = parsed.closeTag?.end ?? this.source.length;
    const block: SfcTemplateBlock = Object.freeze({
      type: isStatic ? 'template-static' : 'template',
      file: this.file,
      attributes: tag.attributes,
      content: this.source.slice(tag.end, parsed.root.end),
      contentStart: tag.end,
      contentEnd: parsed.root.end,
      start: tag.start,
      end: this.index,
      root: parsed.root,
    });
    const existing = isStatic ? this.templateStatic : this.template;
    if (existing !== null) {
      this.reportDuplicate(tag, existing);
      return;
    }
    if (isStatic) {
      this.templateStatic = block;
    } else {
      this.template = block;
    }
  }

  private reportDuplicate(tag: StartTag, existing: SfcBlock): void {
    this.diagnostics.error(
      'sfc.duplicate_block',
      'This block may appear only once',
      tag.start,
      tag.end,
      { related: { message: 'First block here', start: existing.start, end: existing.end } },
    );
  }

  /** The fix removing an attribute and the whitespace before it. */
  private removal(attribute: SfcBlockAttribute): SfcFix {
    let start = attribute.start;
    while (start > 0 && HTML_WHITESPACE.test(this.source[start - 1] ?? '')) {
      start -= 1;
    }
    return { message: 'Remove the attribute', edits: [{ start, end: attribute.end, text: '' }] };
  }

  private reportBlockAttribute(attribute: SfcBlockAttribute, message: string): void {
    this.diagnostics.error('sfc.block_attribute', message, attribute.start, attribute.end, {
      fix: this.removal(attribute),
    });
  }

  private checkScriptAttributes(tag: StartTag): void {
    let lang: SfcBlockAttribute | undefined;
    for (const attribute of tag.attributes) {
      if (attribute.name === 'lang') {
        lang = attribute;
      } else if (attribute.name === 'setup') {
        if (attribute.value !== null) {
          this.reportBlockAttribute(attribute, 'setup takes no value');
        }
      } else {
        this.reportBlockAttribute(attribute, 'A <script> block takes only lang="ts" and setup');
      }
    }
    if (lang === undefined) {
      const before = this.source[tag.closeAt - 1] ?? '';
      const text = HTML_WHITESPACE.test(before) ? 'lang="ts"' : ' lang="ts"';
      this.diagnostics.error(
        'sfc.script_lang_required',
        'A <script> block must declare lang="ts"',
        tag.start,
        tag.end,
        {
          fix: {
            message: 'Insert lang="ts"',
            edits: [{ start: tag.closeAt, end: tag.closeAt, text }],
          },
        },
      );
    } else if (lang.value !== 'ts') {
      this.diagnostics.error(
        'sfc.unsupported_lang',
        'A <script> block is TypeScript: lang="ts"',
        lang.start,
        lang.end,
        {
          fix: {
            message: 'Use lang="ts"',
            edits: [{ start: lang.start, end: lang.end, text: 'lang="ts"' }],
          },
        },
      );
    }
  }

  private checkTemplateAttributes(tag: StartTag): void {
    for (const attribute of tag.attributes) {
      if (attribute.name === 'static') {
        if (attribute.value !== null) {
          this.reportBlockAttribute(attribute, 'static takes no value');
        }
      } else if (attribute.name === 'lang') {
        this.diagnostics.error(
          'sfc.unsupported_lang',
          'A <template> block is HTML; it takes no lang',
          attribute.start,
          attribute.end,
          { fix: this.removal(attribute) },
        );
      } else {
        this.reportBlockAttribute(attribute, 'A <template> block takes only static');
      }
    }
  }

  private checkStyleAttributes(tag: StartTag): void {
    for (const attribute of tag.attributes) {
      if (attribute.name === 'scoped') {
        if (attribute.value !== null) {
          this.reportBlockAttribute(attribute, 'scoped takes no value');
        }
      } else if (attribute.name === 'lang') {
        if (attribute.value !== 'css') {
          this.diagnostics.error(
            'sfc.unsupported_lang',
            'A <style> block is plain CSS',
            attribute.start,
            attribute.end,
            { fix: this.removal(attribute) },
          );
        }
      } else if (attribute.name === 'src') {
        this.diagnostics.error(
          'sfc.style_src_unsupported',
          'A <style> block holds its CSS inline; import a stylesheet from <script> instead',
          attribute.start,
          attribute.end,
        );
      } else {
        this.reportBlockAttribute(attribute, 'A <style> block takes only scoped and lang="css"');
      }
    }
  }
}

/**
 * Check a `<script>` or `<script setup>` block, scanned or a whole file
 * ({@link fileBlock}): a syntax error is reported at its position, and in a
 * `<script>` the removed component config exports are reported at their
 * names. Offsets are offsets into `block.file`.
 */
export function checkScriptBlock(block: SfcBlock, diagnostics: SfcDiagnostics): void {
  const result = parseSync('block.ts', block.content, { sourceType: 'module', lang: 'ts' });
  const error = result.errors.find((entry) => entry.severity === 'Error');
  if (error !== undefined) {
    const label = error.labels[0];
    const start = block.contentStart + Math.min(label?.start ?? 0, block.content.length);
    const labelEnd = block.contentStart + Math.min(label?.end ?? 0, block.content.length);
    // An error at the very end (an unfinished statement) points at the end tag.
    const end = labelEnd > start ? labelEnd : Math.min(start + 1, block.end);
    diagnostics.error('sfc.script_syntax', 'The script is not valid TypeScript', start, end);
    return;
  }
  if (block.type !== 'script') {
    return;
  }
  for (const statement of result.program.body) {
    for (const name of exportedNames(statement)) {
      if (LEGACY_CONFIG_EXPORTS.has(name.name)) {
        diagnostics.error(
          'sfc.legacy_config_export',
          'Component config is no longer exported; pass it to defineLive({...}) in <script>',
          block.contentStart + name.start,
          block.contentStart + name.end,
        );
      }
    }
  }
}

interface NamedRange {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/** The names a top-level statement exports, with their positions. */
function exportedNames(
  statement: ESTree.Statement | ESTree.Directive | ESTree.ModuleDeclaration,
): readonly NamedRange[] {
  if (statement.type !== 'ExportNamedDeclaration') {
    return [];
  }
  const names: NamedRange[] = [];
  const declaration = statement.declaration;
  if (declaration?.type === 'VariableDeclaration') {
    for (const declarator of declaration.declarations) {
      if (declarator.id.type === 'Identifier') {
        names.push({
          name: declarator.id.name,
          start: declarator.id.start,
          end: declarator.id.end,
        });
      }
    }
  } else if (
    (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'ClassDeclaration') &&
    declaration.id !== null
  ) {
    names.push({ name: declaration.id.name, start: declaration.id.start, end: declaration.id.end });
  }
  for (const specifier of statement.specifiers) {
    const exported = specifier.exported;
    const name = exported.type === 'Identifier' ? exported.name : String(exported.value);
    names.push({ name, start: exported.start, end: exported.end });
  }
  return names;
}
