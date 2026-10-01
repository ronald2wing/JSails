/**
 * The policy hooks of the compiled deny-matrix gate: each cell of the matrix
 * installs the hooks of its own fixture before it drives a request.
 */

import type { RequestContext } from 'jsails';

/** What a matrix cell decides for the gate. */
export interface GateHooks {
  authorize(context: RequestContext): Promise<boolean>;
  ran(): void;
}

let current: GateHooks | null = null;

/** Install the hooks the gate delegates to. */
export function useGate(hooks: GateHooks): void {
  current = hooks;
}

/** The gate's authorize: the installed policy, or a deny without one. */
export function gateAuthorize(context: RequestContext): Promise<boolean> {
  return current === null ? Promise.resolve(false) : current.authorize(context);
}

/** Record a run of the gate's action. */
export function gateRan(): void {
  current?.ran();
}
