/**
 * `mountLive(definition, context)`: mount a live server component where a
 * page or layout renders it, the call a compiled `.jsails` page makes for a
 * live tag such as `<TaskList />`.
 *
 * A page renders its tree synchronously after awaiting its function, so a
 * mount (which authorizes, produces state and signs a snapshot) cannot be a
 * child that resolves later. The compiler hoists each live tag into an awaited
 * `const __live0 = await mountLive(TaskList, context)` before the template and
 * renders the result in the tag's place. TSX pages may call it the same way.
 *
 * The component is rendered under its registry id, which a definition carries
 * as `name` until the build manifest owns ids, through the same path as
 * `renderServerComponent`: a static export renders its static form, a live
 * render its signed root.
 */

import type { VNode } from 'preact';

import type { RequestContext } from '../contracts/http.js';
import type { ServerComponentDefinition, ServerComponentState } from './component.js';
import { renderServerComponent } from './extension.js';

/**
 * Mount `component` for `context` and return the host element carrying its
 * root (see the module comment). The component must be registered with the
 * application's server-components plugin under its name.
 *
 * @public
 */
export function mountLive<State extends ServerComponentState>(
  component: ServerComponentDefinition<State>,
  context: RequestContext,
): Promise<VNode> {
  return renderServerComponent(component.name, context);
}
