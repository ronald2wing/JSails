/**
 * The app-wide request-body cap `createApp` applies when `maxBodyBytes` is
 * omitted.
 *
 * Dependency-free on purpose: the app config loader resolves the default
 * without loading the HTTP pipeline, so a command that reads a config never
 * loads Hono.
 */

/** Default request-body cap when `maxBodyBytes` is omitted. */
export const DEFAULT_MAX_BODY_BYTES: number = 1024 * 1024; // 1 MiB
