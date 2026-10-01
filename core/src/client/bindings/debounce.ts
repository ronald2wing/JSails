/**
 * `data-jsails-debounce` for model-bound controls of a component root.
 *
 * An edit always lands in the controller's working state immediately; the
 * debounce only delays the `sync()` that sends it. A blur flushes a pending
 * edit, and any dispatched action cancels every timer because the action
 * carries the dirty diff itself.
 */

import { DEBOUNCE_ATTRIBUTE, MAX_DEBOUNCE_MS } from '../../server-components/protocol.js';
import type { ComponentController } from '../component-controller.js';

/** The slice of a live binding the debounce timers touch. */
interface DebounceBindingView {
  readonly controller: ComponentController;
  /** Pending timers keyed by model field name. */
  readonly debounce: Map<string, ReturnType<typeof setTimeout>>;
  readonly disposed: boolean;
}

/** Read a control's `data-jsails-debounce` delay; `null` when absent or out of bounds. */
export function debounceMsFor(control: {
  getAttribute(name: string): string | null;
}): number | null {
  const raw = control.getAttribute(DEBOUNCE_ATTRIBUTE);
  if (raw === null || raw === '') {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_DEBOUNCE_MS) {
    return null;
  }
  return parsed;
}

function syncQuietly(binding: DebounceBindingView): void {
  void binding.controller.sync().catch(() => {
    // Sync failures surface through the controller's onError.
  });
}

/** Schedule (or reschedule) a field's debounced `sync()`. */
export function scheduleDebounce(binding: DebounceBindingView, name: string, ms: number): void {
  const existing = binding.debounce.get(name);
  if (existing !== undefined) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    binding.debounce.delete(name);
    if (binding.disposed || binding.controller.blocked || !binding.controller.isDirty()) {
      return;
    }
    syncQuietly(binding);
  }, ms);
  binding.debounce.set(name, timer);
}

/** Cancel every pending timer (an action is dispatching or the binding is disposed). */
export function cancelAllDebounce(binding: DebounceBindingView): void {
  for (const timer of binding.debounce.values()) {
    clearTimeout(timer);
  }
  binding.debounce.clear();
}

/** Send a field's pending edit now (blur); a no-op when the field is not dirty. */
export function flushDebounce(binding: DebounceBindingView, name: string): void {
  const existing = binding.debounce.get(name);
  if (existing !== undefined) {
    clearTimeout(existing);
    binding.debounce.delete(name);
  }
  if (binding.disposed || binding.controller.blocked || !binding.controller.isDirty(name)) {
    return;
  }
  syncQuietly(binding);
}
