/**
 * The eager trigger listener: one capturing document listener for `submit`
 * and `click` that owns every server-component trigger from the moment the
 * client entry runs, and its bubble-phase partner that dispatches it.
 *
 * A trigger is a `submit` of a `[data-jsails-submit]` form, or a `click` on
 * the closest `[data-jsails-call]` (else `[data-jsails-sort]`) element, inside
 * a component root and outside any client island or ignored subtree. Its
 * default is prevented at once, in the capture phase, whatever happens next:
 * a JSails trigger never falls through to a navigation or a native submit.
 *
 * It is dispatched only when the event bubbles back to the document, after
 * every listener on the path below has run, so a listener there that stops
 * propagation vetoes it. That is how a form-level submit guard works (one
 * that holds the submit, saves, then resubmits): dispatching in the capture
 * phase would send the action before the guard ran, with stale values, and
 * again on the resubmit. A trigger marked `.capture`
 * (`data-jsails-capture`) is dispatched in the capture phase instead, before
 * any listener below can stop it. Dispatching means running it, when the
 * queue is open, or holding it in a bounded queue until the component
 * bindings open it, then replaying it in order.
 *
 * The runtime creates the queue before it awaits anything (Turbo is a separate
 * chunk), so a click or submit during that gap is held rather than lost, and
 * the bindings hold it again while Turbo swaps the page. Resolution reads the
 * DOM markers only: it imports no controller, so it can stay in the core chunk
 * when the component runtime moves to its own.
 */

import {
  CALL_ATTRIBUTE,
  CAPTURE_ATTRIBUTE,
  COMPONENT_ATTRIBUTE,
  IGNORE_ATTRIBUTE,
  SORT_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
} from '../server-components/protocol.js';
import { ISLAND_ATTRIBUTE, type JsailsElement, type JsailsEvent } from './islands.js';

/** Triggers held before the queue opens; later ones are prevented and dropped. */
export const MAX_QUEUED_TRIGGERS = 16;

/** The slice of an element trigger resolution touches. */
export interface TriggerElement extends JsailsElement {
  closest(selector: string): TriggerElement | null;
}

/** A resolved server-component trigger: what fired and the element carrying its marker. */
export interface ComponentTrigger {
  /** `submit` (a bound form), `call` (an action trigger), or `sort` (a sort trigger). */
  readonly kind: 'submit' | 'call' | 'sort';
  readonly element: TriggerElement;
}

/** Runs one trigger; the default is already prevented. */
export type TriggerRunner = (trigger: ComponentTrigger) => void;

/** The slice of `document` the queue listens on. */
export interface TriggerDocument {
  addEventListener(type: string, listener: (event: JsailsEvent) => void, options?: unknown): void;
  removeEventListener(
    type: string,
    listener: (event: JsailsEvent) => void,
    options?: unknown,
  ): void;
}

/** The eager listener and its queue. */
export interface TriggerQueue {
  /** Run triggers through `run` from now on, first replaying the held ones in order. */
  open(run: TriggerRunner): void;
  /** Hold triggers again until the next {@link TriggerQueue.open}. */
  hold(): void;
  /** Remove the listener and drop every held trigger. Idempotent. */
  dispose(): void;
  /** Triggers currently held. */
  readonly size: number;
}

/** True when `element` sits inside a component root and outside islands and ignored subtrees. */
function inComponentScope(element: TriggerElement): boolean {
  return (
    element.closest(`[${ISLAND_ATTRIBUTE}]`) === null &&
    element.closest(`[${IGNORE_ATTRIBUTE}]`) === null &&
    element.closest(`[${COMPONENT_ATTRIBUTE}]`) !== null
  );
}

/** `element` when its `attribute` names something, else `null`. */
function marked(element: TriggerElement | null, attribute: string): TriggerElement | null {
  if (element === null) {
    return null;
  }
  const value = element.getAttribute(attribute);
  return value === null || value === '' ? null : element;
}

/**
 * Resolve the server-component trigger an event fired, or `null` when it is
 * not one. A call marker wins over a sort marker, and a call trigger outside
 * component scope never falls back to an enclosing sort trigger.
 */
export function resolveTrigger(event: JsailsEvent): ComponentTrigger | null {
  const target = event.target as TriggerElement | null;
  if (target === null || typeof target.closest !== 'function') {
    return null;
  }
  if (event.type === 'submit') {
    const form = marked(target.closest(`[${SUBMIT_ATTRIBUTE}]`), SUBMIT_ATTRIBUTE);
    return form !== null && inComponentScope(form) ? { kind: 'submit', element: form } : null;
  }
  if (event.type !== 'click') {
    return null;
  }
  const call = target.closest(`[${CALL_ATTRIBUTE}]`);
  if (call !== null) {
    const trigger = marked(call, CALL_ATTRIBUTE);
    return trigger !== null && inComponentScope(trigger)
      ? { kind: 'call', element: trigger }
      : null;
  }
  const sort = marked(target.closest(`[${SORT_ATTRIBUTE}]`), SORT_ATTRIBUTE);
  return sort !== null && inComponentScope(sort) ? { kind: 'sort', element: sort } : null;
}

const CAPTURE = { capture: true } as const;

/** Install the capturing and bubbling listeners on `doc`; the queue starts held. */
export function createTriggerQueue(doc: TriggerDocument): TriggerQueue {
  let run: TriggerRunner | null = null;
  let disposed = false;
  const held: ComponentTrigger[] = [];
  // Triggers resolved in the capture phase and not dispatched yet. An event a
  // listener below stopped never reaches the bubble listener; its entry goes
  // with the event.
  const pending = new WeakMap<JsailsEvent, ComponentTrigger>();

  const dispatch = (trigger: ComponentTrigger): void => {
    if (run !== null) {
      run(trigger);
    } else if (held.length < MAX_QUEUED_TRIGGERS) {
      held.push(trigger);
    }
  };

  const onCapture = (event: JsailsEvent): void => {
    const trigger = resolveTrigger(event);
    if (trigger === null) {
      return;
    }
    event.preventDefault();
    if (trigger.element.hasAttribute(CAPTURE_ATTRIBUTE)) {
      dispatch(trigger);
    } else {
      pending.set(event, trigger);
    }
  };

  const onBubble = (event: JsailsEvent): void => {
    const trigger = pending.get(event);
    if (trigger !== undefined) {
      pending.delete(event);
      dispatch(trigger);
    }
  };

  doc.addEventListener('submit', onCapture, CAPTURE);
  doc.addEventListener('click', onCapture, CAPTURE);
  doc.addEventListener('submit', onBubble);
  doc.addEventListener('click', onBubble);

  return {
    open(next) {
      if (disposed) {
        return;
      }
      run = next;
      // Replay in order; a trigger whose element left the document (a page
      // swap while it waited) has nothing left to act on.
      for (const trigger of held.splice(0)) {
        if (trigger.element.isConnected) {
          next(trigger);
        }
      }
    },
    hold() {
      run = null;
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      run = null;
      held.length = 0;
      doc.removeEventListener('submit', onCapture, CAPTURE);
      doc.removeEventListener('click', onCapture, CAPTURE);
      doc.removeEventListener('submit', onBubble);
      doc.removeEventListener('click', onBubble);
    },
    get size() {
      return held.length;
    },
  };
}
