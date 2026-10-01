/**
 * View runtime (`jsails/view`): the small browser-safe surface compiled
 * `.jsails` templates import — `class`/`style` normalization, the `js-for`
 * loop, the component and page prop types, and the island seam: naming an
 * island, mounting it with JSON props, its `js-model` bindings and its
 * component events. TSX components may use it for the same rules.
 */

export {
  bindAttributes,
  normalizeClass,
  normalizeStyle,
  type BoundAttributes,
  type ClassValue,
  type SpreadAttributes,
  type StyleObject,
  type StyleValue,
} from './class-style.js';
export type { ComponentChild, PageProps } from './component-types.js';
export { emitter, type Emit, type EmitMap, type EmitProps } from './emit.js';
export {
  defineIsland,
  Island,
  type DefinedIsland,
  type IslandMount,
  type IslandProps,
} from './island.js';
export { IslandErrors, ISLAND_STYLE } from './island-props.js';
export {
  bindControl,
  type CheckboxControlAttributes,
  type ControlKind,
  type ControlEvent,
  type ControlHandlers,
  type ControlOptions,
  type ControlTarget,
  type RadioControlAttributes,
  type ValueControlAttributes,
} from './control-binding.js';
export { renderList } from './render-list.js';
