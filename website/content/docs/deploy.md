---
title: Deployment
order: 20
section: Operating
---

# Deployment

**Jamal** (`@jsails/jamal`) runs an app's backing services locally over Docker
Compose and deploys the app to one server over SSH, behind one config file: a
TypeScript reimplementation of Sail and the single-host part of Kamal. It is
both a development tool (local services) and a production tool (single-host
deploys), so it is a regular dependency of the app: a deploy runs from a
production install (CI with `npm ci --omit=dev`, or an operator's checkout),
where the tool and the imports of `jamal.config.ts` must be present.
Deployment verbs execute by default; `--dry-run` prints the plan and runs
nothing.

## Jamal

The server-rendered starters (`--admin`, `--saas`, `--blog`) install it. Any
other project adds it:

```sh
npm install @jsails/jamal
```

The package provides the `jamal` command (`npx jamal <verb>`), and
`npx jsails jamal <verb>` forwards to the same install, with the same arguments
and exit code. The verbs are `up | down | ps | logs | exec | jsails | npm | npx
| node | test | shell | status | deploy | rollback | domain | prune | secrets |
accessory | app | lock | cache-proxy`; the prose below uses the bare verb as
shorthand.

On Windows the local verbs run (`up`, `down`, `ps`, `logs`, `exec`, and the
dev-container shortcuts); every verb that reaches or plans for the server
refuses with `unsupported_platform`, because the deploy path drives `ssh`,
`sh -c`, and POSIX paths on the host. Deploy from Linux or macOS.

### `jamal.config.ts`

`jamal.config.ts` in the project root default-exports the config, typed by
`defineJamal` from the package. Jamal loads it with Node's own type stripping,
without building the app, so it imports only `@jsails/jamal`. A project
without TypeScript names it `jamal.config.js`; a project with both files is
refused.

```ts
// jamal.config.ts
import { defineJamal, secret } from '@jsails/jamal';

export default defineJamal({
  service: 'my-app',
  image: 'registry.example.com/my-app',
  env: { DATABASE_PASSWORD: secret('DATABASE_PASSWORD') },
  services: { db: { type: 'mariadb' }, cache: { type: 'valkey' } },
  production: { server: 'app.example.com', domain: 'example.com' },
});
```

There is no `mode` flag: the base fields plus non-destructive `local` (ports/
app) and `production` (server/domain/onDemandTlsUrl/registry/destination/
secretsPath) overlay sections drive both environments. `secret('NAME')` returns
a `SecretRef`, a name only, never resolved or serialized: plans, logs, and
errors show `secret(NAME)`.

The `services` map declares the backing services the app depends on. Backing
services (`mariadb`, `postgres`, `valkey`) plus the opt-in search engines
(`meilisearch`, `typesense`, `opensearch`) and the opt-in S3-compatible object
store (`s3`) are rendered by the local Compose planner with a pinned image,
healthcheck, and named data volume; `mailpit` and `adminer` are dev-only tools.
`local.ports` publishes any backing service on loopback
(`127.0.0.1:<host>:<internal>`).

| type | image | internal port | credentials (host env) |
| --- | --- | --- | --- |
| `mariadb` | `mariadb:11.4` | 3306 | `DATABASE_NAME`/`DATABASE_USER`/`DATABASE_PASSWORD` |
| `postgres` | `postgres:16-alpine` | 5432 | `DATABASE_*` (+ `PGDATA`) |
| `valkey` | `valkey/valkey:8.0-alpine` | 6379 | — |
| `meilisearch` | `getmeili/meilisearch:v1.12` | 7700 | `MEILISEARCH_KEY` |
| `typesense` | `typesense/typesense:27.1` | 8108 | `TYPESENSE_API_KEY` |
| `opensearch` | `opensearchproject/opensearch:2.19.0` | 9200 | — (security off) |
| `s3` | `chrislusf/seaweedfs:3.91` | 8333 | `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` |

### Local execution verbs

Execution verbs (`up`/`down`/`ps`/`logs`/`exec`) drive `docker compose` against
the local project, always: a `production` section in the config never sends
them to the server. The deployed container's logs and shell are
`jamal app logs` and `jamal app exec`. `up` materializes the managed
`.jamal/compose.yml` from the config and runs `docker compose up -d --wait`;
`down`/`ps`/`logs` use that managed file/project and require it to exist (run
`jamal up` first). `exec <service> -- <cmd...>` requires the managed file.
`--detach` is accepted for `up` and is already the default; `--follow` tails
`logs`.

```sh
npx jamal up
npx jamal ps
npx jamal logs --follow app
npx jamal exec db -- mariadb --version
```

### Where the app runs locally

`local.app` decides whether the app itself joins the local project:

| `local.app`      | The app runs                                                        |
| ---------------- | ------------------------------------------------------------------- |
| `host` (default) | on your machine with `npm run dev`; jamal runs only the services    |
| `dev`            | in a container with the project mounted, reloading on save (Sail)   |
| `image`          | in a container built from the project's Dockerfile, like production |

```ts
// jamal.config.ts
import { defineJamal } from '@jsails/jamal';

export default defineJamal({
  service: 'my-app',
  image: 'registry.example.com/my-app',
  local: {
    app: 'dev',
    ports: { web: 3000 }, // the dev server on http://127.0.0.1:3000 (the default)
  },
});
```

With `app: 'dev'`, `jamal up` builds a small image from Node 26 and runs
`jsails dev` in it. Details:

- **Your files stay yours.** The image runs as your user id, so whatever the
  app writes into the project (`dist/`, `.jsails/`, `storage/`) belongs to you.
- **`node_modules` lives in a volume**, because native modules built for macOS
  or Windows do not load in a Linux container. The first start installs
  dependencies into it. After changing dependencies, run
  `npx jamal npm install`.
- **The app reads the same `.env` files and credentials as on the host**, from
  the mounted project. jamal sets only the variables that locate a service
  (`DATABASE_HOST`, `DATABASE_PORT`, `VALKEY_URL`, `SEARCH_URL`,
  `S3_ENDPOINT`), so they name the Compose service instead of `127.0.0.1`,
  which inside a container is the container itself. A kind with two services
  (two databases, say) gets no location; set it yourself. Everything else,
  including the test database chosen by `.env.testing`, works as on the host.
  A `VALKEY_URL` with a password or database number is replaced by the plain
  service address.
- **Inside the container the app listens on every interface**: jamal sets
  `JSAILS_HOST=0.0.0.0` and `JSAILS_PORT=3000` (see
  [Configuration](/docs/configuration#listen-host-and-port)). Only the
  loopback-published port on your machine reaches it.
- **Backing services are named for what they are.** `app` and `web` are
  reserved for the application itself.
- **Rootless Docker or Podman**: container root is you there, so set
  `JAMAL_DEV_UID=0` and `JAMAL_DEV_GID=0` before `jamal up`.

You still run `npm install` on the host once, to install `jamal` itself.

Sail-style shortcuts run one command in a fresh app container. They start the
services the app depends on, work whether or not `jamal up` is running, and
pass every argument through:

```sh
npx jamal npm install
npx jamal jsails db:push
npx jamal jsails make:model post
npx jamal npx tsc --noEmit
npx jamal node -e "console.log(process.version)"
npx jamal test                        # npm test
npx jamal test --test-name-pattern auth
npx jamal shell                       # bash in the app container
```

With `app: 'image'` the app container has no project mounted, so each
`config.env` entry is interpolated from the environment `jamal` runs in, and
the service locations are set the same way.

### Deploy executes by default

`jamal deploy` runs a **production release** to the one server
`production.server` names. `--dry-run` prints the plan and runs nothing. It
builds and pushes the image locally, then pulls, runs, and health-checks the
new container on the server, switches traffic to it, and stops the previous
one.

```sh
npx jamal deploy
npx jamal deploy --tag v1.4.0
npx jamal deploy --dry-run
npx jamal rollback
```

`rollback` redeploys the previous successful tag and also executes by default,
with `--dry-run` as its preview. Both record the deployed tag in
`.jamal/deploys.json`. `status` lists remote containers, and `app logs`/`app
exec` inspect the last deployed container. These verbs require
`config.production`.

Production execution first provisions the declared backing services
(MariaDB/Postgres/Valkey accessory containers). `jamal app <verb>` drives the
app container over ssh against the LATEST recorded deploy (`containers` filters
by service name), and `jamal accessory <verb>` manages the backing-service
containers; both require `config.production` and support `--dry-run`.
`app logs --follow` and `accessory logs --follow` stream until interrupted, and
the local image build and push print their progress as they run.

### What runs on the server

- **ssh.** Every remote command runs with the `production.ssh` options (`user`,
  `port`, `keys`, `proxyCommand`, `config`) plus keepalive and a 15 s connect
  timeout. Each argument is single-quoted for the server's shell, so a config
  value is never split or executed there. `--dry-run` prints the same quoted
  command, ready to paste.
- **Network.** The app, the accessories, kamal-proxy, and the cache proxy share
  the Docker network `jamal` (created on first deploy; existing containers are
  connected to it). The app reaches an accessory by its container name
  (`DATABASE_HOST=mariadb`, `VALKEY_URL=redis://valkey:6379`), and no accessory
  publishes a host port.
- **Build.** `jamal deploy` builds the image locally from the `Dockerfile` in
  the project root (`docker buildx build -t <image>:<tag> .`). A project without
  one fails before anything touches the server: no lock is taken. A rollback deploys an image already built and needs no Dockerfile.
- **App container.** It is named `<service>-web-<tag>` (the deploy history
  records the name), starts with
  `--restart unless-stopped`, the `jamal.service=<service>` label,
  `NODE_ENV=production`, and
  `JSAILS_HOST=0.0.0.0`/`JSAILS_PORT=3000` (a `clear` entry in `config.env`
  overrides any of these); kamal-proxy targets
  `<container>:3000`. Named `config.volumes` become `<service>_<name>` Docker
  volumes, and `config.command` runs as the container command.
- **Health check.** By default the check runs inside the new container
  (`docker exec <container> node -e "fetch(...)"` against
  `127.0.0.1:3000<health.path>`), so the image needs `node`. Each attempt is
  bounded by `health.timeoutMs`, and the deploy fails after the retry budget.
  On a failed health check or switch, the new container is removed and the
  previous one keeps serving. A stopped container with the new name is removed
  before the run, but a running one never is: the run fails on the name
  conflict instead (remove it yourself once you know it is not serving).
  After a successful switch the previous container is stopped and removed.
- **Same tag.** Redeploying the tag that is already live (an unchanged commit)
  starts the new container as `<service>-web-<tag>-r`, and the next same-tag
  redeploy alternates back, so the live container keeps serving until the new
  one is healthy and switched in.
- **Cache proxy.** When it is enabled and already running on the configured
  image, each deploy rewrites the VCL in place and reloads it with
  `varnishreload`, so Varnish keeps serving. A missing container, a changed
  image, or a failed reload replaces the container instead, which briefly
  interrupts traffic through it.
- **Env files.** The app's secrets are written over stdin, with mode `0600`, to
  `~/.jamal/apps/<service>[-<destination>]/env` on the server. The relative
  path resolves against the ssh user's home. The write goes to a temporary
  file that replaces the env file only after its byte count and SHA-256 match
  what was sent, so a dropped connection never leaves a truncated env file; the
  server needs `sha256sum` or `shasum`. Values are written verbatim (Docker
  reads everything after the first `=` literally, so backslashes, quotes, `=`
  and `#` reach the container unchanged); a value containing a newline,
  carriage return, or NUL, or an entry longer than 65535 bytes (the longest
  line Docker's env-file reader accepts), cannot be carried in a Docker env
  file and fails the deploy with an error naming only its key.
- **Accessory credentials.** A production `mariadb` or `postgres` accessory
  requires `DATABASE_PASSWORD` in `config.env` (usually
  `secret('DATABASE_PASSWORD')`). Its value goes into
  `~/.jamal/apps/<service>/accessories/<name>.env`, never onto a command line.
  MariaDB gets a random root password. When `config.env` declares
  `VALKEY_PASSWORD`, Valkey requires it: the password reaches the server as
  config on stdin (no command line shows it), and the server still starts
  through the image entrypoint, so it runs as the `valkey` user, not root.
- **Job schedules.** A deploy does not register job schedules. `jsails work`
  registers its release's schedules without removing any, so after a rollout,
  once the previous release's workers have stopped, run `jsails schedule`
  once from the new image (for example `npx jamal app exec --
  node_modules/.bin/jsails schedule --config jsails.runtime.js`). It removes schedules the new release
  no longer declares and restores any that an old worker re-registered with
  its own definition during the rollout (see
  [Running jobs](/docs/jobs#running-jobs)).
- **Names.** `config.service` must match `[a-z0-9][a-z0-9_-]*` (63 characters
  at most), `config.env` keys and aliases must be environment variable names,
  and `config.volumes` names must be Docker volume names. Image tags follow the
  Docker tag grammar.

### Deploy lock

A deploy or rollback holds `~/.jamal/locks/<service>.deploy.lock` on the server.
The lock records who holds it, from which machine, and since when. It is
released when the deploy ends, fails, or is interrupted with Ctrl-C or SIGTERM,
and only while it is still the lock that deploy took: each acquisition writes a
random token, and a deploy whose lock was force-released and then taken by
another deploy leaves that one in place and warns instead of removing it.
An ssh failure is reported as "could not be reached", not as contention, and
`lock status` reports a status it could not read as an error, never as "not
held". A
deploy whose process died outright leaves the lock behind. Inspect and clear
it:

```sh
npx jamal lock status     # held or not, and by whom
npx jamal lock release    # remove it, whoever holds it, once no deploy is running
```

### Secrets

`jamal deploy` reads secrets from `.jamal/secrets-common` followed by
`.jamal/secrets.<destination>` (mirroring Kamal's `.kamal/secrets`). Both files
are dotenv-format with Kamal's substitution rules: a later file's value wins;
`$NAME`/`${NAME}` resolves from earlier entries in the **same** file, then the
host environment, and to an empty string when the name is undefined anywhere;
`$(shell command)` runs the command (after expanding `$NAME` inside it) and
trims trailing newlines; `\$NAME` and `\$(command)` stay literal. A
`$(jamal secrets fetch NAME)` command is run in-process instead of
shelling out, so one secret can derive another by name, even across files:

```sh
# .jamal/secrets-common
DATABASE_HOST=127.0.0.1
DATABASE_USER=jsails
DATABASE_PASSWORD=$(openssl rand -base64 24)
DATABASE_NAME=jsails_production
DATABASE_URL=postgres://$DATABASE_USER@$DATABASE_HOST/$DATABASE_NAME

# .jamal/secrets.production — per-destination overrides read only when
# `production.destination` is "production".
DATABASE_PASSWORD=$(jamal secrets fetch DB_PASSWORD)
```

`secrets/` is gitignored via the starter's `.jamal/` entry; values never enter
the config, the plan, logs, or `ps`. Each `secret('NAME')` entry in the
config's `env` map resolves here and is written to a **host env file** the
container reads (`--env-file`), never signalled on the `docker run` command
line. A literal string stays on the clear channel (`-e NAME=VALUE`); `{
clear: true }` opts a secret reference into the clear channel, and `{ alias:
'OTHER' }` renames the variable inside the container.

```ts
// jamal.config.ts
import { defineJamal, secret } from '@jsails/jamal';

export default defineJamal({
  service: 'my-app',
  image: 'registry.example.com/my-app',
  env: {
    DATABASE_PASSWORD: secret('DATABASE_PASSWORD'), // secret channel (env file)
    DATABASE_HOST: secret('DATABASE_HOST'), // secret channel
    LOG_LEVEL: 'info', // clear channel (-e)
    PUBLIC_URL: { value: secret('DOMAIN'), clear: true }, // clear override
  },
});
```

`production.destination` selects `.jamal/secrets.<destination>` and addresses
the env file as `<service>-<destination>`; `production.secretsPath` relocates
the files. The `jamal secrets` verbs operate directly on the files:

```sh
npx jamal secrets print                          # list names, no values
npx jamal secrets fetch DATABASE_PASSWORD        # print one resolved value
npx jamal secrets extract VAULT/db/password      # JSON path: secret "VAULT", path "db/password"
npx jamal secrets fetch DB_URL --destination production
npx jamal secrets print --secrets-path .jamal/secrets
```

An app that keeps its secrets in encrypted credentials needs only one deploy
secret, the key. Map `JSAILS_CREDENTIALS_KEY: secret('JSAILS_CREDENTIALS_KEY')`
in `env` and every other value comes from the committed
`config/credentials/production.enc` (see
[Configuration](/docs/configuration#environment-files-and-credentials)).

### Image retention

`jamal prune --keep <n> [--images <ref>...]` plans which images to remove,
keeping the `n` most recent per service. It never runs Docker: pass the images
explicitly (for example from `docker image ls` on the server, newest first) and
review the plan.

### Backups

Jamal does not back up the database accessory. The database is a container on
the one server, named after its `services` key, so a dump runs there with the
client inside that container. The credentials come from the accessory's own
environment and never appear on the host's command line. For MariaDB (with
`DATABASE_USER` and `DATABASE_NAME` declared in `config.env`, as the starters
do):

```sh
ssh app.example.com "docker exec db sh -c 'MYSQL_PWD=\"\$MARIADB_PASSWORD\" exec mariadb-dump --single-transaction -u\"\$MARIADB_USER\" \"\$MARIADB_DATABASE\"'" > backup.sql
```

For PostgreSQL, `pg_dump` connects over the container's local socket:

```sh
ssh app.example.com "docker exec db sh -c 'exec pg_dump -U \"\$POSTGRES_USER\" \"\$POSTGRES_DB\"'" > backup.sql
```

Schedule it from another machine (cron, CI) and keep the dumps off the server,
since a backup on the host it protects is lost with that host.

### On-demand TLS

`production.onDemandTlsUrl` opts a deploy into kamal-proxy's on-demand TLS. It is
mutually exclusive with `production.domain`: when set, the proxy routes unknown
hostnames and authorizes each at certificate-issuance time instead of pinning one
static host — the `switch` step carries `kamal-proxy deploy ... --tls-on-demand-url
<url>` and no `--host`. The value must be an absolute `http://` or `https://`
URL, or a local path starting with `/`; any other scheme, or a value with
whitespace/control characters, is rejected when the config is normalized.

```ts
// jamal.config.ts
import { defineJamal } from '@jsails/jamal';

export default defineJamal({
  service: 'my-app',
  image: 'registry.example.com/my-app',
  production: {
    server: 'app.example.com',
    onDemandTlsUrl: 'http://127.0.0.1:3001/allowed',
  },
});
```

The proxy authorizes each hostname by calling `GET <url>?host=<hostname>` with a
matching `Host` header: a `200` allows issuance, any other response denies it.
`createOnDemandTlsAllowlist({ domains, allow?, headerName?, secret? })` from
`jsails/app` builds the Fetch-style handler for that endpoint, so an app mounts
it as a JSails API route or extension HTTP hook without reimplementing the
contract. It is app code: the endpoint runs in the production app. It is fail-closed: it
answers `200` only for an allowlisted hostname (exact match, case-insensitive,
trailing-dot tolerant) or when `allow(hostname)` resolves to exactly `true`, and
every other response is an empty-bodied `403` (or `400`/`405` for a malformed
request). Hostnames are never echoed.

The app owns that endpoint. An over-permissive `domains`/`allow`
policy — one that returns `200` for a hostname it does not control — lets
certificates be issued for unauthorized domains. On-demand TLS is released in
kamal-proxy v0.10.0; Kamal's default is still v0.9.2, so a proxy image bump is
needed.

### Domain routing

`jamal domain add|list|remove` controls kamal-proxy routing without re-running a
full deploy, over the same ssh path `deploy` takes. `add <host>` binds a host to
the LATEST deployed container (reconstructed from `.jamal/deploys.json`, so a
deploy must be recorded first), `remove <host>` removes the service — kamal-proxy
removes by service, so `<host>` is validated but the argv is service-scoped — and
`list` dumps the routing table. All three require `config.production`;
`--dry-run` prints the exact ssh argv without running it.

These verbs drive the proxy's runtime `deploy`/`remove` API over ssh, not
`deploy.yml`: a host added here is **not** recorded in `deploy.yml`, so a later
external `kamal deploy` may overwrite or conflict with it. Use on-demand TLS for
unknown/customer hosts; a static `production.domain` and on-demand TLS are
mutually exclusive.

### Cache proxy

An **opt-in** Varnish caching reverse proxy sits between kamal-proxy and the app
container, toggled by `cacheProxy` in the jamal config. It is default OFF:
absent or `enabled: false` leaves the topology unchanged (kamal-proxy → app
directly). When enabled the topology becomes `client → kamal-proxy (TLS,
routing, zero-downtime switch) → Varnish (plaintext, internal Docker network) →
app`; the release plan inserts `cache-proxy:write-vcl`, `cache-proxy:boot`, and
`cache-proxy:health` steps between the app health check and the kamal-proxy
`switch`, and the switch targets the Varnish container, not the app.

```ts
// jamal.config.ts
import { defineJamal } from '@jsails/jamal';

export default defineJamal({
  service: 'my-app',
  image: 'registry.example.com/my-app',
  cacheProxy: {
    enabled: true, // default false (opt-in)
    image: 'varnish:7.7', // default 'varnish:7.7'
    size: '256m', // default '256m'
    cookieAllowlist: ['locale'], // optional
  },
});
```

The generated VCL is default-deny and mirrors the app-side cache-control seam
(`private, no-store` by default; `public, s-maxage` plus `Surrogate-Control` only
on opt-in public routes, and only for 200, 203, 204, 206, 301, 308, 404, and 410
answers to requests with no session and no `Authorization` header — a signed-in
user's response is always private even on a route that exports `cacheControl`;
files under `public/` are `public` with a stat-derived weak `ETag`, and immutable
for a year only when the `?v=` value matches the file's current content hash):

- `return (pass)` for non-GET/HEAD, for `^/_jsails/`, and for any cookie-bearing
  request UNLESS every cookie is in `cookieAllowlist` (then those pairs are
  stripped and the request may be cached);
- `vcl_backend_response` caches ONLY when the origin sent `Surrogate-Control` or
  `Cache-Control` with a max-age (no header ⇒ uncacheable), sets `grace`, and
  never stores `Set-Cookie`.

CLI: `jamal cache-proxy <plan|status>` is read-only — `status` reports
enabled/image/size/allowlist, `plan` prints the resolved VCL — and never runs
docker or ssh.

Varnish was chosen because VCL puts cache-key, cookie-normalization, and bypass in one legible file, and Varnish gives request coalescing plus grace mode natively. It is plaintext-only by design and sits behind kamal-proxy, which owns TLS. nginx `proxy_cache` is the documented runner-up.

One limit is worth stating: the test suite never compiles the generated VCL with a real Varnish. It verifies the output by construction and string assertions, not with `varnish -C`.

### S3 object store

An **opt-in** `s3` backing service provisions a local S3-compatible store for
`S3Disk` (`@jsails/filesystem`). It is default OFF — absent from `services`, no
container starts. Add it to `services`, publish port `9000` in `local.ports`,
and set the credentials the `filesystem` plugin reads via `createDiskFromEnv`:

```ts
// jamal.config.ts
import { defineJamal } from '@jsails/jamal';

export default defineJamal({
  service: 'my-app',
  image: 'registry.example.com/my-app',
  services: {
    // ...existing backing services...
    s3: { type: 's3' },
  },
  local: { ports: { s3: 8333 } },
});
```

```sh
# .env (local development; never committed as secrets)
S3_ENDPOINT=http://127.0.0.1:8333
S3_BUCKET=app-storage
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=jsails
S3_SECRET_ACCESS_KEY=jsails-local-secret
S3_FORCE_PATH_STYLE=true
FILESYSTEM_DISK=s3
```

The image is pinned to `chrislusf/seaweedfs:3.91`. The store runs `weed server
-s3`, which starts master, volume, filer, and the S3 gateway in one process and
serves S3 on port 8333. SeaweedFS was chosen over MinIO because MinIO's
community edition was archived in February 2026 and its images were removed
from Docker Hub/Quay, so it can no longer be pulled reproducibly; SeaweedFS is
Apache-2.0, actively maintained, and publishes pinned semver tags.

`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (the names `createDiskFromEnv` reads)
are interpolated by Compose into the AWS-standard `AWS_ACCESS_KEY_ID`/
`AWS_SECRET_ACCESS_KEY` the S3 gateway uses as its development fallback, so the
app and the store share one credential pair. With at least one identity
configured the gateway runs in Authentication-Required mode rather than the
anonymous Allow-All default.

The bucket is **not** created by Jamal — Compose conventions are pure config.
Have the app or a live test create it with the S3 `CreateBucket` API against
the endpoint; `createDiskFromEnv` then wires `S3_*` into an `S3Disk`. The
opt-in live test (`packages/filesystem/test/s3-live.test.ts`,
`JSAILS_TEST_S3=1`) exercises put/get/exists/size/list/delete against the
running store.

## Server hardening

Jamal does not configure the server's firewall. On a fresh Debian or Ubuntu
host, review this UFW script and run it by hand (`sudo sh harden-server.sh`).
It is idempotent, and `sudo ufw disable` undoes it from the host console:

```sh
#!/bin/sh
set -eu

if ! command -v ufw >/dev/null 2>&1; then
  echo "ufw is not installed; install it first (apt-get install ufw)" >&2
  exit 1
fi

ufw default deny incoming
ufw default allow outgoing

# SSH first. If sshd listens on another port, allow that port here instead,
# or enabling the firewall locks you out.
ufw allow OpenSSH
# kamal-proxy serves HTTP and HTTPS.
ufw allow 80/tcp
ufw allow 443/tcp

if ! ufw status | grep -q '^Status: active'; then
  ufw --force enable
fi
```

Docker-published ports bypass UFW, because Docker writes its own rules into the
`FORWARD` chain; Jamal publishes no accessory port, and kamal-proxy's 80/443
are meant to be public. Also consider key-only SSH (`PasswordAuthentication
no`, `PermitRootLogin prohibit-password` in `/etc/ssh/sshd_config`) and
fail2ban's `sshd` jail.

## Static hosts

A static export (`jsails build` writing `out/`) needs no container and no
Jamal: every static host builds and serves it from its own config file. For
Netlify, `netlify.toml`:

```toml
[build]
  command = "npm run build"
  publish = "out"

[build.processing.html]
  pretty_urls = true

[[headers]]
  for = "/*"
  [headers.values]
    X-Content-Type-Options = "nosniff"
    X-Frame-Options = "SAMEORIGIN"
    Referrer-Policy = "strict-origin-when-cross-origin"
```

For Vercel, `vercel.json` with `"framework": null`, `"buildCommand": "npm run
build"`, `"outputDirectory": "out"`, `"cleanUrls": true`, and the same three
headers on `"source": "/(.*)"`. For Cloudflare Pages, `wrangler.toml` with the
project `name` and `pages_build_output_dir = "out"`, and the headers in
`out/_headers` (copy a `public/_headers` file). GitHub Pages serves `out/`
through the official `actions/upload-pages-artifact` and
`actions/deploy-pages` workflow, but cannot send custom response headers; set a
policy you need through `<meta http-equiv>` in the document head instead.

## Next steps

- [Testing](/docs/testing) — the in-process `createTestApp` surface.
- [CLI](/docs/cli) — `jsails jamal` and the rest of the `jsails` binary.
- [SEO](/docs/seo) — metadata, JSON-LD, sitemap, and robots.
