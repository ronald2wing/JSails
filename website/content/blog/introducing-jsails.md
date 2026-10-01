---
title: Introducing JSails
date: 2026-10-07
tags:
  - release
  - announcement
---

# Introducing JSails

JSails is a **data layer first, and a runtime second**. It pairs TypeORM's Active
Record model with the pieces a real web app actually needs — filesystem routing,
a static export, server components, jobs, auth, and deployment — while staying
deliberately *not* a complete MVC framework.

## The idea

Most frameworks either hand you a bespoke everything, or leave you to assemble
orphaned libraries into a coherent app. JSails takes a third path: it keeps the
maintained libraries you already trust (TypeORM, Zod, BullMQ, Socket.IO, Preact,
Hono) and layers a small, opinionated shell over the seams between them.

The result is a framework that is explicit about what it owns and what it
reuses:

- **Active Record data** on top of TypeORM, with a portable schema model and a
  declarative desired-state schema the framework reconciles with `db:push`.
- **Filesystem routes** — pages and API modules discovered lexically, statically
  exportable with a single command.
- **Server components** — HotView signed, stateless state with backend
  actions, no stranded server-side UI store.
- **First-party plugins** for auth, jobs, cache, mail, filesystem, flags,
  notifications, and more, all behind one extension seam.

## What sets it apart

Three things, in order:

1. **Schema reconciliation, not migration files.** The model definitions are the
source of truth; `jsails db:push` diffs them against the live database, applies
the safe operations, and refuses a plan containing a destructive one unless you
pass `--allow-destructive`. There is no applied-state ledger and no automatic
rollback — backups stay the operator's responsibility.

2. **Everything is a plugin.** The core is just the loader and a handful of
contract seams; the reference implementations are replaceable default plugins.
The same mechanism powers a marketplace for third-party plugins.

3. **Deployment is generated, not hand-rolled.** Jamal (our TypeScript
reimplementation of Kamal + Sail) plans and executes releases — including
database and Valkey accessories, on-demand TLS, and server hardening — from one
config file.

## Why this site exists

`jsails.org` is itself built with JSails. The docs you're reading are hand-written
markdown rendered at build time by our own static export, through Shiki syntax
highlighting and Pagefind search. No database, no server — a static site you can
deploy anywhere.

That's the dogfood test, and it passes.

## Start here

Scaffold a project with the published CLI:

```sh
npx jsails@latest create my-app --install
cd my-app && npm run dev
```

From a framework source checkout, build and pack the CLI first; the rest is the
same.

Read [Getting Started](/docs/getting-started), or jump straight to the
[Database](/docs/database).