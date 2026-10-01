---
title: Getting Started
order: 1
section: Orientation
---

# Getting Started

JSails is a **TypeORM-based Active Record data layer** plus a bounded application
runtime: an extension system, HTTP/pages/API serving, static export, jobs,
broadcast, deploy-config generators, and a CLI. It is deliberately _not_ a
complete MVC framework — it reuses maintained libraries (TypeORM, Zod, BullMQ,
Socket.IO, Preact, Hono) rather than rebuilding a renderer, an auth stack, or a
queue.

## Prerequisites

- **Node.js** `>=26.0.0` (ESM only)
- **Docker** (optional) — only if you want `npx jsails jamal up` to provision the local
  MariaDB + Valkey development services in one command. Without Docker, point
  the app at an existing MariaDB/Postgres/MySQL database, or skip a database
  entirely — a static or DB-less app needs none.

## Installation

```sh
npx jsails@latest create my-app --install
cd my-app
```

The default starter is a static site, so build it and deploy `out/`:

```sh
npm run build        # compile TS/assets, then static-export into out/
```

The server-rendered `--admin`, `--blog`, and `--saas` presets ship sign-in over
MariaDB, so the database has to be configured, running, and migrated before the
first `npm run dev`. `jsails create` prints these steps, in this order:

```sh
cp .env.auth.example .env
# in .env set BETTER_AUTH_SECRET and JSAILS_COMPONENT_SECRET (each:
# openssl rand -base64 32), DATABASE_HOST=127.0.0.1, DATABASE_USER,
# DATABASE_PASSWORD, DATABASE_NAME, and DATABASE_ROOT_PASSWORD
npx jsails jamal up  # local MariaDB + Valkey (needs Docker); or point the
                     # DATABASE_* values at an existing MariaDB instead
npm run build        # db:push reads the compiled model registry
npm run db:push      # framework, plugin, and model tables
npm run auth:migrate # Better Auth's tables
npm run user:create -- <email> <password> --role admin   # the first admin
npm run dev          # compile + watch + serve (restarts the backend on changes)
```

From a framework source checkout, build and pack the CLI instead:

```sh
npm install
npm run build
npm pack --pack-destination /tmp
node dist/src/cli/index.js create my-app --install \
  --jsails-dependency "file:/tmp/jsails-1.0.0.tgz"
```

## Starter presets

`jsails create` scaffolds one of five presets:

- **default (`--starter`)** — a static site: a typed Markdown content blog built
  on `@jsails/content`, Preact pages, the browser client runtime, and Vite, with
  `plugins: { use: [] }` and no auth, API, server components, or database.
- **`--admin`** — a server-rendered web app with auth (Better Auth over MariaDB),
  the first-party admin panel at `/admin`, a live `task-list` server component,
  and the Home, About, Tasks, Live, Load-more, Login, Register, Reset-password,
  Dashboard, and Device pages.
- **`--blog`** — the standalone blog CMS: the web base plus the first-party blog
  plugin, the media library, theme, and site configuration pages in the admin
  panel, and two blog pages (admin included). The
  auth, admin, mail, blog, editor, and media layers ship as separate workspace packages
  (`@jsails/auth`, `@jsails/mail`, `@jsails/admin`, `@jsails/blog`, `@jsails/editor`,
  `@jsails/media`) added to `package.json`, and `plugins.use` references them by
  those package names.
- **`--saas`** — the server-rendered web base (admin included) plus multi-tenancy
  and feature flags. The `@jsails/tenancy` plugin (resolving a tenant only from
  one subdomain label under `TENANT_ROOT_DOMAIN`, looked up in `jsails_tenants`
  and gated on membership; never from a request header) and the
  `@jsails/flags` plugin (an in-memory store by default, opt-in database store)
  ship as workspace packages added to `package.json`; there is no blog, editor,
  or media wiring. `models/project.ts` is a tenant-owned example
  model declared with `@tenantScoped('tenantId')` (see
  [Tenancy](/docs/tenancy#tenant-scoped-models)); `npm run db:push` creates its
  table after a build.
- **`--cli`** — a CLI-only project: commands, jobs, and plugins on the same
  framework, with no web surface.

The default does not include auth; the `--admin`, `--blog`, and `--saas` presets
do. All five preset flags are mutually exclusive.

The web presets fail closed:

- `/admin` uses `adminOnly` from `@jsails/auth`: only a session whose user
  holds the `admin` role is admitted. No sign-up can set the role, so the
  self-registration the presets turn on never grants the panel to whoever
  signs up. Make the first admin with
  `npm run user:create -- <email> <password> --role admin`.
- `POST /api/login` and `POST /api/register` are throttled by the `auth`
  plugin's default `createMemoryRateLimiter`: 10 attempts per route, email,
  and client address and 100 per client address in a 15-minute window. Its
  counters are per process; with more than one process, pass a shared hook as
  `login.rateLimit` and `registration.rateLimit`.
- The generated `jamal.config.ts` forwards the `PUBLIC_ORIGIN` secret as both
  `PUBLIC_ORIGIN` and `BETTER_AUTH_URL`, so a production deploy issues `Secure`
  session cookies, and a deploy without it stops with `missing_secret`.
- `--blog` leaves the public `POST /blog/posts` route unmounted; posts are
  written through the admin panel.

Copy `.env.auth.example` to `.env`: every `jsails` command loads `.env`,
`.env.local`, and `.env.<NODE_ENV>`, and the `auth:migrate` / `user:create`
scripts load `.env` and `.env.local` through Node's `--env-file-if-exists`. A
real environment variable always wins over the files.

## Build & serve

- `npm run dev` — compiles TypeScript + Vite, then serves with automatic restart
  when compiled server JS or the app config changes. Client changes (island TSX,
  CSS, theme) reload the browser without a restart. There is **no HMR** — the
  page reloads, so component state is not preserved.
- `npm run build` — compiles the server and client, then runs `jsails build`
  (static export) to emit built pages into `out/`.
- `npm test` — the native `node:test` suite; `npm run test:browser` is the optional
  Playwright UI suite.

## Application config — `jsails.app.js`

The app is described by a single compiled ESM module whose default export is a
plain object:

```js
export default {
  rootDir: '.', // defaults to the config file's directory
  pages: 'pages', // relative to rootDir
  api: 'api', // relative to rootDir
  public: 'public', // relative to rootDir
  out: 'out', // static export destination
  storage: 'storage', // resolved to storageDir, created on serve
  healthPath: '/up', // GET/HEAD 200; false disables
  host: '127.0.0.1',
  port: 3000, // 0 requests an ephemeral port
};
```

`host`, `port`, and `out` come from the config, never CLI flags.

## Database config — `jsails.database.js`

The data layer is configured by a compiled ESM config whose default export is a
`JsailsDataSource`. Models are **declarative Active Record classes** extending
`ApplicationRecord`; the compiler derives the table, columns, relations, and
schema diff from the class shape, so `.find` / `.save` / `.create` work as static
methods. Write a model with `jsails make:model` and register it:

```js
// jsails.database.js — `Post` comes from the generated model file
import { JsailsDataSource, readDatabaseEnvironment } from 'jsails';
import { Post } from './models/post.js';

export default new JsailsDataSource({
  ...readDatabaseEnvironment(),
  entities: [Post],
});
```

```ts
// models/post.ts — `ApplicationRecord` is installed as a global.
export class Post extends ApplicationRecord {
  declare title: string; // -> varchar(255)
  declare published: boolean; // -> boolean
}
```

The class name fixes the table (`Post` → `post`), the primary key is generated,
and `jsails db:push` reconciles the live schema to the declaration. Add
`@jsails.maxLength`, `@jsails.unique`, or relation decorators only when the
inferred shape is not what you want — see [Models](/docs/models).

`readDatabaseEnvironment` reads `DATABASE_TYPE` (`mariadb` by default,
`postgres`, or `mysql`), `DATABASE_HOST`, `DATABASE_USER`, `DATABASE_PASSWORD`,
`DATABASE_NAME`, and `DATABASE_PORT` (the driver default — `3306` for MariaDB —
when unset). It never loads a `.env` file or mutates `process.env`.

`jsails make:model post` generates the same declarative shape, and the relation
factories (`belongs_to` / `has_many` / `delegate` / `accepts_nested_attributes_for`)
keep relations and forwarding concise — see [Models](/docs/models) and
[Conventions](/docs/conventions).

## Preset internals

`jsails create` scaffolds one of five mutually exclusive presets. There is no
`--static` flag: the default preset is the static site, and `--starter` selects
it explicitly. The preset id type is `StarterPresetId` in
`src/app/starter/presets.ts`:

```ts
type StarterPresetId = 'starter' | 'admin' | 'blog' | 'saas' | 'cli';
```

### Presets are meta modules

A preset is a build-time meta module: it owns no implementation, only the list
of feature modules it requires. Each feature module owns its own template files,
package dependencies, app/database config provider, and guide text.

```ts
// presets.ts
{ id: 'admin', requires: ['web-base', 'auth', 'admin'] }
{ id: 'blog', requires: ['web-base', 'auth', 'blog', 'media'] }
```

`requires` is resolved into a dependency-ordered feature graph
(`resolveStarterFeatures`), so a preset only names the top-level features it
wants. Adding a preset is data-only: a new entry in `STARTER_PRESETS` plus the
feature modules it references.

### Every preset is developer mode

Every generated app runs in developer mode: a plugin runs only when it is
installed with npm and listed in `plugins.use` (or `config.extensions`), and
then it always runs. No preset turns on managed mode, ships the admin plugin
manager, persists installed-plugin state, or activates plugin code from the
database, so the generated app config sets no `plugins.enabled` (that
allowlist is read only in managed mode; see [Plugins](/docs/plugins)). Add a
package-installed plugin to `plugins.use` in the generated app config.

Admin pages, resources, and actions are default-deny, so the `--blog` preset
wraps its blog, media, theme, and configuration admin plugins in
`withAdminAuthorize(plugin, adminOnly)`. Do the same for any admin plugin you
add that declares no `authorize` of its own.

Behind the kamal-proxy of `jamal deploy`, the generated `jamal.config.ts` sets
`JSAILS_TRUSTED_PROXIES: 'hops=1'`, so rate limits key on the client address
rather than the proxy's (see [Origin, hosts and proxies](/docs/deployment-proxies)).

## Next steps

- [Conventions](/docs/conventions) — the declarative model DSL, generators, and the
  generated autoload layer.
- [Architecture](/docs/architecture) — how the framework is assembled.
