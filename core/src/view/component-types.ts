/**
 * The types a compiled `.jsails` component is declared with: what a component
 * renders, and the props a page's template sees (`PageProps<typeof load>`,
 * defined beside the page replies in `jsails/pages`: a `reply.props` is
 * unwrapped, and a redirect or not-found reply renders nothing).
 *
 * Types only: nothing here exists at runtime.
 */

import type { RenderChild } from '../contracts/component.js';

export type { PageProps } from '../pages/reply.js';

/**
 * Anything a component renders: an element, text, a number, `null`, or a list
 * of them. Compiled components declare it as their return type, and a
 * `defineSlots` type uses it for slot content.
 *
 * @public
 */
export type ComponentChild = RenderChild;
