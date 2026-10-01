/**
 * Signals (`jsails/signals`): the `SignalBus` interface and its registry-backed
 * implementation `RegistrySignalBus`, request lifecycle event tokens, the typed
 * service token, and the value-free error. The plugin that provides a bus to an
 * application lives in `@jsails/signals`.
 */

export { RegistrySignalBus, SignalError, type SignalBus } from './signal-bus.js';
export { signalsToken } from './token.js';
export {
  requestFailed,
  requestFinished,
  requestStarted,
  type RequestSignalPayload,
} from './request-signals.js';
