/**
 * The one error class every admin `define*` factory raises for an invalid
 * descriptor specification.
 *
 * Every panel, page, resource, widget, chart, notice, action, tab set, wizard,
 * relation manager, and grouping call validates its input eagerly, so a
 * malformed descriptor fails at construction rather than surfacing as a broken
 * route later. The `code` names the descriptor kind (or the uniqueness rule)
 * that failed; the message is value-free and never echoes the rejected input.
 */

import { JsailsError } from 'jsails/plugin-sdk';

/** Stable machine code carried by every {@link AdminDefinitionError}. */
export type AdminDefinitionErrorCode =
  | 'invalid_panel'
  | 'invalid_page'
  | 'invalid_admin_plugin'
  | 'invalid_contribution'
  | 'invalid_resource'
  | 'invalid_store_resource'
  | 'reserved_slug'
  | 'invalid_widget'
  | 'invalid_chart'
  | 'invalid_notice'
  | 'invalid_action'
  | 'invalid_tabs'
  | 'invalid_wizard'
  | 'invalid_relation_manager'
  | 'invalid_relation_action'
  | 'invalid_grouping'
  | 'duplicate_name'
  | 'missing_parent';

/** Raised for an invalid admin descriptor specification. */
export class AdminDefinitionError extends JsailsError {
  constructor(
    readonly code: AdminDefinitionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
