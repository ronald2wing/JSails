/**
 * The app's one stylesheet of `.jsails` CSS (sfc-plan §3.3): what the build
 * serves as `virtual:jsails/sfc.css`, collected from the lowerings the server
 * graph reaches (SFC-10 keeps the latest lowering of each file and passes
 * them here).
 *
 * It is a pure function of its input, so its order cannot depend on the
 * order the bundler happened to transform files in: the island marker's
 * layout rule (`ISLAND_STYLE`, the framework's own) first, then the
 * components in code-unit order of their paths, each one's blocks in source
 * order. Two runs over the same lowerings give the same bytes.
 *
 * Scoped CSS is only as private as its scope id is unique: two components
 * whose ids collide would style each other. A collision is refused here,
 * where every component is in view, with both paths.
 */

import { ISLAND_STYLE } from '../../view/island-props.js';
import { SfcStyleErrors, type SfcStyle } from './style.js';

/** What the stylesheet reads from one lowering (`SfcLowering`). */
export interface SfcStyleSource {
  readonly file: string;
  readonly scopeId: string;
  readonly styles: readonly SfcStyle[];
}

/** One block of the stylesheet. */
export interface SfcStyleSheetBlock extends SfcStyle {
  /** The component the block belongs to. */
  readonly file: string;
}

/** The collected stylesheet. */
export interface SfcStyleSheet {
  /** The whole sheet: the island marker rule, then every block's CSS. */
  readonly css: string;
  /** Every block, in the sheet's order. */
  readonly blocks: readonly SfcStyleSheetBlock[];
}

function byPath(a: SfcStyleSource, b: SfcStyleSource): number {
  if (a.file === b.file) return 0;
  return a.file < b.file ? -1 : 1;
}

/**
 * The stylesheet of the components `sources` (see the module comment).
 * Throws `sfc_style.scope_collision` when two components share a scope id
 * and `sfc_style.duplicate_file` when one component is passed twice.
 */
export function sfcStyleSheet(sources: readonly SfcStyleSource[]): SfcStyleSheet {
  const owners = new Map<string, string>();
  const files = new Set<string>();
  for (const source of sources) {
    if (files.has(source.file)) {
      throw new SfcStyleErrors.Error('duplicate_file', { file: source.file });
    }
    files.add(source.file);
    const owner = owners.get(source.scopeId);
    if (owner !== undefined) {
      const [first, second] = [owner, source.file].sort();
      throw new SfcStyleErrors.Error('scope_collision', {
        first: first as string,
        second: second as string,
      });
    }
    owners.set(source.scopeId, source.file);
  }
  const blocks = [...sources]
    .sort(byPath)
    .flatMap((source) =>
      [...source.styles]
        .sort((a, b) => a.index - b.index)
        .map((style): SfcStyleSheetBlock => Object.freeze({ ...style, file: source.file })),
    );
  return Object.freeze({
    css: [`${ISLAND_STYLE}\n`, ...blocks.map((block) => block.css)].join(''),
    blocks: Object.freeze(blocks),
  });
}
