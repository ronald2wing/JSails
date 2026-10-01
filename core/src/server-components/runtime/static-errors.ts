/**
 * The static-export refusals of a server component (`component_static.*`),
 * a leaf module so `pages/page.ts` can recognise them without importing the
 * component runtime.
 */

import { defineErrors, type ErrorRegistry } from '../../errors/registry.js';

const COMPONENT_STATIC_ERRORS = {
  missing_fallback: {
    kind: 'invalid',
    message: 'the server component {component} has no static form for a static export',
    context: { component: 'identifier' },
    suggestion:
      "give it a <template static> block or a staticFallback, or set staticRender: 'initial'",
  },
  initial_denied: {
    kind: 'forbidden',
    message: 'the authorize callback of server component {component} denies the static export',
    context: { component: 'identifier' },
    suggestion:
      "staticRender: 'initial' renders only when authorize returns true without a session; give the component a static fallback instead",
  },
  render_failed: {
    kind: 'internal',
    message: 'the static form of server component {component} failed to render',
    context: { component: 'identifier' },
    suggestion:
      'a static form renders at build time without a session; the cause names the failure (a throwing authorize, initialState or render, a bound form that could navigate, or a nested chain past its depth)',
  },
} as const;

/**
 * Static-export refusals, `component_static.*`: a component without a static
 * form, a `staticRender: 'initial'` component whose `authorize` does not
 * allow the static context, and a static form that fails to render (its
 * cause holds the failure).
 *
 * @public
 */
export const ComponentStaticErrors: ErrorRegistry<
  'component_static',
  typeof COMPONENT_STATIC_ERRORS
> = defineErrors('component_static', COMPONENT_STATIC_ERRORS);
