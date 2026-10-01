/**
 * Signals contract (`jsails/signals`): the `SignalBus` interface, request
 * lifecycle event tokens, the typed service token, and the value-free error.
 *
 * The registry-backed implementation and plugin live in `@jsails/signals`.
 */

export { RegistrySignalBus, SignalError, type SignalBus } from './signal-bus.js';
export { signalsToken } from './token.js';
export {
  requestFailed,
  requestFinished,
  requestStarted,
  type RequestSignalPayload,
} from './request-signals.js';
