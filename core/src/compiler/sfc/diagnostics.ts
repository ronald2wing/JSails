/**
 * Positioned diagnostics of the `.jsails` front end: the block scanner and the
 * template parser.
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

/** Every diagnostic code the front end reports, in one frozen list. */
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
  // Lowering, until the kind lowerings replace the transitional emitter.
  'sfc.not_lowered',
  'sfc.live_handler_not_action',
  'sfc.unresolved_component',
  'sfc.invalid_component_name',
] as const;
Object.freeze(SFC_DIAGNOSTIC_CODES);

/** A front-end diagnostic code. */
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

/** Collects diagnostics for one file; the list comes out ordered by position. */
export class SfcDiagnostics {
  private readonly entries: SfcDiagnostic[] = [];

  constructor(readonly file: string) {}

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

  /** Append diagnostics another pass collected for the same file. */
  addAll(diagnostics: readonly SfcDiagnostic[]): void {
    this.entries.push(...diagnostics);
  }

  get hasErrors(): boolean {
    return this.entries.some((entry) => entry.severity === 'error');
  }

  /** The frozen list, ordered by start offset, then end offset, then code. */
  list(): readonly SfcDiagnostic[] {
    return Object.freeze(
      [...this.entries].sort(
        (a, b) => a.start - b.start || a.end - b.end || a.code.localeCompare(b.code),
      ),
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
    this.entries.push(
      Object.freeze({
        severity,
        code,
        message,
        file: this.file,
        start,
        end: Math.max(start, end),
        ...(extras?.fix === undefined ? {} : { fix: freezeFix(extras.fix) }),
        ...(extras?.related === undefined ? {} : { related: Object.freeze({ ...extras.related }) }),
      }),
    );
  }
}

function freezeFix(fix: SfcFix): SfcFix {
  return Object.freeze({
    message: fix.message,
    edits: Object.freeze(fix.edits.map((edit) => Object.freeze({ ...edit }))),
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
