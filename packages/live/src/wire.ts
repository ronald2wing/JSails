/**
 * The wire contract the live Socket.IO transport and the browser client share:
 * the Engine.IO path the namespace mounts on and the three event names.
 *
 * Dependency-free on purpose: the server transport (`socket-transport.ts`) and
 * the browser hook (`client/use-live.ts`) both import it, so the two sides can
 * never drift and neither pulls the other's runtime into its bundle.
 */

/** Engine.IO path the live namespace mounts on. */
export const LIVE_PATH = '/_jsails/live';

/** Socket.IO event names on the live namespace. */
export const LIVE_EVENTS = Object.freeze({
  /** Client -> server: request a live subscription for a publication. */
  subscribe: 'jsails:live:subscribe',
  /** Client -> server: close one subscription. */
  unsubscribe: 'jsails:live:unsubscribe',
  /** Server -> client: one `LiveServerMessage`. */
  message: 'jsails:live:message',
});
