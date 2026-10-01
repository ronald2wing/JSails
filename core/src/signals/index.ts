/**
 * Signals (`jsails/signals`): the `SignalBus` interface and its registry-backed
 * implementation `RegistrySignalBus`, request lifecycle event tokens, the typed
 * service token, and the value-free error. An application that wants a bus
 * provides one under `signalsToken` from its own plugin's `setup`.
 */

export { RegistrySignalBus, SignalError, type SignalBus } from './signal-bus.js';
export { signalsToken } from './token.js';
export {
  requestFailed,
  requestFinished,
  requestStarted,
  type RequestSignalPayload,
} from './request-signals.js';
