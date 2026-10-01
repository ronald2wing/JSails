/**
 * Request bodies are read through `ctx.body` (`core/src/server/request-body.ts`),
 * under the body the route declares: JSON, a small form, raw bytes, or a
 * streamed multipart body whose parts are bounded one by one.
 *
 * `jsails/no-buffered-body-parse` bans `.formData()` and Hono's
 * `.parseBody(` in shipped framework code. Both buffer the whole body, files
 * included, before the caller sees any of it, and neither knows the route's
 * declaration: an upload is held in memory up to the request cap. The one
 * sanctioned call is the `form` reader in `core/src/api/forms.ts`, which
 * reads a declared small form. A file upload is a `multipart` body read with
 * `ctx.body.multipart()`.
 *
 * Pending files: registrar routes that still parse their own form (the
 * access port moved them off hook routes but not onto declared bodies); each
 * leaves this list in the change that moves it onto `ctx.body`.
 *
 * - `packages/admin/src/guards.ts`: the admin form guard reads the posted form.
 * - `packages/auth/src/routes.ts`: the login, device and token forms.
 * - `packages/auth/src/plugin.ts`: the sign-in throttle reads the posted email.
 */

const SHIPPED_SOURCE = ['core/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'];

const ALLOWED = ['core/src/api/forms.ts'];

const PENDING_PORT = [
  'packages/admin/src/guards.ts',
  'packages/auth/src/routes.ts',
  'packages/auth/src/plugin.ts',
];

export const restrictedSyntax = [
  {
    name: 'no-buffered-body-parse',
    files: SHIPPED_SOURCE,
    ignores: [...ALLOWED, ...PENDING_PORT],
    selector: [
      "CallExpression[callee.property.name='formData'][arguments.length=0]",
      "CallExpression[callee.property.name='parseBody']",
    ].join(', '),
    message:
      "Read a request body through ctx.body under the route's declared body: ctx.body.form() for a small form, ctx.body.multipart() for uploads. formData() and parseBody() buffer the whole body.",
  },
];

export default [];
