/**
 * Better Auth wiring for the `auth` plugin.
 *
 * `createAuth()` is the single construction entry point. Called with no
 * arguments it lazily builds (once) and returns the shared memoized Better Auth
 * instance on the database the `DATABASE_*` variables describe (MariaDB/MySQL
 * through a `mysql2` pool, or PostgreSQL through `pg`; see `auth-database.ts`
 * for the dialect selection); called with {@link AuthBuildOptions} it builds a fresh
 * instance with those overrides (the `auth` plugin uses this to configure
 * sign-up/reset behavior per mount). Importing this module reads no environment
 * variable, creates no pool, and does no database work — construction happens
 * on the first call.
 *
 * Every instance is disposable: it carries an idempotent `dispose()` that
 * releases the connection pool or SQLite handle (`disposeCachedAuth` disposes
 * the memoized instance; the `auth` plugin disposes its own on shutdown).
 * Without this, an open pool socket keeps the event loop alive after `close()`.
 *
 * The variables below are read from `process.env` when an instance is built.
 * Under the `jsails` CLI, `runCli` has already resolved that environment for
 * `JSAILS_ENV`: in development and test `.env`, then `.env.<name>` (`.env.test`
 * under `jsails test`), then the sealed credentials, then `.env.local`
 * (development only), with a secrets file and a real process variable always
 * winning; any other environment reads no `.env` file. A process started
 * without the CLI reads only its real environment, so export the variables
 * there (shell, ONCE, systemd).
 */

import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { bearer } from 'better-auth/plugins/bearer';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';
import { magicLink } from 'better-auth/plugins/magic-link';
import { twoFactor } from 'better-auth/plugins/two-factor';
import type { SocialProviders } from 'better-auth/social-providers';

import type { BetterAuthOptions, User } from 'better-auth';

import type { Session } from 'jsails';

import { isApiTokenSession } from './api-token-store.js';
import { openAuthDatabase, resolveAuthDatabase, type AuthDatabaseSource } from './auth-database.js';
import { DEFAULT_BASE_URL, DEVICE_CLIENT_ID } from './device-flow.js';
import { AuthInstanceError } from './instance-error.js';

export { AuthInstanceError, type AuthInstanceErrorCode } from './instance-error.js';

/** The Better Auth instance type. */
export type Auth = ReturnType<typeof betterAuth>;

/** An {@link Auth} instance whose connection pool can be explicitly released. */
export type DisposableAuth = Auth & { dispose(): Promise<void> };

/** Delivers a magic link: receives the target email and the sign-in URL. */
export type MagicLinkSender = (link: {
  readonly email: string;
  readonly url: string;
}) => void | Promise<void>;

/** Delivers a verification email; Better Auth's `emailVerification.sendVerificationEmail`. */
export type VerificationEmailSender = NonNullable<
  BetterAuthOptions['emailVerification']
>['sendVerificationEmail'];

/** The email/password policy the plugin fixes at construction. */
export type EmailAndPasswordPolicy = Pick<
  NonNullable<BetterAuthOptions['emailAndPassword']>,
  'disableSignUp' | 'autoSignIn' | 'sendResetPassword' | 'revokeSessionsOnPasswordReset'
>;

/** Overridable construction inputs for {@link createAuth}. */
export interface AuthBuildOptions {
  /** The Better Auth signing secret; falls back to the environment when unset. */
  readonly secret?: string;
  /** Public base URL; falls back to `BETTER_AUTH_URL` then localhost. */
  readonly baseUrl?: string;
  /** RFC 8628 client id allowed to use the device flow. */
  readonly deviceClientId?: string;
  /**
   * Enable two-factor authentication (TOTP + backup codes). Only an object
   * mounts the `two-factor` plugin (`{}` for the defaults; `issuer` is the
   * authenticator app label); `false` and `undefined` leave it off. The
   * `twoFactor` table is added to `loadAuthMigrations()` automatically via the
   * plugin tree.
   */
  readonly twoFactor?: false | { readonly issuer?: string };
  /**
   * Social (OAuth) provider configs, keyed by provider id (`google`, `github`,
   * …). Each entry is the provider's client credentials config; callbacks and
   * the account-link surface ride the existing `ALL /api/auth/*` handler.
   */
  readonly socialProviders?: SocialProviders;
  /**
   * Enable magic-link sign-in. Only an object mounts the `magic-link` plugin
   * (`{}` for the defaults); `false` and `undefined` leave it off.
   * `sendMagicLink` must deliver the link (e.g. adapt the app's `sendMail`
   * seam into `(email, url) => void`). A magic link never creates an account
   * while sign-up is disabled (see `emailAndPassword`).
   */
  readonly magicLink?: false | { readonly expiresIn?: number };
  /** Callback delivering a magic link. */
  readonly sendMagicLink?: MagicLinkSender;
  /**
   * Add a `role` column to the user table (`input: false`, so neither sign-up
   * nor update-user can set it) and project it into `session.data.role` for
   * `requireRole`/`adminOnly`. Defaults to `true`; existing databases need
   * `auth:migrate` to add the column. Assign roles with `setUserRole`.
   */
  readonly roles?: boolean;
  /**
   * Email/password policy applied at construction. Unset fields default to the
   * fail-closed values: sign-up disabled, and every session revoked when a
   * password reset completes. `disableSignUp` governs every way an account can
   * be created, not only the email/password endpoint: while it holds, a magic
   * link or social sign-in for an unknown address is refused too.
   */
  readonly emailAndPassword?: EmailAndPasswordPolicy;
  /** Deliver email-verification messages; set when the verification surface is on. */
  readonly sendVerificationEmail?: VerificationEmailSender;
  /**
   * Cache the resolved session in a signed cookie for `maxAge` seconds, so most
   * requests skip the session lookup. Off by default: a cached session outlives
   * its revocation by up to `maxAge`, so keep it short.
   */
  readonly cookieCache?: { readonly maxAge: number };
  /**
   * Size the auth connection pool. Unset fields keep the defaults: at most
   * {@link DEFAULT_POOL_CONNECTION_LIMIT} connections, and at most
   * {@link DEFAULT_POOL_QUEUE_LIMIT} requests waiting for one, past which a
   * request fails fast instead of queueing without bound. On PostgreSQL only
   * `connectionLimit` applies (`pg` has no wait-queue bound); SQLite has no pool.
   */
  readonly pool?: AuthPoolOptions;
  /**
   * The database Better Auth's tables live in: an explicit
   * `AuthDatabaseConfig` (`mariadb`/`mysql`/`postgres` connection
   * settings, or `{ type: 'sqlite', location }`) or the app's
   * `JsailsDataSource`, whose connection options are reused for a separate
   * auth pool. Unset, the `DATABASE_*` environment variables decide, as they
   * always have.
   */
  readonly database?: AuthDatabaseSource;
}

/** Connection-pool sizing for the auth database (see {@link AuthBuildOptions.pool}). */
export interface AuthPoolOptions {
  /** Maximum open connections; a positive integer. */
  readonly connectionLimit?: number;
  /** Maximum requests waiting for a free connection; a positive integer. */
  readonly queueLimit?: number;
}

/** Default maximum open auth database connections (mysql2's own default). */
export const DEFAULT_POOL_CONNECTION_LIMIT = 10;

/**
 * Default maximum requests waiting for an auth database connection. mysql2's
 * own default is an unbounded queue, which under a slow database lets waiting
 * requests pile up in memory; a bound turns that into fast failures.
 */
export const DEFAULT_POOL_QUEUE_LIMIT = 1000;

/**
 * The pool sizing {@link createAuth} passes to mysql2, with defaults applied.
 * A non-positive or non-integer value is refused with a value-free error, so a
 * typo can never fall through to mysql2's `0` (which means unlimited).
 */
export function authPoolSizing(pool: AuthPoolOptions = {}): {
  readonly connectionLimit: number;
  readonly queueLimit: number;
} {
  for (const key of ['connectionLimit', 'queueLimit'] as const) {
    const value = pool[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new TypeError(`pool.${key} must be a positive integer`);
    }
  }
  return {
    connectionLimit: pool.connectionLimit ?? DEFAULT_POOL_CONNECTION_LIMIT,
    queueLimit: pool.queueLimit ?? DEFAULT_POOL_QUEUE_LIMIT,
  };
}

/** The Better Auth signing secret from the environment, or `undefined` when unset. */
export function authSecret(): string | undefined {
  return process.env.BETTER_AUTH_SECRET ?? process.env.AUTH_SECRET;
}

/**
 * The options of an opt-in Better Auth plugin, or `undefined` when it is off.
 * Only an object turns a plugin on; `false` and `undefined` both leave it off.
 * `true` is refused rather than read either way, since a reader who expects it
 * to enable the plugin and one who expects it to be ignored cannot both be
 * right about a security feature.
 */
export function pluginToggle<T extends object>(
  value: false | T | undefined,
  name: string,
): T | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an options object or false`);
  }
  return value;
}

/**
 * Build a Better Auth instance from the environment plus any overrides. The
 * database comes from `options.database` or, unset, the `DATABASE_*`
 * variables (see {@link resolveAuthDatabase}); `secret`,
 * `baseUrl`, and `deviceClientId` fall back to their environment or default
 * values. This performs all construction eagerly; {@link createAuth} wraps it
 * with memoization for the no-options case.
 *
 * The returned instance is disposable: {@link attachDispose} attaches an
 * idempotent `dispose()` that releases the underlying Kysely pool, running
 * `onDisposed` (the no-options path clears the memo) after a successful
 * destroy.
 */
function createAuthInstance(options: AuthBuildOptions, onDisposed?: () => void): DisposableAuth {
  if (
    options.cookieCache !== undefined &&
    (!Number.isInteger(options.cookieCache.maxAge) || options.cookieCache.maxAge < 1)
  ) {
    throw new TypeError('cookieCache.maxAge must be a positive integer number of seconds');
  }
  const twoFactorOptions = pluginToggle(options.twoFactor, 'twoFactor');
  const magicLinkOptions = pluginToggle(options.magicLink, 'magicLink');
  const sizing = authPoolSizing(options.pool);
  const signUpDisabled = options.emailAndPassword?.disableSignUp ?? true;
  const opened = openAuthDatabase(resolveAuthDatabase(options.database), sizing);

  // Annotate with the library's options type instead of letting the options be
  // inferred as a narrowed literal. `betterAuth` is generic in its options and
  // `Auth<O>` is invariant in `O`, so an inferred literal yields
  // `Auth<{ ...narrowed... }>`, which does not assign to the
  // `ReturnType<typeof betterAuth>` (i.e. `Auth<BetterAuthOptions>`) declared
  // for the memoized instance.
  const betterAuthOptions: BetterAuthOptions = {
    database: opened.database,
    // Runtime schema validation is disabled. JSails owns the auth schema through
    // its migration seam (`auth:migrate` / `loadAuthMigrations`), so a per-instance
    // runtime check is redundant — and it is a teardown hazard: Better Auth runs
    // it as a detached fire-and-forget promise (`void pendingSchemaCheck.catch(...)`)
    // that checks out a Kysely pool connection. When `dispose()` destroys the pool
    // before that check settles, `pool.end()` waits on the in-use connection
    // forever and the process never exits. `validateSchema: false` makes the
    // adapter register its check with `runtimeEnabled: false`, so `checkSchema`
    // is `undefined` and the detached check is never created.
    //
    // Better Auth reads the client address (for its limiter and the session's
    // recorded address) from `X-Forwarded-For`, which core's first pipeline
    // stage has already rewritten to the one client it resolved from trusted
    // proxies only; its IPv6 keying matches the plugin's own limiter (the /64).
    advanced: {
      database: { validateSchema: false },
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'], ipv6Subnet: 64 },
    },
    emailAndPassword: {
      enabled: true,
      revokeSessionsOnPasswordReset: true,
      ...options.emailAndPassword,
      disableSignUp: signUpDisabled,
    },
    // Closed sign-up closes every path to a new account. Magic links and social
    // providers create the user on first sign-in, which `disableSignUp` does not
    // govern, so the refusal sits on user creation itself. The trusted path that
    // creates users (the starter's `user:create`) builds its instance with
    // sign-up open.
    ...(signUpDisabled
      ? {
          databaseHooks: {
            user: {
              create: {
                before: async () => {
                  throw new APIError('FORBIDDEN', { message: 'registration is closed' });
                },
              },
            },
          },
        }
      : {}),
    ...(options.sendVerificationEmail !== undefined
      ? { emailVerification: { sendVerificationEmail: options.sendVerificationEmail } }
      : {}),
    ...(options.roles !== false
      ? { user: { additionalFields: { role: { type: 'string', required: false, input: false } } } }
      : {}),
    ...(options.cookieCache !== undefined
      ? { session: { cookieCache: { enabled: true, maxAge: options.cookieCache.maxAge } } }
      : {}),
    secret: options.secret ?? authSecret(),
    baseURL: options.baseUrl ?? process.env.BETTER_AUTH_URL ?? DEFAULT_BASE_URL,
    ...(options.socialProviders !== undefined ? { socialProviders: options.socialProviders } : {}),
    plugins: [
      // Device authorization (RFC 8628) powers `jsails login`: the CLI requests
      // a device/user code, the user approves it on `/device`, and the CLI polls
      // `/api/auth/device/token` for a session token. `validateClient` restricts
      // both endpoints to the known CLI client id.
      deviceAuthorization({
        validateClient: (clientId) => clientId === (options.deviceClientId ?? DEVICE_CLIENT_ID),
      }),
      // `bearer` maps an `Authorization: Bearer <session-token>` header onto the
      // session cookie, so CLI requests (`jsails whoami` → `/api/me`) reach
      // `resolveSessionFromRequest` through the same seam as browser cookies.
      bearer(),
      // Two-factor authentication (TOTP + backup codes). Opt-in; `false`/absent
      // leaves the plugin unmounted. The `two-factor` endpoints ride the
      // existing `ALL /api/auth/*` handler, so no extra route wiring is needed.
      ...(twoFactorOptions !== undefined
        ? [
            twoFactor(
              twoFactorOptions.issuer === undefined ? {} : { issuer: twoFactorOptions.issuer },
            ),
          ]
        : []),
      // Magic-link sign-in. Opt-in; `sendMagicLink` is required to deliver the
      // link (the plugin's `sendMagicLink` callback). The endpoint rides the
      // existing `ALL /api/auth/*` handler.
      ...(magicLinkOptions !== undefined
        ? [
            magicLink({
              ...(magicLinkOptions.expiresIn !== undefined
                ? { expiresIn: magicLinkOptions.expiresIn }
                : {}),
              sendMagicLink: async (data) => {
                if (options.sendMagicLink === undefined) {
                  throw new AuthInstanceError(
                    'missing_magic_link_sender',
                    'magic-link sign-in requires a sendMagicLink callback',
                  );
                }
                await options.sendMagicLink({ email: data.email, url: data.url });
              },
            }),
          ]
        : []),
    ],
  };

  const auth = betterAuth(betterAuthOptions);

  return attachDispose(auth, opened.destroy, onDisposed);
}

/**
 * Attach a non-enumerable, idempotent `dispose()` to an auth instance.
 *
 * The first call runs `onDispose` (releasing the underlying connection pool)
 * and then `clearMemo` (when given); every later call — including concurrent
 * calls that begin before the first resolves — returns the same promise, so the
 * pool is destroyed at most once. A rejecting `onDispose` is surfaced as a
 * value-free {@link AuthInstanceError} (`dispose_failed`).
 *
 * Exported from this module (not the `@jsails/auth` barrel) so tests can drive
 * disposal with a fake destroy function and no live database.
 */
export function attachDispose(
  auth: Auth,
  onDispose: () => Promise<void>,
  clearMemo?: () => void,
): DisposableAuth {
  let pending: Promise<void> | undefined;
  Object.defineProperty(auth, 'dispose', {
    configurable: true,
    enumerable: false,
    value: (): Promise<void> => {
      pending ??= (async () => {
        try {
          await onDispose();
        } catch {
          throw new AuthInstanceError(
            'dispose_failed',
            'failed to release the auth database connection pool',
          );
        }
        clearMemo?.();
      })();
      return pending;
    },
    writable: true,
  });
  return auth as DisposableAuth;
}

let cachedAuth: DisposableAuth | undefined;

/**
 * Build (once, lazily) and return the shared Better Auth instance.
 *
 * Importing this module reads no environment variable, creates no pool, and
 * does no database work; construction happens on the first `createAuth()` call
 * without options. This keeps the app config importable (and therefore
 * `jsails build` / static export working) without a database, while a live
 * request or an auth script still resolves the same memoized instance on
 * demand.
 *
 * With explicit {@link AuthBuildOptions}, a fresh instance is built instead
 * (never memoized), so the `auth` plugin can configure sign-up/reset behavior
 * per mount without mutating the shared instance.
 *
 * - `DATABASE_TYPE` — `mariadb` (default), `mysql`, or `postgres`.
 * - `DATABASE_HOST` / `DATABASE_USER` / `DATABASE_PASSWORD` / `DATABASE_NAME` —
 *   required connection variables (JSails reads them individually; there is no
 *   `DATABASE_URL`). A missing variable throws a value-free error naming only
 *   that variable. `DATABASE_PORT` defaults to 3306 (5432 for postgres).
 * - `BETTER_AUTH_SECRET` / `AUTH_SECRET` — passed straight through. Better Auth
 *   itself fails in production without a secret; JSails does not invent a
 *   fallback.
 * - `BETTER_AUTH_URL` — public base URL, default `http://localhost:3000`.
 */
export function createAuth(): Auth;
/** A fresh instance the caller owns; its `dispose()` releases its pool. */
export function createAuth(options: AuthBuildOptions): DisposableAuth;
export function createAuth(options?: AuthBuildOptions): Auth;
export function createAuth(options?: AuthBuildOptions): Auth {
  if (options !== undefined) {
    return createAuthInstance(options);
  }
  cachedAuth ??= createAuthInstance({}, () => {
    cachedAuth = undefined;
  });
  return cachedAuth;
}

/**
 * Release the shared memoized auth instance's connection pool, if one was
 * built. A no-op when the memo has never been built (there is no instance to
 * release).
 *
 * This is the seam the starter app config calls on shutdown: it takes no
 * arguments and cannot reach the service registry, so it can be wired into any
 * cleanup path. Disposal goes through the instance's own idempotent `dispose`,
 * and a successful disposal clears the memo so a later {@link createAuth}
 * builds a fresh instance.
 */
export async function disposeCachedAuth(): Promise<void> {
  const instance = cachedAuth;
  if (instance === undefined) {
    return;
  }
  await instance.dispose();
}

/**
 * Typed view of the device-flow endpoints registered by the device
 * authorization plugin.
 *
 * `betterAuth` is annotated with `BetterAuthOptions` (see `createAuth`), so
 * `auth.api` types only the built-in endpoints; the plugin registers its
 * endpoints at runtime but they are not reflected in `Auth<BetterAuthOptions>`.
 * {@link deviceApi} restores the checked types for the three endpoints the
 * auth plugin calls, in one place rather than a cast at each call site.
 */
export interface DeviceApi {
  deviceVerify(input: {
    query: { user_code: string };
    headers: HeadersInit;
  }): Promise<{ user_code: string; status: string; client_id?: string; scope?: string }>;
  deviceApprove(input: { body: { userCode: string }; headers: HeadersInit }): Promise<{
    success: boolean;
  }>;
  deviceDeny(input: { body: { userCode: string }; headers: HeadersInit }): Promise<{
    success: boolean;
  }>;
}

/** Access the device-flow endpoints with checked types (see {@link DeviceApi}). */
export function deviceApi(auth: Auth): DeviceApi {
  return auth.api as unknown as DeviceApi;
}

/** How a resolved session was authenticated, recorded as `session.data.authMethod`. */
export type SessionAuthMethod = 'cookie' | 'bearer' | 'api-token';

/** The token of an `Authorization: Bearer <token>` header, or `null`. */
function bearerCredential(headers: Headers): string | null {
  const match = /^Bearer[ \t]+(\S+)$/i.exec(headers.get('authorization')?.trim() ?? '');
  return match?.[1] ?? null;
}

/**
 * Map a Better Auth session (read from the request cookie, or from an
 * `Authorization: Bearer` header through the bearer plugin) to the JSails
 * {@link Session} shape, or `null` when the request is unauthenticated.
 *
 * `data` carries `user`, the user's `role` when one is assigned, and
 * `authMethod`. A header credential is resolved with Better Auth's sliding
 * refresh disabled: a bearer or API token expires when it was minted to,
 * however often it is used.
 */
export async function resolveSessionFromRequest(
  auth: Auth,
  request: Request,
): Promise<Session | null> {
  const bearer = bearerCredential(request.headers);
  const result = await auth.api.getSession({
    headers: request.headers,
    ...(bearer !== null ? { query: { disableRefresh: true } } : {}),
  });
  if (result === null) {
    return null;
  }

  const { session, user } = result;
  // The bearer plugin only replaces the cookie when the header verifies, so the
  // session came from the header exactly when its token is the header's.
  const fromHeader =
    bearer !== null && typeof session.token === 'string' && bearer.split('.')[0] === session.token;
  const authMethod: SessionAuthMethod = isApiTokenSession(session)
    ? 'api-token'
    : fromHeader
      ? 'bearer'
      : 'cookie';
  const role: unknown = (user as Record<string, unknown>).role;
  return {
    id: session.id,
    data: {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      ...(typeof role === 'string' && role !== '' ? { role } : {}),
      authMethod,
    },
    // Better Auth types this field as `Date`, but the API serializes it as an
    // ISO string; `new Date(...)` normalizes both to an epoch-millisecond number.
    expiresAt: new Date(session.expiresAt).getTime(),
  };
}

/** A Better Auth user as {@link findUserByEmail} returns it, with the plugin's `role` column. */
export type AuthUser = User & { readonly role?: string | null };

/**
 * The slice of Better Auth's internal adapter the user lookups need. It is
 * reached here, in one place, so scripts use the exported helpers instead of
 * Better Auth's internals.
 */
interface UserAdapter {
  findUserByEmail(email: string): Promise<{ user: AuthUser } | null>;
  updateUser(userId: string, data: { role: string | null }): Promise<unknown>;
}

async function userAdapter(auth: Auth): Promise<UserAdapter> {
  return (await auth.$context).internalAdapter;
}

/** Trim and lowercase an email the way Better Auth stores it, refusing a blank one. */
function lookupEmail(email: string, caller: string): string {
  if (typeof email !== 'string' || email.trim() === '') {
    throw new TypeError(`${caller} requires an email`);
  }
  return email.trim().toLowerCase();
}

/**
 * Look a user up by email (matched case-insensitively, as Better Auth stores
 * emails lowercased), or `null` when no account has it. Meant for trusted
 * scripts such as the starter's `user:create`; it is not a request surface and
 * performs no authorization.
 */
export async function findUserByEmail(auth: Auth, email: string): Promise<AuthUser | null> {
  const normalized = lookupEmail(email, 'findUserByEmail');
  const found = await (await userAdapter(auth)).findUserByEmail(normalized);
  return found === null ? null : found.user;
}

/**
 * Assign (or with `null`, clear) a user's role by email. This is the only
 * write path for the column: it is `input: false` to Better Auth's own
 * endpoints. Returns `false` when no user has that email. The change reaches
 * `session.data.role` on the user's next request.
 */
export async function setUserRole(
  auth: Auth,
  email: string,
  role: string | null,
): Promise<boolean> {
  const normalized = lookupEmail(email, 'setUserRole');
  if (role !== null && (typeof role !== 'string' || role.trim() === '')) {
    throw new TypeError('role must be a non-empty string or null');
  }
  const adapter = await userAdapter(auth);
  const found = await adapter.findUserByEmail(normalized);
  if (found === null) {
    return false;
  }
  await adapter.updateUser(found.user.id, { role: role === null ? null : role.trim() });
  return true;
}
