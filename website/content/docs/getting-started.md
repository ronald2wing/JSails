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

For the server-rendered `--admin` or `--blog` shapes, start the local services
and the development server instead:

```sh
npx jsails jamal up  # optional (needs Docker): local MariaDB + Valkey.
                     # Those shapes ship auth, so their routes need this —
                     # or an existing database via DATABASE_HOST / DATABASE_* vars.
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

## Starter shapes

`jsails create` scaffolds one of five shapes:

- **default (`--starter`)** — a static site: a typed Markdown content blog built
  on `@jsails/content`, Preact pages, the browser client runtime, and Vite, with
  `plugins: { use: [] }` and no auth, API, server components, or database.
- **`--admin`** — a server-rendered web app with auth (Better Auth over MariaDB),
  the first-party admin panel, a live `task-list` server component, and
  Home/About/Tasks/Login/Dashboard/Device pages.
- **`--blog`** — the standalone blog CMS: the web base plus the first-party blog
  plugin, the `admin-plugin-manager`, and two blog pages (admin included). The
  auth, admin, mail, blog, editor, and media layers ship as separate workspace packages
  (`@jsails/auth`, `@jsails/mail`, `@jsails/admin`, `@jsails/blog`, `@jsails/editor`,
  `@jsails/media`) added to `package.json`, and `plugins.use` references them by
  those package names.
- **`--saas`** — the server-rendered web base (admin included) plus multi-tenancy
  and feature flags. The `@jsails/tenancy` plugin (with a demo host/header tenant
  resolver to replace with a real DB lookup) and the `@jsails/flags` plugin (an
  in-memory store by default, opt-in database store) ship as workspace packages
  added to `package.json`; there is no blog, editor, media, or plugin-manager
  wiring.
- **`--cli`** — a Laravel-Zero-style CLI-only project (no web surface) on the same
  framework and plugin system.

The default does not include auth; the `--admin`, `--blog`, and `--saas` shapes
do. All five shape flags are mutually exclusive.

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

## Database config — `jsails.config.js`

The data layer is configured by a compiled ESM config whose default export is a
`JsailsDataSource`. Models are **declarative Active Record classes** extending
`ApplicationRecord`; the compiler derives the table, columns, relations, and
schema diff from the class shape, so `.find` / `.save` / `.create` work as static
methods. Write a model with `jsails make:model` and register it:

```ts
// jsails.config.js — `Post` comes from the generated model file
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

`readDatabaseEnvironment` reads `DATABASE_HOST`, `DATABASE_USER`,
`DATABASE_PASSWORD`, `DATABASE_NAME`, and `DATABASE_PORT` (MariaDB defaults to
`3306`). It never loads a `.env` file or mutates `process.env`.

`jsails make:model post` generates the same declarative shape, and the relation
factories (`belongs_to` / `has_many` / `delegate` / `accepts_nested_attributes_for`)
keep relations and forwarding concise — see [Models](/docs/models) and
[Conventions](/docs/conventions).

## Next steps

- [Conventions](/docs/conventions) — the declarative model DSL, generators, and the
  generated autoload layer.
- [Architecture](/docs/architecture) — how the framework is assembled.
