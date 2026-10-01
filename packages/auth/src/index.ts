/**
 * The `auth` plugin (`@jsails/auth`): Better Auth (email/password + device
 * authorization) over MariaDB, packaged as a framework plugin.
 *
 * `authPlugin` is the extension seam — it provides an {@link AuthSessionService}
 * under {@link authSessionToken} (which the `admin` plugin can require) and
 * mounts the trusted `/api/auth/*`, `/api/login`, `/api/logout`,
 * `/api/device/approve|deny`, `/api/register`, `/api/password-reset`,
 * `/api/password-reset/confirm`, and `/api/verification/send` routes, plus
 * `/api/tokens` when `apiTokens.enabled`.
 *
 * `createAuth` is the lazy Better Auth construction helper for scripts and
 * custom mountings; `loadAuthMigrations` builds Better Auth's schema-migration
 * plan without importing its transitive `better-auth/db/migration` subpath at
 * the call site; `resolveSessionFromRequest` maps a Better Auth session to the
 * JSails `Session` shape; `deviceApi` exposes the RFC 8628 endpoints with
 * checked types; the registration, password-reset, and verification handlers
 * (plus their mail-sender factories and the default `sendMail` seam) complete
 * the account lifecycle; the API-token surface (`createApiToken` /
 * `listApiTokens` / `revokeApiToken` and the `ApiTokenService` behind
 * `apiTokensToken`) mints long-lived, revocable tokens over tagged sessions;
 * `sessionRole` / `requireRole` / `adminOnly` read a session's `role`; and the
 * CLI client (`login` / `whoami` / `logout`) implements the device flow for
 * `jsails login`.
 *
 * Importing this barrel pulls in Better Auth, Kysely, and `mysql2` (the plugin
 * is server-only), which is why auth is a separate package rather than part of
 * core.
 */

export { authPlugin, type AuthPluginOptions, type LoginFormOptions } from './plugin.js';

// The declarative loader calls `mod.default(options)`, so every plugin
// subpath barrel must default-export its factory alongside the named export.
export { authPlugin as default } from './plugin.js';

export { authSessionToken, type AuthSessionService } from './session-service.js';

export {
  createAuth,
  deviceApi,
  disposeCachedAuth,
  resolveSessionFromRequest,
  AuthInstanceError,
  type Auth,
  type AuthBuildOptions,
  type AuthInstanceErrorCode,
  type DeviceApi,
  type DisposableAuth,
  type MagicLinkSender,
} from './better-auth.js';

export { loadAuthMigrations, type AuthMigrations } from './migrations.js';

export { type AuthHandlerOptions, type RateLimitHook } from './routes.js';

export { handleRegister, type RegistrationOptions } from './registration.js';

export {
  createResetPasswordSender,
  createVerificationSender,
  handleRequestPasswordReset,
  handleResetPassword,
  handleSendVerificationEmail,
  sendMail,
  type PasswordResetOptions,
  type SendMailFn,
  type VerificationOptions,
} from './password-reset.js';

export { adminOnly, requireRole, sessionRole, type RoleCheck } from './roles.js';

export {
  CliAuthError,
  login,
  logout,
  whoami,
  type CliAuthErrorCode,
  type Credentials,
  type LoginOptions,
} from './cli-client.js';

export {
  apiTokensToken,
  ApiTokenError,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  type ApiTokenErrorCode,
  type ApiTokenService,
  type ApiTokensOptions,
  type CreateApiTokenInput,
} from './api-token-service.js';

export {
  type ApiToken,
  type ApiTokenStore,
  type CreatedApiToken,
  type ResolvedApiToken,
} from './api-token-store.js';
