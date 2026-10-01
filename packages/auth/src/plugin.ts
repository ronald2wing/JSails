/**
 * The `auth` plugin: Better Auth (email/password + device authorization) over
 * MariaDB, exposed as a {@link JsailsPlugin} named `auth`.
 *
 * `authPlugin(options)` returns a plugin whose `setup` (deferred until the
 * application assembles its extensions) lazily builds the Better Auth instance,
 * registers an {@link AuthSessionService} under {@link authSessionToken}, and
 * mounts the trusted HTTP surface:
 *
 * - `ALL /api/auth/*` — the Better Auth handler (its own origin/CSRF checks);
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
 * Those are trusted hook routes, not filesystem API routes: they bypass the
 * filesystem default-deny `authorize` and the session CSRF middleware so a
 * plain form POST works while a session cookie is present; each handler owns
 * its same-origin check (see {@link AuthPluginOptions.publicOrigin}).
 *
 * Importing the module (and even calling `authPlugin(...)`) reads no
 * environment variable and opens no connection — construction is deferred to
 * `setup` and performed through {@link createAuth}. Two options support testing
 * without a database: `createAuth` replaces the whole instance, and
 * `sessionResolver` replaces session resolution.
 */

import type { Session } from 'jsails';
import { definePlugin, type JsailsPlugin } from 'jsails/extensions';
import type { SocialProviders } from 'better-auth/social-providers';

import { createApiTokenHandlers } from './api-token-routes.js';
import {
  apiTokensToken,
  createApiTokenService,
  resolveApiTokensOptions,
  type ApiTokenService,
  type ApiTokensOptions,
} from './api-token-service.js';
import { createBetterAuthApiTokenStore } from './api-token-store.js';
import {
  AuthInstanceError,
  authSecret,
  createAuth,
  resolveSessionFromRequest,
  type Auth,
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
  socketAddress,
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
   * Rate-limit gate for `POST /api/login`, `/api/auth/sign-in/email`, and
   * `/api/auth/sign-in/magic-link`; a non-`true` (or throwing) result yields a
   * generic 429. Defaults to an in-memory limiter of 10 attempts per 15 minutes
   * per normalized email and client address; `false` turns throttling off.
   */
  readonly rateLimit?: RateLimitHook | false;
}

/**
 * The Better Auth router endpoints that take a credential or send mail, mapped
 * to the surface whose rate limit governs them, so the `/api/auth/*` twin of a
 * JSails form route is throttled exactly like the form route.
 */
const BETTER_AUTH_THROTTLED: Readonly<Record<string, RateLimitRoute>> = {
  '/sign-in/email': 'login',
  '/sign-in/magic-link': 'magic-link',
  '/sign-up/email': 'register',
  '/request-password-reset': 'password-reset',
  '/forget-password': 'password-reset',
  '/send-verification-email': 'verification',
};

/** Better Auth's router mount point. */
const BETTER_AUTH_BASE_PATH = '/api/auth';

/** The `email` field of a JSON or form body, without consuming the original request. */
async function bodyEmail(request: Request): Promise<string | null> {
  const type = request.headers.get('content-type') ?? '';
  try {
    if (
      type.includes('application/x-www-form-urlencoded') ||
      type.includes('multipart/form-data')
    ) {
      const email = (await request.clone().formData()).get('email');
      return typeof email === 'string' ? email : null;
    }
    const parsed: unknown = await request.clone().json();
    if (typeof parsed === 'object' && parsed !== null && 'email' in parsed) {
      return typeof parsed.email === 'string' ? parsed.email : null;
    }
  } catch {
    // An unreadable body carries no email to key on; Better Auth rejects it.
  }
  return null;
}

/** Options for {@link authPlugin}. */
export interface AuthPluginOptions {
  /** Same-origin boundary for the login/logout/device handlers; `undefined` falls back to each request's own origin. */
  readonly publicOrigin?: string;
  /** Better Auth public base URL; falls back to `BETTER_AUTH_URL` then localhost. */
  readonly baseUrl?: string;
  /** Better Auth signing secret (also keys the per-session CSRF token); falls back to `BETTER_AUTH_SECRET` / `AUTH_SECRET`. */
  readonly secret?: string;
  /** RFC 8628 client id allowed to use the device flow; defaults to `jsails-cli`. */
  readonly deviceClientId?: string;
  /**
   * Replace the whole Better Auth construction (tests, custom backends). An
   * instance with email/password enabled must already carry the policy the
   * plugin would set (sign-up disabled unless `registration.enabled`, a reset
   * sender and session revocation when `passwordReset.enabled`); one that does
   * not is refused on first use rather than run open.
   */
  readonly createAuth?: () => Auth;
  /** Replace session resolution; receives the plugin's instance and the request. */
  readonly sessionResolver?: (auth: Auth, request: Request) => Promise<Session | null>;
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
  /** Two-factor authentication (TOTP + backup codes). */
  readonly twoFactor?: boolean | { readonly issuer?: string };
  /** Magic-link sign-in. */
  readonly magicLink?: boolean | { readonly expiresIn?: number };
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
  /**
   * The client address rate limits key on. Defaults to the socket peer
   * address; behind a reverse proxy, read the proxy's trusted forwarding
   * header here instead, or every client shares the proxy's address.
   */
  readonly clientAddress?: (request: Request) => string | null;
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
  if (options.clientAddress !== undefined && typeof options.clientAddress !== 'function') {
    throw new TypeError('clientAddress must be a function');
  }

  // Throttling is on unless a surface opts out with `false`; every surface
  // without its own hook shares one limiter, whose keys are per surface.
  const defaultLimiter = createMemoryRateLimiter();
  const limiterFor = (hook: RateLimitHook | false | undefined): RateLimitHook | undefined =>
    hook === false ? undefined : (hook ?? defaultLimiter);
  const limiters: Readonly<Record<RateLimitRoute, RateLimitHook | undefined>> = {
    login: limiterFor(options.login?.rateLimit),
    'magic-link': limiterFor(options.login?.rateLimit),
    register: limiterFor(options.registration?.rateLimit),
    'password-reset': limiterFor(options.passwordReset?.rateLimit),
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
      twoFactor: options.twoFactor,
      magicLink: options.magicLink,
      sendMagicLink: options.sendMagicLink,
      socialProviders: options.socialProviders,
      roles: options.roles,
      cookieCache: options.sessionCookieCache,
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
    const policy = (auth as { options?: Auth['options'] }).options?.emailAndPassword;
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
    async setup({ services, configureHttp }) {
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
          // `emailVerification` is absent from the options Better Auth is built
          // with, so it must be attached to the resolved context's options (a
          // shallow clone) — the endpoints read that, not `auth.options`. Doing
          // it here (on first build, lazily) keeps construction inert: a static
          // `jsails build` assembles the plugin without ever building the
          // instance or requiring a database.
          if (verificationEnabled) {
            void authInstance.$context.then((context) => {
              context.options.emailVerification = {
                sendVerificationEmail: createVerificationSender(requiredSendMail(options)),
              };
            });
          }
        }
        return authInstance;
      };

      // Resolved per call, never at construction: setup reads no environment.
      const secret = (): string | undefined => options.secret ?? authSecret();

      const resolveCookieSession: AuthSessionService['resolveSession'] = (request) =>
        options.sessionResolver !== undefined
          ? options.sessionResolver(getAuth(), request)
          : resolveSessionFromRequest(getAuth(), request, secret());

      let apiTokenService: ApiTokenService | undefined;
      if (apiTokensOptions.enabled) {
        const store = options.apiTokens?.store ?? createBetterAuthApiTokenStore(getAuth());
        apiTokenService = createApiTokenService({
          store,
          cookieSession: resolveCookieSession,
          secret: options.secret,
          headerName: apiTokensOptions.headerName,
          expiresInDays: apiTokensOptions.expiresInDays,
        });
        services.provide(apiTokensToken, apiTokenService);
      }

      // When tokens are enabled the session resolver also accepts a valid token
      // as a fallback after the cookie session fails to resolve; otherwise it is
      // cookie-only.
      // Core's session middleware, hook routes, and every `authSessionToken`
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

      const clientAddress = (request: Request, env: unknown): string | null =>
        options.clientAddress !== undefined ? options.clientAddress(request) : socketAddress(env);

      /** Handler options for one request; `auth` is resolved lazily per call. */
      const handlerOptions = (
        request: Request,
        env: unknown,
        rateLimit?: RateLimitHook,
      ): AuthHandlerOptions => ({
        auth: getAuth(),
        publicOrigin: options.publicOrigin,
        rateLimit,
        clientAddress: rateLimit === undefined ? null : clientAddress(request, env),
      });

      /**
       * The Better Auth router, reachable only as a browser surface: the
       * `Authorization` header is stripped so an API or CLI token can never act
       * as a session here (update the user, list or revoke sessions, approve a
       * device code). Credential endpoints pass the same rate limit as their
       * JSails form twins.
       */
      const betterAuthRouter = async (request: Request, env: unknown): Promise<Response> => {
        const path = new URL(request.url).pathname.slice(BETTER_AUTH_BASE_PATH.length);
        const route = request.method === 'POST' ? BETTER_AUTH_THROTTLED[path] : undefined;
        const limiter = route === undefined ? undefined : limiters[route];
        if (route !== undefined && limiter !== undefined) {
          const email = await bodyEmail(request);
          if (
            email !== null &&
            !(await rateLimitAllows(limiter, email, {
              ip: clientAddress(request, env),
              route,
              request,
            }))
          ) {
            return rateLimitedResponse();
          }
        }
        if (!request.headers.has('authorization')) {
          return getAuth().handler(request);
        }
        return getAuth().handler(new Request(request, { headers: withoutBearer(request.headers) }));
      };

      configureHttp((app) => {
        app.all(`${BETTER_AUTH_BASE_PATH}/*`, (c) => betterAuthRouter(c.req.raw, c.env));
        app.post('/api/login', (c) =>
          handleLogin(c.req.raw, handlerOptions(c.req.raw, c.env, limiters.login)),
        );
        app.post('/api/logout', (c) => handleLogout(c.req.raw, handlerOptions(c.req.raw, c.env)));
        app.post('/api/device/approve', (c) =>
          handleDeviceAction(c.req.raw, handlerOptions(c.req.raw, c.env)),
        );
        app.post('/api/device/deny', (c) =>
          handleDeviceAction(c.req.raw, handlerOptions(c.req.raw, c.env)),
        );
        if (apiTokenService !== undefined) {
          const tokenHandlers = createApiTokenHandlers({
            service: apiTokenService,
            resolveSession: resolveCookieSession,
            publicOrigin: options.publicOrigin,
          });
          app.post('/api/tokens', (c) => tokenHandlers.create(c.req.raw));
          app.get('/api/tokens', (c) => tokenHandlers.list(c.req.raw));
          app.delete('/api/tokens/:id', (c) => tokenHandlers.remove(c.req.raw, c.req.param('id')));
        }
        if (registrationEnabled) {
          app.post('/api/register', (c) =>
            handleRegister(c.req.raw, handlerOptions(c.req.raw, c.env, limiters.register)),
          );
        }
        if (passwordResetEnabled) {
          app.post('/api/password-reset', (c) =>
            handleRequestPasswordReset(
              c.req.raw,
              handlerOptions(c.req.raw, c.env, limiters['password-reset']),
            ),
          );
          app.post('/api/password-reset/confirm', (c) =>
            handleResetPassword(c.req.raw, handlerOptions(c.req.raw, c.env)),
          );
        }
        if (verificationEnabled) {
          app.post('/api/verification/send', (c) =>
            handleSendVerificationEmail(
              c.req.raw,
              handlerOptions(c.req.raw, c.env, limiters.verification),
            ),
          );
        }
      });

      // Release the Better Auth connection pool on shutdown so an open mysql2
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
