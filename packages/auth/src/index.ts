/**
 * The `auth` plugin (`@jsails/auth`): Better Auth (email/password + device
 * authorization) over MariaDB/MySQL, PostgreSQL, or SQLite, packaged as a
 * framework plugin.
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
 * JSails `Session` shape; `findUserByEmail` looks an account up for trusted
 * scripts; `deviceApi` exposes the RFC 8628 endpoints with
 * checked types; the registration, password-reset, and verification handlers
 * (plus their mail-sender factories and the default `sendMail` seam) complete
 * the account lifecycle; the API-token surface (`createApiToken` /
 * `listApiTokens` / `revokeApiToken` and the `ApiTokenService` behind
 * `apiTokensToken`) mints long-lived, revocable tokens over tagged sessions;
 * `sessionRole` / `requireRole` / `adminOnly` read a session's `role` (assigned
 * with `setUserRole`); `createMemoryRateLimiter` is the default credential
 * throttle; and the
 * CLI client (`login` / `whoami` / `logout`) implements the device flow for
 * `jsails login`.
 *
 * Importing this barrel pulls in Better Auth, Kysely, and `mysql2` (the plugin
 * is server-only; `pg` loads only for a postgres database), which is why auth
 * is a separate package rather than part of core.
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
  findUserByEmail,
  resolveSessionFromRequest,
  setUserRole,
  AuthInstanceError,
  type Auth,
  type AuthUser,
  type AuthBuildOptions,
  type AuthPoolOptions,
  type EmailAndPasswordPolicy,
  type SessionAuthMethod,
  type AuthInstanceErrorCode,
  type DeviceApi,
  type DisposableAuth,
  type MagicLinkSender,
} from './better-auth.js';

export {
  type AuthDataSourceLike,
  type AuthDatabaseConfig,
  type AuthDatabaseSource,
  type AuthServerDatabaseConfig,
  type AuthServerDatabaseType,
  type AuthSqliteDatabaseConfig,
} from './auth-database.js';

export { loadAuthMigrations, type AuthMigrations } from './migrations.js';
export { authTableNames } from './auth-tables.js';

export { type AuthHandlerOptions } from './routes.js';

export {
  createMemoryRateLimiter,
  normalizeEmail,
  type MemoryRateLimiterOptions,
  type RateLimitAttempt,
  type RateLimitHook,
  type RateLimitRoute,
} from './rate-limit.js';

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

export { adminOnly, requireRole, sessionRole, type RoleCheck, type RoleSubject } from './roles.js';

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
