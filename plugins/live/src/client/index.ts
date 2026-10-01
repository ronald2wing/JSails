/**
 * Browser-facing live surface (`@jsails/live/client`).
 *
 * This subpath is the only browser-safe entry in the package: it imports
 * `@preact/signals` and `socket.io-client`, never `socket.io`, `ioredis`, or a
 * Node builtin. The root export (`@jsails/live`) is server-only — it mounts the
 * Socket.IO server and connects to Valkey — so a client island must import from
 * here, not from the package root.
 *
 * ```ts
 * import { useLive } from '@jsails/live/client';
 *
 * const posts = useLive({ publication: 'blog.posts', collection: 'posts' });
 * ```
 */

export { createLiveClientStore, type LiveClientStore } from './client-store.js';
export { useLive, type LiveStatus, type UseLiveOptions, type UseLiveResult } from './use-live.js';
