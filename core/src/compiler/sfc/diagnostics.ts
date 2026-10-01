/**
 * Positioned diagnostics of the `.jsails` compiler: the block scanner, the
 * template parser and the kind lowerings.
 *
 * Every diagnostic names the file that holds the offending text and a range of
 * offsets into that file (UTF-16 code units, the unit JavaScript strings,
 * oxc and TypeScript all count in), so a block read from its own file (the
 * multi-file layout) reports positions in that file. The `message` is
 * value-free: it names the construct, never the author's text. A `fix` is a
 * machine-applicable edit list for the author's own editor or CLI; its
 * inserted text may repeat author source (moving an attribute), exactly like a
 * code frame, so it is shown to the author and never logged or persisted.
 */

/** Every diagnostic code the compiler reports, in one frozen list. */
export const SFC_DIAGNOSTIC_CODES = [
  // Blocks.
  'sfc.text_outside_block',
  'sfc.unknown_block',
  'sfc.server_block_removed',
  'sfc.duplicate_block',
  'sfc.missing_template',
  'sfc.unclosed_block',
  'sfc.self_closing_block',
  'sfc.block_attribute',
  'sfc.script_lang_required',
  'sfc.unsupported_lang',
  'sfc.style_src_unsupported',
  'sfc.legacy_config_export',
  'sfc.script_syntax',
  // Layouts (layout.ts): a block in a folder's template file that has a file
  // of its own there, a file and a folder claiming one component, and a
  // folder file whose text would end its block when joined into one file.
  'sfc.folder_block',
  'sfc.layout_conflict',
  'sfc.raw_text_end_tag',
  // Styles (style.ts): a block that would break the joined stylesheet, and
  // what a scoped block cannot scope.
  'sfc.style_unbalanced',
  'sfc.style_incomplete',
  'sfc.style_at_rule',
  'sfc.scoped_global_rule',
  'sfc.scope_selector',
  'sfc.scope_declaration',
  // Markup.
  'sfc.unclosed_comment',
  'sfc.unsupported_markup',
  'sfc.invalid_tag_name',
  'sfc.unclosed_start_tag',
  'sfc.missing_end_tag',
  'sfc.unexpected_end_tag',
  'sfc.void_end_tag',
  'sfc.end_tag_attribute',
  'sfc.forbidden_tag',
  'sfc.invalid_nesting',
  'sfc.invalid_attribute',
  'sfc.duplicate_attribute',
  'sfc.reserved_attribute',
  'sfc.unknown_entity',
  'sfc.entity_missing_semicolon',
  // Expressions.
  'sfc.unterminated_interpolation',
  'sfc.empty_expression',
  'sfc.invalid_expression',
  // Attributes and directives.
  'sfc.missing_value',
  'sfc.unexpected_value',
  'sfc.unknown_directive',
  'sfc.unknown_modifier',
  'sfc.invalid_name_value',
  'sfc.invalid_for',
  'sfc.dynamic_argument',
  'sfc.vue_syntax',
  'sfc.legacy_syntax',
  'sfc.event_handler_attribute',
  'sfc.unstable_style',
  // Structure.
  'sfc.stray_else',
  'sfc.conflicting_directives',
  'sfc.if_with_for',
  'sfc.bare_template',
  'sfc.template_attribute',
  'sfc.slot_outside_component',
  'sfc.directive_with_children',
  'sfc.component_without_is',
  'sfc.js_pre_needs_prettier_ignore',
  'sfc.for_without_key',
  // Kinds, script and macros (lower.ts, script-analysis.ts).
  'sfc.block_kind',
  'sfc.macro_import',
  'sfc.macro_position',
  'sfc.duplicate_macro',
  'sfc.live_outside_components',
  'sfc.hooks_outside_island',
  'sfc.await_in_sync_kind',
  'sfc.setup_export',
  'sfc.script_default_export',
  'sfc.server_only_literal',
  'sfc.invalid_component_name',
  'sfc.invalid_island_id',
  'sfc.live_definition',
  // Template lowering (template-jsx.ts, scope.ts).
  'sfc.await_in_template',
  'sfc.directive_kind',
  'sfc.event_without_client',
  'sfc.slot_kind',
  'sfc.invalid_slot_name',
  'sfc.mixed_default_slot',
  'sfc.raw_component_tag',
  'sfc.raw_html_attribute',
  'sfc.unresolved_component',
  // Live templates and hoisted mounts (template-jsx.ts, live-mounts.ts).
  'sfc.live_event',
  'sfc.live_event_modifier',
  'sfc.live_handler_not_action',
  'sfc.model_target',
  'sfc.static_unbound',
  'sfc.live_outside_page',
  'sfc.live_tag_position',
  'sfc.live_props_unsupported',
  // Islands: their tags where a template mounts them, their events and
  // bindings in their own templates, and the client target (template-jsx.ts,
  // compile.ts).
  'sfc.island_position',
  'sfc.island_children',
  'sfc.unknown_event',
  'sfc.event_modifier',
  'sfc.client_target',
  // A construct whose kind lowering has not landed (mail, deferred island
  // hydration).
  'sfc.not_lowered',
  // Compilation of the shadow to JavaScript (compile.ts): author code the
  // transformer refuses, and a refusal inside generated code, which is a
  // compiler bug.
  'sfc.compile_error',
  'sfc.internal',
] as const;
Object.freeze(SFC_DIAGNOSTIC_CODES);

/** A compiler diagnostic code. */
export type SfcDiagnosticCode = (typeof SFC_DIAGNOSTIC_CODES)[number];

/** Diagnostic severity: an error stops code generation, a warning does not. */
export type SfcSeverity = 'error' | 'warning';

/** One replacement in the file a diagnostic names: `[start, end)` becomes `text`. */
export interface SfcEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A machine-applicable fix: non-overlapping edits, applied together. */
export interface SfcFix {
  /** What the fix does, value-free (`Insert lang="ts"`). */
  readonly message: string;
  readonly edits: readonly SfcEdit[];
}

/** A second location that explains a diagnostic (the first of two duplicates). */
export interface SfcRelated {
  readonly message: string;
  /** The file `start`/`end` point into, present only when it is not the diagnostic's own. */
  readonly file?: string;
  readonly start: number;
  readonly end: number;
}

/** One positioned, value-free diagnostic. */
export interface SfcDiagnostic {
  readonly severity: SfcSeverity;
  readonly code: SfcDiagnosticCode;
  readonly message: string;
  /** Posix path of the file `start`/`end` point into. */
  readonly file: string;
  readonly start: number;
  readonly end: number;
  readonly fix?: SfcFix;
  readonly related?: SfcRelated;
}

/** Optional parts of a diagnostic. */
export interface SfcDiagnosticExtras {
  readonly fix?: SfcFix;
  readonly related?: SfcRelated;
}

/**
 * Where an offset of a component's offset space lies (`source-space.ts`): the
 * file that holds it and that file's first offset in the space.
 */
export interface SfcLocator {
  locate(offset: number): { readonly file: string; readonly base: number };
  /** The space offset of the file `name`'s first code unit, or `undefined` for another file. */
  baseOf(name: string): number | undefined;
}

interface Entry {
  readonly diagnostic: SfcDiagnostic;
  /** The diagnostic's start in the offset space, the list's order. */
  readonly at: number;
}

/**
 * Collects the diagnostics of one component; the list comes out ordered by
 * position. Constructed with a file name, offsets are offsets into that file;
 * constructed with a {@link SfcLocator}, offsets are space offsets and each
 * diagnostic names the file its start lies in, with its offsets (and those of
 * its fix and related range) made local to that file.
 */
export class SfcDiagnostics {
  private readonly entries: Entry[] = [];
  private readonly locator: SfcLocator;

  constructor(target: string | SfcLocator) {
    this.locator =
      typeof target === 'string'
        ? { locate: () => ({ file: target, base: 0 }), baseOf: () => 0 }
        : target;
  }

  error(
    code: SfcDiagnosticCode,
    message: string,
    start: number,
    end: number,
    extras?: SfcDiagnosticExtras,
  ): void {
    this.push('error', code, message, start, end, extras);
  }

  warn(
    code: SfcDiagnosticCode,
    message: string,
    start: number,
    end: number,
    extras?: SfcDiagnosticExtras,
  ): void {
    this.push('warning', code, message, start, end, extras);
  }

  /** Append diagnostics another pass collected, positioned in a file of this component. */
  addAll(diagnostics: readonly SfcDiagnostic[]): void {
    for (const diagnostic of diagnostics) {
      this.entries.push({
        diagnostic,
        at: (this.locator.baseOf(diagnostic.file) ?? 0) + diagnostic.start,
      });
    }
  }

  get hasErrors(): boolean {
    return this.entries.some((entry) => entry.diagnostic.severity === 'error');
  }

  /** The frozen list, ordered by position, then end offset, then code. */
  list(): readonly SfcDiagnostic[] {
    return Object.freeze(
      [...this.entries]
        .sort(
          (a, b) =>
            a.at - b.at ||
            a.diagnostic.end - b.diagnostic.end ||
            a.diagnostic.code.localeCompare(b.diagnostic.code),
        )
        .map((entry) => entry.diagnostic),
    );
  }

  private push(
    severity: SfcSeverity,
    code: SfcDiagnosticCode,
    message: string,
    start: number,
    end: number,
    extras: SfcDiagnosticExtras | undefined,
  ): void {
    const { file, base } = this.locator.locate(start);
    const fix = extras?.fix === undefined ? undefined : localFix(extras.fix, base);
    this.entries.push({
      at: start,
      diagnostic: Object.freeze({
        severity,
        code,
        message,
        file,
        start: start - base,
        end: Math.max(start, end) - base,
        ...(fix === undefined ? {} : { fix }),
        ...(extras?.related === undefined
          ? {}
          : { related: this.localRelated(extras.related, file) }),
      }),
    });
  }

  private localRelated(related: SfcRelated, file: string): SfcRelated {
    const at = this.locator.locate(related.start);
    return Object.freeze({
      message: related.message,
      ...(at.file === file ? {} : { file: at.file }),
      start: related.start - at.base,
      end: Math.max(related.start, related.end) - at.base,
    });
  }
}

/**
 * The fix with its edits made local to the file at `base`. A fix edits the
 * file its diagnostic names; every edit the compiler builds lies there.
 */
function localFix(fix: SfcFix, base: number): SfcFix {
  return Object.freeze({
    message: fix.message,
    edits: Object.freeze(
      fix.edits.map((edit) =>
        Object.freeze({ start: edit.start - base, end: edit.end - base, text: edit.text }),
      ),
    ),
  });
}

/** Whether any diagnostic in `list` is an error. */
export function hasSfcErrors(list: readonly SfcDiagnostic[]): boolean {
  return list.some((entry) => entry.severity === 'error');
}

/**
 * Apply a fix's edits to `source`. Edits must not overlap; they are applied
 * from the end of the file backwards so earlier offsets stay valid.
 */
export function applySfcFix(source: string, fix: SfcFix): string {
  const edits = [...fix.edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
