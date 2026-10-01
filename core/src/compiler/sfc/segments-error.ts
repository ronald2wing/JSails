/**
 * The error the `.jsails` segment model and column maps raise.
 *
 * Two failures exist. `invalid_segment` is a compiler bug: a stage built a
 * segment list that breaks the model's invariants (a Verbatim segment whose
 * text is not its source slice, an empty mapped segment, a span outside its
 * source), so no map built from it could be trusted. `unsupported_sourcemap`
 * is a map handed in from outside (oxc's output map) that the composer cannot
 * read. Both are value-free: the message names the rule, and `context` holds
 * only offsets and counts, never source or map text.
 */

import { JsailsError, type JsailsErrorContextValue } from '../../errors/jsails-error.js';

/** Stable codes carried by {@link SegmentMapError}. */
export type SegmentMapErrorCode = 'invalid_segment' | 'unsupported_sourcemap';

/** Raised when a segment list or a source map breaks the model's rules. */
export class SegmentMapError extends JsailsError {
  constructor(
    readonly code: SegmentMapErrorCode,
    message: string,
    context?: Readonly<Record<string, JsailsErrorContextValue>>,
  ) {
    super(message, context === undefined ? undefined : { context });
  }
}
