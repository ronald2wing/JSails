/**
 * Compiler errors for the component source compiler.
 *
 * Errors are value-free by construction: they may be surfaced to a build log,
 * and the source text they describe can carry secrets (or copy them into a
 * persisted artifact). The `subject` carries only a diagnostic name.
 */

import { JsailsError } from '../errors/jsails-error.js';

/** Stable machine codes carried by {@link CompilerError}. */
export type CompilerErrorCode =
  | 'unparseable'
  | 'unsupported_export'
  | 'unsupported_sourcemap'
  | 'invalid_name'
  | 'unresolved_model'
  | 'ambiguous_relation'
  | 'invalid_relation_option';

/** A 1-based line/column position within a source file. */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

/** A half-open source range: `start` is inclusive, `end` is exclusive. */
export interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

/** Diagnostic severity; errors abort codegen, warnings do not. */
export type DiagnosticSeverity = 'error' | 'warning';

/**
 * A location that explains a companion diagnostic (e.g. the first of two
 * conflicting declarations). The `message` is value-free: it names the
 * relationship, never the source text.
 */
export interface RelatedDiagnostic {
  readonly message: string;
  readonly range: SourceRange;
}

/**
 * A single structured compiler diagnostic.
 *
 * `message` is value-free (a diagnostic name, never source text) so it stays
 * safe to log or persist. `frame` is the one sanctioned exception: it is a
 * rendered code frame built from the author's in-memory source at compile time,
 * shown to the author's build log, and never persisted — it is empty when frames
 * are disabled.
 */
export interface CompileDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: CompilerErrorCode;
  readonly message: string;
  /** The value-free tag/directive/field name, when the producer supplies one. */
  readonly subject?: string;
  readonly range: SourceRange;
  readonly frame: string;
  readonly related?: readonly RelatedDiagnostic[];
}

/** Raised when component source cannot be compiled into its target shape. */
export class CompilerError extends JsailsError {
  /** The offending identifier name when known; never source text. */
  readonly subject?: string;
  /** The offending range when known. */
  readonly range?: SourceRange;

  constructor(
    readonly code: CompilerErrorCode,
    message: string,
    subject?: string,
    range?: SourceRange,
  ) {
    super(message);
    if (subject !== undefined) {
      this.subject = subject;
    }
    if (range !== undefined) {
      this.range = range;
    }
  }
}
