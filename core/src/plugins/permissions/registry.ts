/**
 * The closed plugin permission registry.
 *
 * A permission is static data: an id, a plain-language title and description,
 * a risk rating, and, for a permission that names something (a host, a model,
 * a disk, an environment variable), the kind of scope it takes. Every name a
 * manifest may declare is defined here and nowhere else, so an operator
 * reviewing an install always gets a sentence for each grant, and a name that
 * nothing enforces (`database.read`, `network.connect`) cannot be declared at
 * all. Adding a permission is cheap; renaming one breaks every manifest that
 * declares it, so the list is a public contract.
 *
 * A declared permission is written `id` or, for a scoped one, `id:scope`
 * (`net.fetch:api.example.com`, `data.read:Post`). {@link parsePermission}
 * checks one against the registry and returns a value-free code on failure;
 * {@link describePermission} turns a valid one into the sentence an install
 * screen shows. Nothing here grants or enforces anything: the capability gate
 * of the setup context does that, against these ids.
 */

/**
 * How much an operator should weigh a grant: `low` stays inside the plugin's
 * own surface, `elevated` reaches the site's users or data in a bounded way,
 * `high` can change how every request or the whole site behaves.
 *
 * @public
 */
export type PermissionRisk = 'low' | 'elevated' | 'high';

/**
 * What a scoped permission names: an outbound `host`, a data `model`, a
 * storage `disk`, or an `env`ironment variable.
 *
 * @public
 */
export type PermissionScopeKind = 'host' | 'model' | 'disk' | 'env';

/**
 * One registered permission.
 *
 * @public
 */
export interface PermissionDefinition {
  /** Dotted lowercase id, e.g. `http.routes`. */
  readonly id: string;
  /** Short plain-language title; a scoped one contains `{scope}`. */
  readonly title: string;
  /** One plain-language sentence of what the grant allows. */
  readonly description: string;
  /** How much the grant should weigh in an operator's review. */
  readonly risk: PermissionRisk;
  /** The kind of scope the permission takes, when it takes one. */
  readonly scoped?: PermissionScopeKind;
}

/**
 * A declared permission checked against the registry.
 *
 * @public
 */
export interface ParsedPermission {
  /** The registered definition. */
  readonly definition: PermissionDefinition;
  /** The scope value of a scoped permission. */
  readonly scope?: string;
}

/**
 * Why a declared permission was refused.
 *
 * @public
 */
export type PermissionIssueCode =
  | 'invalid_format'
  | 'unknown_permission'
  | 'scope_required'
  | 'scope_not_allowed'
  | 'invalid_scope'
  | 'reserved_scope';

/**
 * The result of {@link parsePermission}.
 *
 * @public
 */
export type PermissionParseResult =
  | { readonly ok: true; readonly permission: ParsedPermission }
  | { readonly ok: false; readonly code: PermissionIssueCode };

/**
 * A permission as an install screen shows it: the title with the scope filled
 * in, the description, and the risk.
 *
 * @public
 */
export interface PermissionDescription {
  /** The declared text, `id` or `id:scope`. */
  readonly permission: string;
  /** The title with `{scope}` replaced by the scope value. */
  readonly title: string;
  /** The definition's description. */
  readonly description: string;
  /** The definition's risk. */
  readonly risk: PermissionRisk;
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;
const MAX_PERMISSION_LENGTH = 300;
const SCOPE_PLACEHOLDER = '{scope}';

/**
 * A DNS host name as `guardedFetch` compares it: lowercase labels, at least
 * two, the last one alphabetic so an IPv4 literal never matches (a literal
 * address would skip the name resolution the fetch guard vets).
 */
const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MODEL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DISK_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

/**
 * The framework's own variables (`JSAILS_CREDENTIALS_KEY`, `JSAILS_ENV`, ...)
 * carry keys and deployment decisions no plugin may read through a grant.
 */
const RESERVED_ENV_PREFIX = 'JSAILS_';

const SCOPE_PATTERNS: Readonly<Record<PermissionScopeKind, RegExp>> = Object.freeze({
  host: HOST_PATTERN,
  model: MODEL_PATTERN,
  disk: DISK_PATTERN,
  env: ENV_PATTERN,
});

/** Validate and freeze one definition; a malformed one is a framework bug. */
function definePermission(definition: PermissionDefinition): PermissionDefinition {
  const hasPlaceholder = definition.title.includes(SCOPE_PLACEHOLDER);
  if (
    !ID_PATTERN.test(definition.id) ||
    definition.title.trim() === '' ||
    definition.description.trim() === '' ||
    hasPlaceholder !== (definition.scoped !== undefined)
  ) {
    throw new TypeError('malformed permission definition');
  }
  return Object.freeze({ ...definition });
}

const definitions: readonly PermissionDefinition[] = [
  definePermission({
    id: 'http.routes',
    title: 'Add pages and endpoints under its own path',
    description:
      'Registers routes inside the path prefix the site gives this plugin; it cannot replace an existing route.',
    risk: 'low',
  }),
  definePermission({
    id: 'http.routes.any',
    title: 'Add pages and endpoints at any free path',
    description:
      'Registers routes outside its own path prefix, at any path no other route has claimed.',
    risk: 'elevated',
  }),
  definePermission({
    id: 'http.middleware',
    title: 'Run code on every request',
    description: 'Adds middleware that sees and can answer every request after the access check.',
    risk: 'high',
  }),
  definePermission({
    id: 'http.transform',
    title: 'Rewrite responses',
    description: 'Rewrites response headers and bodies, including pages other plugins render.',
    risk: 'high',
  }),
  definePermission({
    id: 'http.guard',
    title: 'Refuse requests before anything else runs',
    description:
      'Adds a guard that sees every request before routing and static files, and may answer it.',
    risk: 'high',
  }),
  definePermission({
    id: 'http.scope',
    title: 'Wrap every request in its own scope',
    description:
      'Resolves a per-request scope (such as the current tenant) that every handler runs inside.',
    risk: 'high',
  }),
  definePermission({
    id: 'http.serve',
    title: 'Attach to the running server',
    description:
      'Receives the HTTP server once it listens, for example to accept WebSocket connections.',
    risk: 'high',
  }),
  definePermission({
    id: 'admin.pages',
    title: 'Add pages to the admin',
    description: 'Adds pages and navigation entries that site administrators see.',
    risk: 'elevated',
  }),
  definePermission({
    id: 'data.own',
    title: 'Store its own data',
    description: 'Creates and uses database tables under its own table prefix.',
    risk: 'low',
  }),
  definePermission({
    id: 'data.read',
    title: 'Read {scope} records',
    description: 'Reads records of a model the site or another plugin owns.',
    risk: 'elevated',
    scoped: 'model',
  }),
  definePermission({
    id: 'data.write',
    title: 'Change {scope} records',
    description:
      'Creates, changes, and deletes records of a model the site or another plugin owns.',
    risk: 'high',
    scoped: 'model',
  }),
  definePermission({
    id: 'net.fetch',
    title: 'Send requests to {scope}',
    description:
      'Makes outbound HTTPS requests to this one host, which can receive any data the plugin can read.',
    risk: 'elevated',
    scoped: 'host',
  }),
  definePermission({
    id: 'mail.send',
    title: 'Send email',
    description: "Sends email through the site's mail service, from the site's sender address.",
    risk: 'elevated',
  }),
  definePermission({
    id: 'notifications.send',
    title: 'Send notifications',
    description: "Sends notifications to the site's users through the notification service.",
    risk: 'elevated',
  }),
  definePermission({
    id: 'jobs.define',
    title: 'Run background jobs',
    description: 'Defines background jobs and dispatches them to the site queue.',
    risk: 'low',
  }),
  definePermission({
    id: 'jobs.schedule',
    title: 'Run jobs on a schedule',
    description: 'Registers recurring jobs that run without a request.',
    risk: 'low',
  }),
  definePermission({
    id: 'events.observe',
    title: 'Observe framework events',
    description:
      'Receives framework events such as finished and failed requests and their payloads.',
    risk: 'elevated',
  }),
  definePermission({
    id: 'interceptors.register',
    title: 'Change how operations run',
    description:
      'Runs code before and after framework operations and can change their input and result.',
    risk: 'high',
  }),
  definePermission({
    id: 'services.provide',
    title: 'Offer new services',
    description: 'Registers services under names no other plugin has taken.',
    risk: 'low',
  }),
  definePermission({
    id: 'services.replace',
    title: 'Replace existing services',
    description: 'Replaces a service another plugin or the site provides, such as mail or storage.',
    risk: 'high',
  }),
  definePermission({
    id: 'files.disk',
    title: 'Read and write files on the {scope} disk',
    description: 'Reads, writes, and deletes files on one named storage disk.',
    risk: 'elevated',
    scoped: 'disk',
  }),
  definePermission({
    id: 'auth.session.read',
    title: 'See who is signed in',
    description: 'Reads the identity of the signed-in user on each request.',
    risk: 'elevated',
  }),
  definePermission({
    id: 'users.read',
    title: 'Read user accounts',
    description: "Reads the site's user accounts, including names and email addresses.",
    risk: 'elevated',
  }),
  definePermission({
    id: 'health.readiness',
    title: 'Report whether the site is ready',
    description: 'Adds a readiness probe; a failing probe takes the whole site out of rotation.',
    risk: 'elevated',
  }),
  definePermission({
    id: 'client.assets',
    title: 'Serve static files',
    description: 'Serves its own stylesheets, scripts, and images to visitors.',
    risk: 'low',
  }),
  definePermission({
    id: 'env.read',
    title: 'Read the {scope} environment variable',
    description: 'Reads one environment variable, which may hold a credential.',
    risk: 'high',
    scoped: 'env',
  }),
];

const byId: ReadonlyMap<string, PermissionDefinition> = new Map(
  definitions.map((definition) => [definition.id, definition]),
);

/**
 * Every registered permission, in registry order.
 *
 * @public
 */
export const PERMISSIONS: readonly PermissionDefinition[] = Object.freeze([...definitions]);

/**
 * The registered definition for an id (without a scope), or `undefined`.
 *
 * @public
 */
export function getPermission(id: string): PermissionDefinition | undefined {
  return byId.get(id);
}

/**
 * Check one declared permission (`id` or `id:scope`) against the registry.
 * The code names what is wrong; neither the code nor anything else in the
 * result repeats the input.
 *
 * @public
 */
export function parsePermission(text: unknown): PermissionParseResult {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_PERMISSION_LENGTH) {
    return { ok: false, code: 'invalid_format' };
  }
  const separator = text.indexOf(':');
  const id = separator === -1 ? text : text.slice(0, separator);
  const scope = separator === -1 ? undefined : text.slice(separator + 1);
  if (!ID_PATTERN.test(id)) return { ok: false, code: 'invalid_format' };
  const definition = byId.get(id);
  if (definition === undefined) return { ok: false, code: 'unknown_permission' };
  if (definition.scoped === undefined) {
    return scope === undefined
      ? { ok: true, permission: Object.freeze({ definition }) }
      : { ok: false, code: 'scope_not_allowed' };
  }
  if (scope === undefined || scope === '') return { ok: false, code: 'scope_required' };
  if (!SCOPE_PATTERNS[definition.scoped].test(scope)) return { ok: false, code: 'invalid_scope' };
  if (definition.scoped === 'env' && scope.startsWith(RESERVED_ENV_PREFIX)) {
    return { ok: false, code: 'reserved_scope' };
  }
  return { ok: true, permission: Object.freeze({ definition, scope }) };
}

/**
 * The install-screen sentence for a declared permission, or `undefined` when
 * the registry refuses it.
 *
 * @public
 */
export function describePermission(text: string): PermissionDescription | undefined {
  const result = parsePermission(text);
  if (!result.ok) return undefined;
  const { definition, scope } = result.permission;
  return Object.freeze({
    permission: text,
    title:
      scope === undefined ? definition.title : definition.title.replace(SCOPE_PLACEHOLDER, scope),
    description: definition.description,
    risk: definition.risk,
  });
}
