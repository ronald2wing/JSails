/**
 * The `auth` plugin: Better Auth (email/password + device authorization) over
 * MariaDB/MySQL, PostgreSQL, or SQLite (see {@link AuthPluginOptions.database}),
 * exposed as a {@link JsailsPlugin} named `auth`.
 *
 * `authPlugin(options)` returns a plugin whose `setup` (deferred until the
 * application assembles its extensions) lazily builds the Better Auth instance,
 * registers an {@link AuthSessionService} under {@link authSessionToken}, and
 * registers its HTTP surface through the plugin's registrar (`routes.add`):
 *
 * - `GET,POST /api/auth/*` — the Better Auth router, minus the endpoints that
 *   hand session tokens to page script, with three endpoints of it listed on
 *   their own because they read no cookie: the CLI's device-code request and
 *   token poll (`POST /api/auth/device/code`, `POST /api/auth/device/token`)
 *   and the OAuth callbacks (`GET,POST /api/auth/callback/:provider`, which a
 *   provider may post from its own origin);
 * - `POST /api/login` / `POST /api/logout` — email/password sign-in/out;
 * - `POST /api/device/approve` / `POST /api/device/deny` — RFC 8628 approval;
 * - `POST /api/register` — self-registration (only when `registration.enabled`);
 * - `POST /api/password-reset` / `POST /api/password-reset/confirm` — password
 *   reset (only when `passwordReset.enabled`, which requires `sendMail`);
 * - `POST /api/verification/send` — email verification (only when
 *   `verification.enabled`, which requires `sendMail`);
 * - `POST /api/tokens` / `GET /api/tokens` / `DELETE /api/tokens/:id` — the API
 *   token surface (only when `apiTokens.enabled`).
 *
 * Every route states its access: the sign-in, registration, reset and
 * verification forms and the Better Auth router are public (each endpoint
 * authenticates its caller itself); device approval and token management
 * admit only a browser (cookie) session. Every route but the three listed
 * Better Auth endpoints accepts the session cookie, so core's access chain
 * refuses an unsafe request to it from another origin, anonymous included,
 * before any handler runs; no handler checks an origin itself. The Better
 * Auth router is the one legacy surface left (SEC-13 replaces it).
 *
 * Importing the module (and even calling `authPlugin(...)`) reads no
 * environment variable and opens no connection — construction is deferred to
 * `setup` and performed through {@link createAuth}. Two options support testing
 * without a database: `createAuth` replaces the whole instance, and
 * `sessionResolver` replaces session resolution.
 *
 * The plugin declares Better Auth's tables as `schema.unmanagedTables` when
 * they may share the app database (no `database`, or the app's data source),
 * so `db:push` leaves them to `auth:migrate` instead of planning their drop.
 */

import type { Session } from 'jsails';
import { jsonError } from 'jsails/api';
import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import { publicAccess, type RouteAccess, type RouteContext } from 'jsails/kernel';
import type { SocialProviders } from 'better-auth/social-providers';

import { browserSession, createApiTokenHandlers } from './api-token-routes.js';
import {
  apiTokensToken,
  createApiTokenService,
  resolveApiTokensOptions,
  type ApiTokenService,
  type ApiTokensOptions,
} from './api-token-service.js';
import { createBetterAuthApiTokenStore } from './api-token-store.js';
import type { AuthDatabaseSource } from './auth-database.js';
import { authTableNames } from './auth-tables.js';
import {
  AuthInstanceError,
  createAuth,
  pluginToggle,
  resolveSessionFromRequest,
  type Auth,
  type AuthPoolOptions,
  type MagicLinkSender,
} from './better-auth.js';
import {
  createResetPasswordSender,
  createVerificationSender,
  handleRequestPasswordReset,
  handleResetPassword,
  handleSendVerificationEmail,
  type PasswordResetOptions,
  type SendMailFn,
  type VerificationOptions,
} from './password-reset.js';
import { handleRegister, type RegistrationOptions } from './registration.js';
import {
  createMemoryRateLimiter,
  rateLimitAllows,
  type RateLimitHook,
  type RateLimitRoute,
} from './rate-limit.js';
import {
  handleDeviceAction,
  handleLogin,
  handleLogout,
  rateLimitedResponse,
  withoutBearer,
  type AuthHandlerOptions,
} from './routes.js';
import { authSessionToken, type AuthSessionService } from './session-service.js';

/** Options for the login form surface. */
export interface LoginFormOptions {
  /**
   * Rate-limit gate for `POST /api/login` and the Better Auth sign-in
   * endpoints (email, magic link and its verification, two-factor codes, email
   * OTP); a non-`true` (or throwing) result yields a generic 429. Defaults to
   * an in-memory limiter of 10 attempts per 15 minutes per normalized email
   * and client address; `false` turns throttling off.
   */
  readonly rateLimit?: RateLimitHook | false;
}

/** A Better Auth router endpoint governed by one of the plugin's rate limits. */
interface ThrottledEndpoint {
  readonly method: 'GET' | 'POST';
  readonly route: RateLimitRoute;
}

/**
 * The Better Auth router endpoints that take a credential, a one-time secret,
 * or send mail, mapped to the surface whose rate limit governs them, so the
 * `/api/auth/*` twin of a JSails form route is throttled exactly like the form
 * route. An endpoint whose body carries no email is still counted, against
 * the client address. Endpoints of plugins this package does not mount (email
 * OTP) are listed too, so mounting one later cannot leave it unthrottled; an
 * endpoint this table does not name is limited only by Better Auth's own
 * coarse limiter.
 */
const BETTER_AUTH_THROTTLED: Readonly<Record<string, ThrottledEndpoint>> = {
  '/sign-in/email': { method: 'POST', route: 'login' },
  '/sign-in/magic-link': { method: 'POST', route: 'magic-link' },
  '/magic-link/verify': { method: 'GET', route: 'magic-link-verify' },
  '/sign-up/email': { method: 'POST', route: 'register' },
  '/request-password-reset': { method: 'POST', route: 'password-reset' },
  '/reset-password': { method: 'POST', route: 'password-reset-confirm' },
  '/send-verification-email': { method: 'POST', route: 'verification' },
  '/two-factor/verify-totp': { method: 'POST', route: 'two-factor' },
  '/two-factor/verify-backup-code': { method: 'POST', route: 'two-factor' },
  '/two-factor/verify-otp': { method: 'POST', route: 'two-factor' },
  '/two-factor/send-otp': { method: 'POST', route: 'two-factor' },
  '/sign-in/email-otp': { method: 'POST', route: 'email-otp' },
  '/email-otp/verify-email': { method: 'POST', route: 'email-otp' },
  '/email-otp/check-verification-otp': { method: 'POST', route: 'email-otp' },
  '/email-otp/reset-password': { method: 'POST', route: 'email-otp' },
  '/email-otp/send-verification-otp': { method: 'POST', route: 'email-otp' },
  '/email-otp/request-password-reset': { method: 'POST', route: 'email-otp' },
  '/email-otp/request-email-change': { method: 'POST', route: 'email-otp' },
  '/email-otp/change-email': { method: 'POST', route: 'email-otp' },
  '/forget-password/email-otp': { method: 'POST', route: 'email-otp' },
  // A session holder's current-password checks: with a stolen cookie or an
  // XSS each is an oracle for the password, so it is counted like a sign-in.
  '/verify-password': { method: 'POST', route: 'login' },
  '/change-password': { method: 'POST', route: 'login' },
  '/delete-user': { method: 'POST', route: 'login' },
  '/two-factor/enable': { method: 'POST', route: 'login' },
  '/two-factor/disable': { method: 'POST', route: 'login' },
  '/two-factor/get-totp-uri': { method: 'POST', route: 'login' },
  '/two-factor/generate-backup-codes': { method: 'POST', route: 'login' },
};

/**
 * Router endpoints that answer with other sessions' bearer tokens (Better
 * Auth's session token is a bearer credential through the `bearer` plugin, and
 * an API token is a session row) or revoke a session by its raw token. Page
 * script could read the former, so a single XSS would lift every session the
 * user holds; they are answered 404. Server code still reaches them through
 * `auth.api`.
 */
const BETTER_AUTH_HIDDEN: ReadonlySet<string> = new Set([
  '/list-sessions',
  '/multi-session/list-device-sessions',
  '/revoke-session',
  '/multi-session/revoke',
]);

/**
 * The one router endpoint whose token is meant for its caller: the CLI polls
 * it for the session token the device flow grants. Every other JSON response
 * has its session token removed (see {@link withoutSessionTokens}).
 */
const DEVICE_TOKEN_PATH = '/device/token';

/** Better Auth's router mount point. */
const BETTER_AUTH_BASE_PATH = '/api/auth';

/** The router-relative path, without the trailing slashes the router ignores. */
function routerPath(request: Request): string {
  return new URL(request.url).pathname.slice(BETTER_AUTH_BASE_PATH.length).replace(/\/+$/, '');
}

/** Matches the media types Better Auth's body parser reads as JSON. */
const JSON_MEDIA_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;

/**
 * The `email` field of the body, parsed the way Better Auth's own parser
 * (better-call `getBody`) will parse it, so the limiter keys on exactly the
 * address the endpoint acts on: a JSON media type first, then a urlencoded or
 * multipart form, judged on the same lowercased `Content-Type`. The original
 * request is left unconsumed. `null` when the body names no email.
 */
async function bodyEmail(request: Request): Promise<string | null> {
  if (request.body === null) {
    return null;
  }
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  try {
    if (JSON_MEDIA_TYPE.test(type)) {
      const parsed: unknown = await request.clone().json();
      if (typeof parsed === 'object' && parsed !== null && 'email' in parsed) {
        return typeof parsed.email === 'string' ? parsed.email : null;
      }
      return null;
    }
    if (
      type.includes('application/x-www-form-urlencoded') ||
      type.includes('multipart/form-data')
    ) {
      const email = (await request.clone().formData()).get('email');
      return typeof email === 'string' ? email : null;
    }
  } catch {
    // An unreadable body names no email; the attempt is still counted against
    // the client address, and Better Auth rejects the body itself.
  }
  return null;
}

/** A copy of a JSON value without the session token Better Auth includes in it. */
function redactSessionToken(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const { token: _token, ...rest } = value as Record<string, unknown>;
  const session = rest['session'];
  if (typeof session === 'object' && session !== null && !Array.isArray(session)) {
    const { token: _sessionToken, ...sessionRest } = session as Record<string, unknown>;
    rest['session'] = sessionRest;
  }
  return rest;
}

/**
 * The router response without the session token: the `token` (and
 * `session.token`) of a JSON body from `get-session`, the sign-in endpoints,
 * and anything else that echoes it, and the `bearer` plugin's
 * `set-auth-token` header. The session cookie is `HttpOnly` precisely so page
 * script cannot read it; a token in a readable response would undo that.
 */
async function withoutSessionTokens(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.delete('set-auth-token');
  const exposed = headers.get('access-control-expose-headers');
  if (exposed !== null) {
    const kept = exposed
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '' && name.toLowerCase() !== 'set-auth-token');
    if (kept.length === 0) headers.delete('access-control-expose-headers');
    else headers.set('access-control-expose-headers', kept.join(', '));
  }
  const init = { status: response.status, statusText: response.statusText, headers };
  if (response.body === null || !JSON_MEDIA_TYPE.test(headers.get('content-type') ?? '')) {
    return new Response(response.body, init);
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(text, init);
  }
  headers.delete('content-length');
  return new Response(JSON.stringify(redactSessionToken(parsed)), init);
}

/** Options for {@link authPlugin}. */
export interface AuthPluginOptions {
  /** Better Auth public base URL; falls back to `BETTER_AUTH_URL` then localhost. */
  readonly baseUrl?: string;
  /** Better Auth signing secret; falls back to `BETTER_AUTH_SECRET` / `AUTH_SECRET`. */
  readonly secret?: string;
  /** RFC 8628 client id allowed to use the device flow; defaults to `jsails-cli`. */
  readonly deviceClientId?: string;
  /**
   * Replace the whole Better Auth construction (tests, custom backends). The
   * instance must already carry the policy the plugin would set: a
   * `databaseHooks.user.create.before` refusal while registration is closed,
   * and with email/password enabled, sign-up disabled unless
   * `registration.enabled`, a reset sender and session revocation when
   * `passwordReset.enabled`. One that does not is refused on first use rather
   * than run open.
   */
  readonly createAuth?: () => Auth;
  /**
   * Replace session resolution: receives the request and a getter for the
   * plugin's instance, which builds it (and reads its database settings) only
   * when called.
   */
  readonly sessionResolver?: (request: Request, auth: () => Auth) => Promise<Session | null>;
  /** Mail delivery seam for password reset and verification emails. */
  readonly sendMail?: SendMailFn;
  /** Login form surface (`POST /api/login`). */
  readonly login?: LoginFormOptions;
  /** Self-registration surface. */
  readonly registration?: RegistrationOptions;
  /** Password-reset surface. */
  readonly passwordReset?: PasswordResetOptions;
  /** Email-verification surface. */
  readonly verification?: VerificationOptions;
  /** Two-factor authentication (TOTP + backup codes): an options object turns it on; `false` or unset leaves it off. */
  readonly twoFactor?: false | { readonly issuer?: string };
  /** Magic-link sign-in: an options object turns it on; `false` or unset leaves it off. */
  readonly magicLink?: false | { readonly expiresIn?: number };
  /** Deliver a magic link (email + URL). */
  readonly sendMagicLink?: MagicLinkSender;
  /** Social (OAuth) provider configs, keyed by provider id (`google`, `github`, …). */
  readonly socialProviders?: SocialProviders;
  /** API-token surface (store + service + `/api/tokens` routes). Disabled by default. */
  readonly apiTokens?: ApiTokensOptions;
  /** Add and project the user `role` column (see `AuthBuildOptions.roles`). Defaults to `true`. */
  readonly roles?: boolean;
  /** Signed session cookie cache (see `AuthBuildOptions.cookieCache`). Off by default. */
  readonly sessionCookieCache?: { readonly maxAge: number };
  /** Auth database pool sizing (see `AuthBuildOptions.pool`); bounded by default. */
  readonly databasePool?: AuthPoolOptions;
  /**
   * The database Better Auth's tables live in (see `AuthBuildOptions.database`):
   * the app's `JsailsDataSource`, whose connection options are reused for the
   * auth pool, or an explicit config such as `{ type: 'sqlite', location }`.
   * Unset, the `DATABASE_*` environment variables decide.
   */
  readonly database?: AuthDatabaseSource;
}

/**
 * The rate-limit key for a request: the bucket of the client core resolved
 * (from the socket peer and only the forwarding headers `server.trustedProxies`
 * vouches for), or `null` when the client is unknown. The plugin never reads a
 * forwarding header itself.
 */
function clientBucket(context: RouteContext): string | null {
  const client = context.client;
  return client === undefined || client.via === 'unknown' ? null : client.bucket;
}

/** The largest form an auth route reads (sign-in, registration, reset, device approval). */
const FORM_BODY_BYTES = 64 * 1024;

/** The largest JSON body `POST /api/tokens` reads. */
const TOKEN_BODY_BYTES = 16 * 1024;

const FORM_BODY = { kind: 'form', maxBytes: FORM_BODY_BYTES } as const;

/**
 * Whether the auth tables may live in the app database: with no `database` the
 * shared `DATABASE_*` variables decide, and a data source is the app's own. An
 * explicit config (one with a `type`) names a database of its own.
 */
function mayShareAppDatabase(database: AuthDatabaseSource | undefined): boolean {
  return database === undefined || typeof database !== 'object' || !('type' in database);
}

/** Return the configured mail seam, or throw a value-free error when absent. */
function requiredSendMail(options: AuthPluginOptions): SendMailFn {
  if (options.sendMail === undefined) {
    throw new TypeError('password reset and email verification require a sendMail callback');
  }
  return options.sendMail;
}

/**
 * Build the `auth` plugin. The returned plugin is inert: nothing is constructed
 * or connected until its `setup` runs during application assembly.
 */
export function authPlugin(options: AuthPluginOptions = {}): JsailsPlugin {
  const registrationEnabled = options.registration?.enabled === true;
  const passwordResetEnabled = options.passwordReset?.enabled === true;
  const verificationEnabled = options.verification?.enabled === true;
  const apiTokensOptions = resolveApiTokensOptions(options.apiTokens);
  const revokeSessionsOnReset = options.passwordReset?.revokeSessions !== false;
  const twoFactor = pluginToggle(options.twoFactor, 'twoFactor');
  const magicLink = pluginToggle(options.magicLink, 'magicLink');

  // Throttling is on unless a surface opts out with `false`; every surface
  // without its own hook shares one limiter, whose keys are per surface.
  const defaultLimiter = createMemoryRateLimiter();
  const limiterFor = (hook: RateLimitHook | false | undefined): RateLimitHook | undefined =>
    hook === false ? undefined : (hook ?? defaultLimiter);
  const limiters: Readonly<Record<RateLimitRoute, RateLimitHook | undefined>> = {
    login: limiterFor(options.login?.rateLimit),
    'magic-link': limiterFor(options.login?.rateLimit),
    'magic-link-verify': limiterFor(options.login?.rateLimit),
    'two-factor': limiterFor(options.login?.rateLimit),
    'email-otp': limiterFor(options.login?.rateLimit),
    register: limiterFor(options.registration?.rateLimit),
    'password-reset': limiterFor(options.passwordReset?.rateLimit),
    'password-reset-confirm': limiterFor(options.passwordReset?.rateLimit),
    verification: limiterFor(options.verification?.rateLimit),
  };

  // Fail closed at construction: reset/verification cannot deliver mail without
  // a send seam, so refuse the config rather than mounting a broken surface.
  if (passwordResetEnabled || verificationEnabled) {
    requiredSendMail(options);
  }

  // The policy is passed into `betterAuth()` at construction, so it holds for
  // every endpoint from the first request and does not depend on how Better
  // Auth shares its options object internally.
  const defaultCreateAuth = (): Auth =>
    createAuth({
      secret: options.secret,
      baseUrl: options.baseUrl,
      deviceClientId: options.deviceClientId,
      twoFactor,
      magicLink,
      sendMagicLink: options.sendMagicLink,
      socialProviders: options.socialProviders,
      roles: options.roles,
      cookieCache: options.sessionCookieCache,
      pool: options.databasePool,
      database: options.database,
      ...(verificationEnabled
        ? { sendVerificationEmail: createVerificationSender(requiredSendMail(options)) }
        : {}),
      emailAndPassword: {
        // Self-sign-up is opt-in. With it on, sign-up creates no session, so a
        // duplicate email is answered generically rather than leaking which
        // addresses exist.
        disableSignUp: !registrationEnabled,
        ...(registrationEnabled ? { autoSignIn: false } : {}),
        revokeSessionsOnPasswordReset: revokeSessionsOnReset,
        ...(passwordResetEnabled
          ? { sendResetPassword: createResetPasswordSender(requiredSendMail(options)) }
          : {}),
      },
    });

  /**
   * Refuse an injected instance that would run more openly than the plugin's
   * own: the options decide which surfaces exist, so an instance contradicting
   * them fails closed instead of exposing sign-up or a mail-less reset.
   */
  const assertInjectedPolicy = (auth: Auth): void => {
    const injectedOptions = (auth as { options?: Auth['options'] }).options;
    // Verification mail is wired at construction; an instance built without a
    // sender would answer the verification surface with nothing sent.
    if (
      verificationEnabled &&
      injectedOptions?.emailVerification?.sendVerificationEmail === undefined
    ) {
      throw new AuthInstanceError(
        'unsafe_instance',
        'the injected auth instance does not send verification email',
      );
    }
    // Closed registration must close user creation itself: magic links,
    // email OTP and social providers create the account on first sign-in,
    // which `disableSignUp` does not govern. A real instance that does not
    // refuse creation in a hook (as `createAuth` does) leaves those open.
    if (
      injectedOptions !== undefined &&
      !registrationEnabled &&
      typeof injectedOptions.databaseHooks?.user?.create?.before !== 'function'
    ) {
      throw new AuthInstanceError(
        'unsafe_instance',
        'the injected auth instance does not refuse user creation while registration is closed',
      );
    }
    const policy = injectedOptions?.emailAndPassword;
    if (policy?.enabled !== true) {
      return;
    }
    const open =
      (!registrationEnabled && policy.disableSignUp !== true) ||
      (registrationEnabled && policy.autoSignIn !== false) ||
      (passwordResetEnabled && policy.sendResetPassword === undefined) ||
      (revokeSessionsOnReset && policy.revokeSessionsOnPasswordReset !== true);
    if (open) {
      throw new AuthInstanceError(
        'unsafe_instance',
        'the injected auth instance does not match the plugin email/password policy',
      );
    }
  };

  return definePlugin({
    name: 'auth',
    describe: () => ({ needsLive: true }),
    ...(mayShareAppDatabase(options.database)
      ? { schema: { unmanagedTables: authTableNames({ twoFactor }) } }
      : {}),
    async setup({ services, routes }) {
      // The Better Auth instance is built lazily, on the first `getAuth()` call
      // (the first live request or the first consumer to resolve a session), so
      // a static export — and any app that never serves auth traffic — builds
      // with no database. `options.createAuth` (the test seam) is deferred the
      // same way; nothing here reads an environment variable or opens a pool
      // until `getAuth()` runs.
      let authInstance: Auth | undefined;
      const getAuth = (): Auth => {
        if (authInstance === undefined) {
          if (options.createAuth === undefined) {
            authInstance = defaultCreateAuth();
          } else {
            const injected = options.createAuth();
            assertInjectedPolicy(injected);
            authInstance = injected;
          }
        }
        return authInstance;
      };

      // One cookie-session lookup per request serves the route gate, the
      // handler and every consumer; the WeakMap lets the entry go with the
      // request.
      const cookieSessions = new WeakMap<Request, Promise<Session | null>>();
      const resolveCookieSession: AuthSessionService['resolveSession'] = (request) => {
        let pending = cookieSessions.get(request);
        if (pending === undefined) {
          pending =
            options.sessionResolver !== undefined
              ? options.sessionResolver(request, getAuth)
              : resolveSessionFromRequest(getAuth(), request);
          cookieSessions.set(request, pending);
        }
        return pending;
      };

      let apiTokenService: ApiTokenService | undefined;
      if (apiTokensOptions.enabled) {
        const store = options.apiTokens?.store ?? createBetterAuthApiTokenStore(getAuth());
        apiTokenService = createApiTokenService({
          store,
          cookieSession: resolveCookieSession,
          headerName: apiTokensOptions.headerName,
          expiresInDays: apiTokensOptions.expiresInDays,
        });
        services.provide(apiTokensToken, apiTokenService);
      }

      // When tokens are enabled the session resolver also accepts a valid token
      // as a fallback after the cookie session fails to resolve; otherwise it is
      // cookie-only.
      // Core's identity resolution, this plugin's routes, and every `authSessionToken`
      // consumer resolve the same Request; one lookup per request serves them
      // all. The WeakMap lets the entry go with the request.
      const resolved = new WeakMap<Request, Promise<Session | null>>();
      const resolveSession: AuthSessionService['resolveSession'] = (request) => {
        let pending = resolved.get(request);
        if (pending === undefined) {
          pending =
            apiTokenService !== undefined
              ? apiTokenService.resolveSessionWithApiToken(request)
              : resolveCookieSession(request);
          resolved.set(request, pending);
        }
        return pending;
      };

      services.provide(authSessionToken, { getAuth, resolveSession });

      /** Handler options for one request; `auth` is resolved lazily per call. */
      const handlerOptions = (
        context: RouteContext,
        rateLimit?: RateLimitHook,
      ): AuthHandlerOptions => ({
        auth: getAuth(),
        rateLimit,
        clientAddress: rateLimit === undefined ? null : clientBucket(context),
      });

      /**
       * The access of device approval and token management: a browser
       * session, resolved from the cookie alone, so an API or CLI token never
       * reaches them.
       */
      const cookieSessionOf = browserSession(resolveCookieSession);
      const signedIn: RouteAccess = async (context) =>
        (await cookieSessionOf(context.request)) !== null;

      /**
       * The Better Auth router, reachable only as a browser surface: the
       * `Authorization` header is stripped so an API or CLI token can never act
       * as a session here (update the user, approve a device code). Credential
       * endpoints pass the same rate limit as their JSails form twins, and
       * Better Auth's own limiter reads the one `X-Forwarded-For` value core's
       * first stage left on the request, never one the client sent. Endpoints that would show
       * page script a session token are hidden or redacted.
       */
      const betterAuthRouter = async (context: RouteContext): Promise<Response> => {
        const request = context.request;
        const path = routerPath(request);
        if (BETTER_AUTH_HIDDEN.has(path)) {
          return jsonError(404, 'not_found', 'Not Found');
        }
        const address = clientBucket(context);
        const throttled = BETTER_AUTH_THROTTLED[path];
        const limiter =
          throttled === undefined || throttled.method !== request.method
            ? undefined
            : limiters[throttled.route];
        if (throttled !== undefined && limiter !== undefined) {
          const allowed = await rateLimitAllows(limiter, await bodyEmail(request), {
            ip: address,
            route: throttled.route,
            request,
          });
          if (!allowed) {
            return rateLimitedResponse();
          }
        }
        const headers = withoutBearer(new Headers(request.headers));
        const response = await getAuth().handler(new Request(request, { headers }));
        return path === DEVICE_TOKEN_PATH ? response : withoutSessionTokens(response);
      };

      // The Better Auth endpoints a non-browser caller or another origin must
      // reach read no cookie of core's (`credentials: []`), so the cross-site
      // check does not run for them: the CLI's device flow sends no Origin,
      // and a provider may post an OAuth callback from its own origin. They
      // are listed before the router's catch-all so they answer first.
      routes.add({
        methods: ['POST'],
        path: `${BETTER_AUTH_BASE_PATH}/device/code`,
        access: publicAccess('RFC 8628 device code request from the CLI (Better Auth)'),
        credentials: [],
        handler: betterAuthRouter,
      });
      routes.add({
        methods: ['POST'],
        path: `${BETTER_AUTH_BASE_PATH}${DEVICE_TOKEN_PATH}`,
        access: publicAccess('RFC 8628 token poll from the CLI (Better Auth)'),
        credentials: [],
        handler: betterAuthRouter,
      });
      routes.add({
        methods: ['GET', 'POST'],
        path: `${BETTER_AUTH_BASE_PATH}/callback/:provider`,
        access: publicAccess('OAuth provider callback; Better Auth verifies its state'),
        credentials: [],
        handler: betterAuthRouter,
      });
      routes.add({
        methods: ['GET', 'POST'],
        path: `${BETTER_AUTH_BASE_PATH}/*`,
        access: publicAccess(
          'Better Auth router (legacy surface until SEC-13); each endpoint authenticates its caller',
        ),
        handler: betterAuthRouter,
      });
      routes.add({
        methods: ['POST'],
        path: '/api/login',
        access: publicAccess('email and password sign-in form'),
        body: FORM_BODY,
        handler: (context) => handleLogin(context.request, handlerOptions(context, limiters.login)),
      });
      routes.add({
        methods: ['POST'],
        path: '/api/logout',
        access: publicAccess('sign-out; without a session it only redirects'),
        body: FORM_BODY,
        handler: (context) => handleLogout(context.request, handlerOptions(context)),
      });
      for (const path of ['/api/device/approve', '/api/device/deny']) {
        routes.add({
          methods: ['POST'],
          path,
          access: signedIn,
          body: FORM_BODY,
          handler: (context) => handleDeviceAction(context.request, handlerOptions(context)),
        });
      }
      if (apiTokenService !== undefined) {
        const tokens = createApiTokenHandlers({
          service: apiTokenService,
          resolveSession: resolveCookieSession,
        });
        routes.add({
          methods: ['POST'],
          path: '/api/tokens',
          access: signedIn,
          body: { kind: 'json', maxBytes: TOKEN_BODY_BYTES },
          handler: (context) => tokens.create(context.request),
        });
        routes.add({
          methods: ['GET'],
          path: '/api/tokens',
          access: signedIn,
          handler: (context) => tokens.list(context.request),
        });
        routes.add({
          methods: ['DELETE'],
          path: '/api/tokens/:id',
          access: signedIn,
          handler: (context) => tokens.remove(context.request, context.params['id'] ?? ''),
        });
      }
      if (registrationEnabled) {
        routes.add({
          methods: ['POST'],
          path: '/api/register',
          access: publicAccess('self-registration form'),
          body: FORM_BODY,
          handler: (context) =>
            handleRegister(context.request, handlerOptions(context, limiters.register)),
        });
      }
      if (passwordResetEnabled) {
        routes.add({
          methods: ['POST'],
          path: '/api/password-reset',
          access: publicAccess('password reset request form'),
          body: FORM_BODY,
          handler: (context) =>
            handleRequestPasswordReset(
              context.request,
              handlerOptions(context, limiters['password-reset']),
            ),
        });
        routes.add({
          methods: ['POST'],
          path: '/api/password-reset/confirm',
          access: publicAccess('password reset form; the single-use token authorizes it'),
          body: FORM_BODY,
          handler: (context) =>
            handleResetPassword(
              context.request,
              handlerOptions(context, limiters['password-reset-confirm']),
            ),
        });
      }
      if (verificationEnabled) {
        routes.add({
          methods: ['POST'],
          path: '/api/verification/send',
          access: publicAccess('verification email request form'),
          body: FORM_BODY,
          handler: (context) =>
            handleSendVerificationEmail(
              context.request,
              handlerOptions(context, limiters.verification),
            ),
        });
      }

      // Release the Better Auth connection pool on shutdown so an open pool
      // socket never keeps the process alive after `close()`. The instance is
      // built lazily, so this no-ops when it was never constructed; the
      // structural guard also no-ops for an injected test fake without `dispose`.
      return async () => {
        const instance = authInstance;
        if (
          instance !== undefined &&
          'dispose' in instance &&
          typeof instance.dispose === 'function'
        ) {
          await instance.dispose();
        }
      };
    },
  });
}
