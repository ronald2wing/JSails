/**
 * The one JSON-or-human switch of the reporting commands: `--json` prints the
 * result object as a single line for machines, otherwise the command's own
 * renderer lays it out for people.
 */

/** Options for {@link renderResult}. */
export interface RenderResultOptions<T> {
  /** True when the caller passed `--json`. */
  readonly json: boolean;
  /** The human-readable rendering, consulted only when `json` is false. */
  readonly render: (result: T) => readonly string[];
}

/** Render `result` as one JSON line, or as the human-readable lines. */
export function renderResult<T>(result: T, options: RenderResultOptions<T>): readonly string[] {
  return options.json ? [JSON.stringify(result)] : options.render(result);
}
