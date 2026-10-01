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

`service` is the app's identity on every Docker host: the local Compose
project (Compose names the containers, network, and named data volumes after
it) and the prefix of the production containers and their volumes. It must
start with a lowercase letter or digit and use only lowercase letters, digits,
`_`, and `-` (at most 63 characters), Docker's project-name rule. Give every
app its own: two projects with one `service` on a machine share containers and
data. `jsails create` writes the app's name there (`@acme/shop` becomes
`acme-shop`; a name longer than 63 characters is cut and ends with a short
digest of the whole name). Renaming it later starts from empty volumes,
locally and on the server; the volumes under the old name stay until you
remove them.

Compose records on each container the directory it created it from. While
containers of the project exist that another directory created, every local
verb (`up`, `down`, `ps`, `logs`, `exec`, and the shortcuts) refuses with
`project_in_use` instead of replacing, stopping, or deleting another app's
containers and data. Volumes carry no directory, so once the other app's
containers are gone the check cannot see it: a unique `service` is what keeps
two apps apart.

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

Every local verb first resolves the project's environment the way the
`jsails` CLI does, as `development` unless `JSAILS_ENV` names another: `.env`,
`.env.development`, the sealed credentials, then `.env.local`, never
overriding a variable already set in the shell (see
[Configuration](/docs/configuration#environment-files-and-credentials)). Compose interpolates the managed file's
`${DATABASE_PASSWORD}`-style references from that environment, so
`npx jamal up` and `npx jsails jamal up` start the same containers. The values
reach only the `docker compose` process; `.jamal/compose.yml` holds the names.

`down` stops and removes the project's containers and network and **keeps its
named volumes**: the database, Valkey data, and (with `app: 'dev'`) the
`node_modules` volume survive, and the next `up` finds them. To start from
empty, delete them explicitly:

```sh
npx jamal down --volumes        # asks you to type the project name
npx jamal down --volumes --yes  # confirmed without a prompt (scripts, CI)
```

`down --volumes` takes the project down, then deletes every volume Docker
labels with its Compose project (`com.docker.compose.project=<service>`),
including one left by a service since removed from the config, and prints the
name of each volume it removed. Another project's volumes are never touched,
and the `project_in_use` check runs before the prompt.
Without a terminal to ask and without `--yes` it refuses with
`confirmation_required`.

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
  including the test database chosen by `.env.test`, works as on the host.
  A `VALKEY_URL` with a password or database number is replaced by the plain
  service address. With one `s3` service, jamal also sets
  `S3_FORCE_PATH_STYLE=true` and `S3_CONDITIONAL_WRITES=false`, because the
  SeaweedFS store it provisions serves path-style requests only and ignores
  `If-None-Match`.
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

`jamal deploy` runs a **production release** of the commit the checkout is
at, to the one server `production.server` names. `--dry-run` prints the plan
and runs nothing.

```sh
npx jamal deploy
npx jamal deploy --dry-run
npx jamal deploy --allow-dirty
npx jamal rollback
```

A release is named by its **release id**, `YYYYMMDDHHMMSS-<sha12>`: the UTC
time it was prepared and the first 12 hex digits of the commit. A deploy
builds and pushes `<image>:<release id>` locally and reads back the digest
the registry gave it (`docker image inspect` of `RepoDigests`; a push that
left none fails as `jamal_release_source.digest_unknown`). Then, holding the
deploy lock, it reads what the server holds, plans the release from that, and
runs it: it writes the release's secrets file and manifest, pulls the image
**by digest** (`<image>@sha256:…`), runs and health-checks the new container,
switches traffic to it, records it in the server's `state.json`, and retires
every other container of the app. A tree with uncommitted changes is refused
(`jamal_release_source.dirty_tree`), because the image would not match the
commit it is named after; `--allow-dirty` deploys it anyway and records the
release as dirty. A project that is no git checkout with a commit is refused
as `jamal_release_source.not_a_checkout`.

`rollback` runs the previous release the server records again, with the image
digest, the secrets file, and the web container and command that release was
deployed with (its manifest's, whatever `config.command` says now), and also
executes by default, with `--dry-run` as its preview. It needs that release's
manifest, with a web role, and its secrets file on the server
(`jamal_plan.no_previous`, `jamal_plan.no_web_role`, or
`jamal_plan.secrets_missing` otherwise) and builds nothing. `--dry-run` for
either verb reads the server (the same read-only commands the run starts
with), so the plan shows what is live, what the run would repair, and which
containers it would retire; it builds, pushes, locks, and changes nothing, and
shows `<digest>` for the digest a push would produce.

`status` lists remote containers, and `app logs`/`app exec` inspect the live
release's container. These verbs require `config.production`.

Production execution first provisions the declared backing services
(MariaDB/Postgres/Valkey accessory containers). `jamal app <verb>` drives the
container of the release the server serves (`containers` lists every
container labelled `jsails.service=<service>`), and `jamal accessory <verb>`
manages the backing-service containers; both require `config.production` and
support `--dry-run`.
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
  the project root (`docker buildx build -t <image>:<release id> .`). A project without
  one fails with `missing_dockerfile` before anything touches the server: no
  lock is taken. `npx jsails make:dockerfile` generates one (see
  [The production image](#the-production-image)). A rollback deploys an image
  already built and needs no Dockerfile.
- **App container.** It is named `<app>-web-<release id>`, where `<app>` is
  the service, or `<service>.<destination>` for a destination, and starts with
  `--restart unless-stopped`, the `jsails.service`, `jsails.destination`,
  `jsails.role` and `jsails.release` labels,
  `JSAILS_ENV=production`, `NODE_ENV=production`, and
  `JSAILS_HOST=0.0.0.0`/`JSAILS_PORT=3000`, and the
  `JSAILS_TRUSTED_PROXIES=hops=<n>` the proxies in front of it require (see
  [Proxies in front of the app](#proxies-in-front-of-the-app)). A `clear` entry in `config.env`
  overrides `JSAILS_HOST`, `JSAILS_PORT`, or `JSAILS_ENV`, and the release
  passes the `NODE_ENV` the chosen `JSAILS_ENV` derives (`staging` runs with
  `NODE_ENV=production`, `test` with `NODE_ENV=test`), since the app stops
  with `environment.conflict` on a `NODE_ENV` that contradicts it; kamal-proxy targets
  `<container>:3000`. Named `config.volumes` become `<service>_<name>` Docker
  volumes, and `config.command` runs as the container command.
- **Health check.** By default the check runs inside the new container
  (`docker exec <container> node -e "fetch(...)"` against
  `127.0.0.1:3000<health.path>`), so the image needs `node`. Each attempt is
  bounded by `health.timeoutMs`, and the deploy fails after the retry budget.
  On a failed health check or switch, the new container is removed and the
  previous one keeps serving. After the switch and the state write, every
  other container of the app is stopped and removed, the previous release's
  included, whichever run started it: a container left behind by a killed run
  is retired by the next deploy. A container that cannot be removed is a
  warning, not a failure, since the new release already serves and is
  recorded.
- **Same commit.** Redeploying the live commit makes a new release (its id
  carries the time), so the new container never shares a name with the one
  that serves, which keeps serving until the new one is healthy and switched
  in.
- **Cache proxy.** When it is enabled and already running on the configured
  image, each deploy rewrites the VCL (`~/.jamal/cache-proxy/default.vcl` on
  the server) and reloads it with `varnishreload`, so Varnish keeps serving.
  The container mounts that directory, not the file, read-only at
  `/etc/varnish`: the write replaces the file by a rename, which a single-file
  mount would never show the container. A missing container, a changed image,
  or a failed reload replaces the container instead, which briefly interrupts
  traffic through it.
- **Remote file writes.** Every file jamal writes on the server (a release's
  secrets file, the VCL, an accessory's env file) goes through one writer. The
  bytes travel over ssh stdin, never in a command line, behind a header line
  with their size and SHA-256. The server writes a unique temporary file beside
  the destination, checks the size and digest with `sha256sum`, `shasum -a 256`
  or `openssl dgst -sha256` (whichever it has; with none the write is refused
  as `jamal_remote_file.no_hasher`), checks that the deploy lock still holds
  this run's token when the write happens under it
  (`jamal_remote_file.lock_lost` otherwise), sets the mode, flushes the file
  to disk and renames it into place. The destination therefore holds its
  previous contents or the whole new file, never a part of one: a dropped
  connection fails the write as `jamal_remote_file.checksum_mismatch` and
  leaves nothing behind. Paths are relative to the ssh user's home, and the
  directories a write creates under `~/.jamal` are mode `0700`.
- **Bind mounts.** A deploy reads the ssh user's home on the server once,
  under the lock and before its first step (`pwd -P` in the ssh session), and
  mounts every host directory by absolute path below it: a release's
  `secrets/`, the cache proxy's VCL directory, and a `config.volumes` source
  written as `./<path>` or `$PWD/<path>`, which is `<home>/<path>` on the
  server. No mount relies on the Docker CLI resolving a relative source
  (only Docker 23 and later do; an older CLI takes `./` for a volume name),
  so a server's distro Docker 20.10 works. A home whose path contains `:`
  (it would split the `-v` value), or a shell startup file that prints
  something in a non-interactive ssh session, stops the deploy as
  `jamal_host_home.unusable_home`. `jamal deploy --dry-run` reads the home the
  same way and shows the mounts below it.
- **Secrets file.** The app's secrets reach its container as one JSON file,
  `{ "v": 1, "values": { "NAME": "value" } }`, written per release to
  `~/.jamal/apps/<app>/releases/<release id>/secrets/secrets.json`, created
  once, never replaced, so a rollback runs with the secrets its release was
  deployed with.
  The container mounts the `secrets/` directory read-only at
  `/run/jsails/secrets` and is started with
  `JSAILS_SECRETS_FILE=/run/jsails/secrets/secrets.json`, which the app's
  environment resolver reads just below the real environment
  ([Configuration](/docs/configuration)). The release directory is mode
  `0700`, so no other user on the host reaches the file, while `secrets/` is
  `0755` and the file `0444`, so the app reads it whatever uid its image runs
  as. A JSON string carries any value byte for byte (a PEM block, backslashes,
  `$`, quotes, non-ASCII); a value containing a NUL or a broken UTF-16
  character cannot reach a process environment, and is refused before
  anything is built, with an error naming only its key
  (`jamal_secrets_file.unrepresentable_value`). Every release writes the file,
  with no secrets too, and the app container receives no `--env-file`.
- **Accessory env files.** An accessory's credentials go to
  `~/.jamal/apps/<app>/accessories/<name>.env` (mode
  `0600`), which its stock image reads with `--env-file`. Docker reads
  everything after the first `=` literally, so values are written verbatim
  (backslashes, quotes, `=` and `#` reach the container unchanged); a value
  containing a newline, carriage return, NUL or broken UTF-16 character, or
  an entry longer than 65535 bytes (the longest line Docker's env-file reader
  accepts), cannot be carried in a Docker env file and fails the deploy with
  an error naming only its key (`jamal_env_file.*`).
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
- **Reserved variables.** The variables the JSails environment resolver keeps
  for a run's real environment are refused as a `config.env` key or alias
  when jamal loads the config, by every verb, with an `invalid_config` error
  that names the key (never its value) and the fix: `NODE_ENV` (the app
  derives it from `JSAILS_ENV`; set `JSAILS_ENV` instead),
  `JSAILS_CREDENTIALS_KEY` (a deploy delivers it, see
  [The credentials key](#the-credentials-key)), `JSAILS_SECRETS_FILE`,
  `JSAILS_ENV_RESOLVED`, and `JSAILS_DEBUG` (set it for the one run you are
  debugging, not in a committed config). `JSAILS_ENV` itself is accepted
  only as a clear entry under its own name (a literal, or a `secret()` with
  `clear: true`), because only a clear `-e` outranks the release's own; a
  literal must be an environment name, and a clear secret is checked once it
  resolves, before the plan runs. Without this the app container would
  refuse to start (`environment.conflict`) or quietly run with a setting no
  operator chose.

### The production image

The server-rendered starters (`--admin`, `--saas`, `--blog`) ship a
`Dockerfile` and a `.dockerignore`. Any other server-rendered project
generates the same pair:

```sh
npx jsails make:dockerfile                     # Dockerfile + .dockerignore
npx jsails make:dockerfile --health-path /healthz
npx jsails make:dockerfile --force             # replace both
```

It refuses to replace an existing file (`--force` replaces both, a symbolic
link itself rather than its target), and it writes the `.dockerignore` first,
so a failed run never leaves a `Dockerfile` without it. The same
flags always produce the same bytes, so a regenerated file diffs cleanly
against a committed one. `--health-path <path>` follows the app's
`healthPath`; `--no-healthcheck` is for an app that set `healthPath: false`.
`--dir <project>` writes into another directory. The files are yours to edit
once generated; jamal only builds whatever `Dockerfile` the project root holds.

The image is built in three stages from one `node:26-trixie-slim` base (the
Node line of the framework's `engines` floor), so native modules compiled
during the install run on the same libc at run time:

| Stage | What it does |
| --- | --- |
| `deps` | `npm ci --omit=dev`: the production dependencies only |
| `build` | `npm ci`, then `npm run build`: compiled server output, `.jsails/`, and the client bundle |
| runtime | the built tree without its `node_modules`, secrets, or `storage/`, over the `deps` stage's `node_modules` |

Both installs keep npm's cache in a BuildKit cache mount, so a rebuild with an
unchanged lockfile downloads nothing. The build needs a committed
`package-lock.json` (`npm ci` refuses to run without one) and a `build` script;
`make:dockerfile` warns when either is missing. Both installs see only
`package.json` and `package-lock.json`, so a dependency installed from a
`file:` path needs a `COPY` of that path before them, and one outside the
project cannot be built at all, since it is outside the build context.

The runtime stage matches what a deploy expects:

- **Port and host.** `JSAILS_PORT=3000` and `JSAILS_HOST=0.0.0.0` are set in the
  image as well as on `docker run`, so a container started without them
  (`local.app: 'image'`, a plain `docker run`) still listens where
  kamal-proxy targets it. `JSAILS_ENV=production` and `NODE_ENV=production`
  are set in the runtime stage only: in the build stage `NODE_ENV` would make
  `npm ci` skip the compiler and bundler, and `jsails build` needs no
  production secrets.
- **Health.** The `HEALTHCHECK` runs the same probe as the deploy's health
  step, `node -e "fetch(...)"` against `127.0.0.1:$JSAILS_PORT<health path>`
  with a 5 s timeout, so `docker ps` and Compose's `service_healthy` agree with
  the deploy's verdict. Keep `health.path` in `jamal.config.ts`, the app's
  `healthPath`, and the image's path equal (`/up` by default).
- **User and files.** The app runs as the unprivileged `node` user. Its files
  are owned by root and read-only to it; only `storage/` (the default local
  disk, `storage/files`) is writable. The starters' `jamal.config.ts` mounts a
  named volume there (`volumes: { storage: '/app/storage' }`), so uploads
  survive a deploy that replaces the container; a new volume takes the
  directory's `node` ownership from the image.
- **Signals.** The command is `node node_modules/.bin/jsails serve` in exec
  form, so `node` is PID 1 and receives the `SIGTERM` that `docker stop` and a
  deploy's retirement step send; `jsails serve` drains and exits 0 on it. No
  init process is added. An app whose own code starts child processes that
  can outlive their parent should add one (install `tini` and make it the
  `ENTRYPOINT`), since `node` as PID 1 does not reap orphans.
- **Secrets.** No build argument or secret mount exists. The `.dockerignore`
  keeps `.env` and `.env.*`, `.jamal/`, `config/credentials/*.key`,
  `storage/`, and local SQLite files out of the build context, together with
  `.git/`, `jamal.config.ts`, `node_modules/`, the build output (rebuilt in the
  image, so a stale host copy never shadows it), and tests and their output.
  The runtime stage's copy excludes `.env`, `.env.*`, `.jamal`, the credential
  keys, and `storage` again, so an edited or missing `.dockerignore` still
  ships none of them. An encrypted `config/credentials/production.enc` is built in and opened at
  run time with the key `jamal deploy` delivers (see
  [The credentials key](#the-credentials-key)).

`config.command` replaces the image's command, so the same image can run a job
worker (`node_modules/.bin/jsails work`, the app's `worker` role from the same
`jsails.app.js`). A worker needs a shared jobs transport (BullMQ over Valkey):
over the in-memory adapter both `serve` and `work` refuse to start
(`kernel.adapter_not_shared`), because their jobs could never meet; a
single-process deploy runs `jsails serve --with worker` instead.

### Shutdown and live streams

On `SIGTERM` the retiring container drains under one deadline,
`shutdownTimeoutMs` (5 s by default; see
[Configuration](/docs/configuration#shutdown)):

1. the health route answers `503`, so the proxy stops routing to it, the
   server stops accepting connections, and every in-flight answer closes its
   connection;
2. every live stream ends, and every realtime transport (the broadcast and
   live plugins' Socket.IO servers) disconnects its clients, which reconnect
   to the new container;
3. everything else runs to completion: requests in flight and finite streams.

A stream that never ends must say so. `Respond.eventStream` always does;
`Respond.stream(source, init, { live: true })` does for any other content
type (an NDJSON feed, a log tail). A live stream ends cleanly when the drain
starts: its client sees the stream finish, its producer is cancelled, and the
route's `ctx.signal` aborts with `serve.draining`, so a producer waiting on
something else should race that signal:

```ts
// api/ticks.ts
import { defineApi, publicAccess, Respond } from 'jsails/api';

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export default defineApi('/api/ticks', {
  access: publicAccess('a public tick feed'),
  GET: ({ signal }) =>
    Respond.stream(
      (async function* () {
        while (!signal.aborted) {
          yield '{"tick":1}\n';
          await pause(1000, signal);
        }
      })(),
      { headers: { 'content-type': 'application/x-ndjson' } },
      { live: true },
    ),
});
```

An endless stream that is not declared live holds the drain until the
deadline. Whatever is still open then is stopped: each request's `ctx.signal`
aborts with `serve.stopped`, each unfinished stream is reported to `onError`
as `serve.unfinished_stream` (with its route), every socket is destroyed, and
`jsails serve` exits with `serve.shutdown_timeout`, which counts the streams,
requests and connections left open and names the drain participants that
had not finished.

A plugin whose serve hook attaches something to the server (a WebSocket
server, any `upgrade` listener) returns it as a drain participant; see
[Extending](/docs/extending#serve-hooks).

### What the server records

The server is the only record of what is deployed; nothing is written in the
project. Under `~/.jamal/apps/<app>/`:

- `releases/<release id>/manifest.json` describes one release and is never
  changed: the image by digest, the commit and whether the tree was dirty,
  the container and command of each role, the names (never the values) and
  the SHA-256 of its secrets, a digest of the config it was planned from, the
  jsails version, the pinned kamal-proxy and cache-proxy images it was served
  through, the release it was deployed over, when, and by whom. It is written
  create-only before the release's container starts, so every container of
  the app is named by a manifest.
- `state.json` names the live release and the previous one (the release a
  rollback returns to), the lock sequence number of the run that wrote it,
  when, and by whom. A run replaces it only if it still holds the bytes the
  run read (compare-and-replace), and only under the lock.

Before it plans anything, a deploy or rollback reads the server: `state.json`,
the manifests, which releases still have a secrets file, the app's
containers, the proxy's route, and the proxy's image. The proxy's target (or,
behind the cache proxy, the backend its VCL names) is the truth: when
`state.json` disagrees, because a run was killed between the switch and the
state write or the file was lost or damaged, the plan starts with a
`repair-state` step that rewrites it to match, and the next deploy or rollback
proceeds from what actually serves. `jamal deploy --dry-run` shows the live
and previous release it found and the repair it would make.

A kamal-proxy that is stopped or missing says nothing about what serves, so
it is not read as a host with nothing live: the release `state.json` records
stays the live one, and `jamal app` still reaches its container. A deploy or
rollback of a routed app is refused while the proxy is down
(`jamal_plan.proxy_down`), before it pulls, records, or starts anything,
since its switch could not run; so is `jamal domain add`. Start the
kamal-proxy container, then run it again.

A release runs pinned images only: the app's by its registry digest, and
kamal-proxy's and the cache proxy's by theirs. A routed release refuses to
plan when kamal-proxy runs an image no registry digest names
(`jamal_plan.unpinned_proxy`): run kamal-proxy from an image pulled by its
digest, such as the `basecamp/kamal-proxy@sha256:8278e2f5…` default jamal pins
(v0.10.0).

### Deploy lock

A deploy, rollback, backup, restore, or `domain add` holds
`~/.jamal/apps/<app>/lock` on the server. The lock directory holds a random
token and `owner.json`: who holds it, from which machine, since when, for
what, and a sequence number that grows with every acquisition (`lock.seq`
beside the directory). It is released when the run ends, fails, or is
interrupted with Ctrl-C or SIGTERM, and only while it is still the lock that
run took. Every command a run sends to the server while it holds the lock
carries the token, and the server refuses it (`jamal_lock.lock_lost`) once the
lock holds another token or none: a run whose lock was force-released stops
at its next command and never changes the server again, and it leaves the
next holder's lock in place. An ssh failure is reported as "could not be
reached", not as contention, and `lock status` reports a status it could not
read as an error, never as "not held". A run whose process died outright
leaves the lock behind. Inspect and clear it:

```sh
npx jamal lock status     # held or not, by whom, and its sequence number
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

The host environment a server verb sees is the deployed app's, not your
development shell's. Every jamal verb other than the local ones (`up`, `down`,
`ps`, `logs`, `exec`, and the dev-container shortcuts) runs this way, whether
started as `npx jamal` or `npx jsails jamal`:

- The environment is `production` unless `JSAILS_ENV` names another, so
  `JSAILS_ENV=staging npx jamal deploy` acts for staging. `NODE_ENV` follows
  from it (`production` for both), and a contradicting real `NODE_ENV`
  refuses the verb (`environment.conflict`).
- Such an environment reads **no `.env` file at all**: only the real
  environment, a secrets file named by `JSAILS_SECRETS_FILE`, and that
  environment's sealed credentials (`config/credentials/production.enc`).
  `.env`, `.env.local` and `.env.production` are never read, so a value your
  machine runs the app with (the starter's `.env` holds the local database's
  address and password) can never be shipped to the server. Put a deploy-time
  value in the real environment or the production credentials.
- A sealed `production.enc` without its key refuses the verb with
  `credentials.missing_key`, naming `JSAILS_CREDENTIALS_KEY` and
  `config/credentials/production.key`, rather than deploying without the
  secrets.
- A verb started beneath a JSails command that already resolved another
  environment (a project command run under `jsails` that calls `jamal
  deploy`) refuses with `environment.inherited_mismatch`: that parent's
  values arrived as real variables that win over every layer, as
  `JSAILS_ENV_RESOLVED` records. Run the verb from a plain shell, or as
  `npx jsails jamal`, which forwards before it resolves anything.
- On Windows a server verb resolves nothing and refuses with
  `unsupported_platform`.

The local verbs run as `development` unless `JSAILS_ENV` names another:
`.env`, `.env.development`, the development credentials, then `.env.local`,
which Compose interpolates into the managed file.

`secrets/` is gitignored via the starter's `.jamal/` entry; values never enter
the config, the plan, logs, or `ps`. Each `secret('NAME')` entry in the
config's `env` map resolves here and is written to the release's **secrets
file** on the server, which the container mounts read-only (see
[What runs on the server](#what-runs-on-the-server)), never signalled on the
`docker run` command line. A literal string stays on the clear channel (`-e NAME=VALUE`); `{
clear: true }` opts a secret reference into the clear channel, and `{ alias:
'OTHER' }` renames the variable inside the container.

```ts
// jamal.config.ts
import { defineJamal, secret } from '@jsails/jamal';

export default defineJamal({
  service: 'my-app',
  image: 'registry.example.com/my-app',
  env: {
    DATABASE_PASSWORD: secret('DATABASE_PASSWORD'), // secret channel (secrets file)
    DATABASE_HOST: secret('DATABASE_HOST'), // secret channel
    LOG_LEVEL: 'info', // clear channel (-e)
    PUBLIC_URL: { value: secret('DOMAIN'), clear: true }, // clear override
  },
});
```

`production.destination` selects `.jamal/secrets.<destination>` and addresses
the app's server directory as `<service>.<destination>`; `production.secretsPath` relocates
the files. The `jamal secrets` verbs operate directly on the files:

```sh
npx jamal secrets print                          # list names, no values
npx jamal secrets fetch DATABASE_PASSWORD        # print one resolved value
npx jamal secrets extract VAULT/db/password      # JSON path: secret "VAULT", path "db/password"
npx jamal secrets fetch DB_URL --destination production
npx jamal secrets print --secrets-path .jamal/secrets
```

### The credentials key

An app that keeps its secrets in encrypted credentials (see
[Configuration](/docs/configuration#environment-files-and-credentials)) needs
one value on the server: the key ring that opens
`config/credentials/production.enc` in its image. `jamal deploy` delivers it
into each release's secrets file itself, and `jamal rollback` runs the
previous release with the file it was deployed with, so the key that sealed
its image; there is nothing to declare.

- The verb's environment resolution opens the sealed document for the
  environment it acts for, with `JSAILS_CREDENTIALS_KEY` when it is set (a CI
  job that holds only the variable) or `config/credentials/production.key`
  (your machine). It then removes the variable from its environment, so no
  `$(...)` command in a secrets file and no child process sees the key.
- The release adds that same ring (the current key and, during a rotation,
  the previous one), as `JSAILS_CREDENTIALS_KEY`, to the release's secrets
  file, beside the app's other secrets. The app's environment resolver lifts
  it out of the file to open the sealed document: it never becomes a variable
  of the container, so `docker inspect` cannot show it. The key never appears
  in an argv, the plan, the output, or a file on your machine, and the image
  never carries it.
- Without a sealed document for the environment nothing is delivered, and a
  sealed document without its key refuses the verb
  (`credentials.missing_key`) before anything is deployed.
- Accessories never receive it: their env files hold only their own
  credentials.
- `jamal app details` and `jamal accessory details` print a container's
  state, image, labels, mounts, and networks, never its environment, which
  holds an accessory's credentials and any secret a config opted onto the
  clear channel.

`JSAILS_CREDENTIALS_KEY` is therefore reserved. A secrets file that defines it
is refused (`reserved_secret`) before any of its commands run, `config.env` may
not name it as a variable, an alias, or a `secret()` (like the other
[reserved variables](#what-runs-on-the-server)), and `jamal secrets print`
lists it as delivered while `fetch` and `extract` refuse to print it.

The ring belongs to one environment, so the container must run as that
environment: the release starts it with `JSAILS_ENV=production` (and
`NODE_ENV=production`), and a deploy for another environment
(`JSAILS_ENV=staging npx jamal deploy`) sets `JSAILS_ENV` as a clear
`config.env` entry to match, or stops with
`jamal_credentials.environment_mismatch`. The config refuses a `JSAILS_ENV`
delivered through the secrets file, which the app refuses as a reserved key.

To rotate the key, run `jsails credentials rotate --env production`, commit
the re-sealed `production.enc`, update `JSAILS_CREDENTIALS_KEY` wherever CI
holds it to the key file's two keys, and deploy: the image carries the new
document and the secrets file the ring with both keys, so a rollback to an image
sealed under the previous key still opens its document. Once no release you
may roll back to uses the old document, run `jsails credentials rotate
--finish --env production`, update the variable again, and deploy.

### Image retention

`jamal prune --keep <n> [--images <ref>...]` plans which images to remove,
keeping the `n` most recent per service. It never runs Docker: pass the images
explicitly (for example from `docker image ls` on the server, newest first) and
review the plan.

### Backups

`jamal backup` dumps one production accessory to a file on your machine; `jamal
restore` puts a dump back. Both run over the same SSH connection as `jamal
deploy`, hold the deploy lock (so no deploy runs meanwhile), and run on Linux
and macOS only.

```sh
npx jamal backup db                    # .jamal/backups/my-app-db-20261121T164012Z.sql
npx jamal backup cache --out ~/backups # any directory
npx jamal restore db .jamal/backups/my-app-db-20261121T164012Z.sql
```

The dump runs inside the accessory container and takes its credentials from the
container's own environment, the env file jamal wrote when it started the
accessory, so no password appears on a command line or leaves the server:

| Accessory | Dump | File |
| --- | --- | --- |
| `mariadb` | `mariadb-dump --single-transaction --routines --triggers --events` of `DATABASE_NAME`, as `DATABASE_USER` | `.sql` |
| `postgres` | `pg_dump --format=custom` of the app database | `.dump` |
| `valkey` | `BGSAVE`, a wait for that save to complete, then `dump.rdb` | `.rdb` |

A MariaDB backup needs `DATABASE_NAME`, `DATABASE_USER`, and `DATABASE_PASSWORD`
in `config.env`; the image gives root a random password jamal never sees, so the
app user dumps its own database. The accessory keeps serving while it is dumped.

The file streams into a partial file and is renamed into place only once
complete. It is mode 0600, in a mode-0700 directory, and has a `<file>.sha256`
beside it in `sha256sum` format, so `sha256sum -c
my-app-db-20261121T164012Z.sql.sha256` checks it anywhere. `.jamal/` is in the
starter's `.gitignore`; keep backups out of version control, since they hold
your data.

#### Restoring

A restore replaces **all** of the accessory's data. Before it asks anything or
contacts the server, jamal checks that the file has its `.sha256`, that it
matches, and that it is a dump of the accessory's kind. A PostgreSQL dump is
refused for a MariaDB accessory, whatever the file is called. It then asks you
to type the accessory name, or takes `--yes` in scripts and CI. The dump is sent
into the container and checked again there, so a dump that arrived damaged
replaces nothing:

- **MariaDB:** the database is dropped, recreated, and loaded from the dump as
  the app user, with the client's shell and file commands disabled
  (`--sandbox`). If the load fails, the database is left partly restored; run
  the restore again.
- **PostgreSQL:** the dump is loaded into a scratch database in one transaction,
  then swapped in for the app database. Open connections are ended, and the app
  reconnects. If the load or the swap fails, the app database is left as it was.
- **Valkey:** the container is stopped, the dump becomes the base of a fresh
  append-only directory (and `dump.rdb`), and the container is started and
  checked with `PING`. The stop, swap, and start run as one command on the
  server, so a dropped connection or Ctrl-C cannot leave Valkey stopped, and a
  failed swap starts it on its previous data. Valkey runs with `appendonly yes`,
  which ignores a bare `dump.rdb`, so replacing that file alone would not
  restore anything.

Take a backup before a restore if the current data may be needed again. Restore
only files you trust: the checksum proves a file is intact, not who wrote it,
and the database executes what a dump contains. If a backup or restore was
killed outright, `jamal lock status` shows it as the holder (`… (backup db)`),
and `jamal lock release` clears it.

Schedule `jamal backup` from another machine (cron, CI) and keep the dumps off
the server, since a backup on the host it protects is lost with that host.

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

### Proxies in front of the app

The app keys its rate limits and records sessions on the client address, which
behind a proxy only the proxy can state. Jamal derives which proxies the app
trusts from the ones it deploys and passes the setting as
`JSAILS_TRUSTED_PROXIES` to the web container: `hops=1` for kamal-proxy,
`hops=2` with the cache proxy. A proxy in front of kamal-proxy (a CDN, a load
balancer) is declared under `proxy`, with the address ranges it connects from:

```ts
// jamal.config.ts
import { defineJamal } from '@jsails/jamal';

export default defineJamal({
  service: 'my-app',
  image: 'registry.example.com/my-app',
  proxy: { forwardHeaders: true, upstreamCidrs: ['173.245.48.0/20', '2400:cb00::/32'] },
});
```

`forwardHeaders: true` makes kamal-proxy keep the `X-Forwarded-For` chain the
upstream proxies wrote (`--forward-headers`; jamal's TLS deploy otherwise has
it replace the chain), and `upstreamCidrs` lists every range the CDN or load
balancer publishes. kamal-proxy's ports stay public, so a client can always
connect to it around the CDN; the ranges, not a count, are what keep such a
client from naming its own address (the setting becomes
`hops=1,<ranges>`, see the table in
[Origin, hosts and proxies](/docs/deployment-proxies#deploying-with-jamal)).
Either key without the other is refused with `invalid_config` before anything
is built, and a range the app cannot read is refused when the config loads.
`config.env` may not name `JSAILS_TRUSTED_PROXIES`. `--dry-run` shows the
setting in the `check` and `run` steps.

Before it starts a release, `jamal deploy` (and `jamal rollback`) runs
`jsails check --deploy` once inside the new image, with the release's
environment and no network. A config that would not serve (no
`server.origin` among the release's variables) or whose
`server.trustedProxies` disagrees with the setting jamal states stops the
deploy at the `check` step, with the previous release still serving; the
findings are printed in the deploy's output. See
[`jsails check --deploy`](/docs/deployment-proxies#jsails-check---deploy) and the
warnings the app emits when the trust does not match.

### Domain routing

`jamal domain add|list|remove` controls kamal-proxy routing without re-running a
full deploy, over the same ssh path `deploy` takes. `add <host>` binds a host to
the release the server serves (read under the deploy lock, so a release must be
live first) through the same route the deploy's switch uses:
the cache proxy when it is enabled, the health path, and `--forward-headers`,
since kamal-proxy's `deploy` replaces every option of the service. `remove
<host>` removes the service — kamal-proxy
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
    // A digest-pinned reference; a tag alone is refused. The default is the
    // official varnish:7.7 image, pinned by digest.
    image: 'varnish@sha256:3f3df388d03695f4ff1efe75cc69a4311d8c5d44411cd99d2f0707056b056f29',
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
files under `public/` are `public` with a content-hash `ETag`, and immutable
for a year only when the `?v=` value matches the file's current content hash):

- `return (pass)` for non-GET/HEAD, for `^/_jsails/`, and for any cookie-bearing
  request UNLESS every cookie is in `cookieAllowlist` (then those pairs are
  stripped and the request may be cached);
- `vcl_backend_response` caches ONLY when the origin sent `Surrogate-Control` or
  `Cache-Control` with a max-age (no header ⇒ uncacheable), sets `grace`, and
  never stores `Set-Cookie`.

CLI: `jamal cache-proxy <plan|status>` is read-only — `status` reports
enabled/image/size/allowlist, `plan` prints the resolved VCL, its backend the
web container of the release `--release <id>` names (or a `<release-id>`
stand-in) — and never runs docker or ssh.

Varnish was chosen because VCL puts cache-key, cookie-normalization, and bypass in one legible file, and Varnish gives request coalescing plus grace mode natively. It is plaintext-only by design and sits behind kamal-proxy, which owns TLS. nginx `proxy_cache` is the documented runner-up.

One limit is worth stating: the test suite never compiles the generated VCL with a real Varnish. It verifies the output by construction and string assertions, not with `varnish -C`.

### S3 object store

An **opt-in** `s3` backing service provisions a local S3-compatible store for
`S3Disk` (`@jsails/filesystem`). It is default OFF — absent from `services`, no
container starts. Add it to `services`, publish port `9000` in `local.ports`,
and set the credentials the `filesystem` plugin's `env` disk reads:

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
S3_CONDITIONAL_WRITES=false # SeaweedFS ignores If-None-Match
FILESYSTEM_DISK=s3
```

The image is pinned to `chrislusf/seaweedfs:3.91`. The store runs `weed server
-s3`, which starts master, volume, filer, and the S3 gateway in one process and
serves S3 on port 8333. SeaweedFS was chosen over MinIO because MinIO's
community edition was archived in February 2026 and its images were removed
from Docker Hub/Quay, so it can no longer be pulled reproducibly; SeaweedFS is
Apache-2.0, actively maintained, and publishes pinned semver tags.

`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (the names the `filesystem` plugin declares)
are interpolated by Compose into the AWS-standard `AWS_ACCESS_KEY_ID`/
`AWS_SECRET_ACCESS_KEY` the S3 gateway uses as its development fallback, so the
app and the store share one credential pair. With at least one identity
configured the gateway runs in Authentication-Required mode rather than the
anonymous Allow-All default.

The bucket is **not** created by Jamal — Compose conventions are pure config.
Have the app or a live test create it with the S3 `CreateBucket` API against
the endpoint; the plugin's `env` disk then wires `S3_*` into an `S3Disk`. The
opt-in live test (`packages/filesystem/test/s3-live.test.ts`,
`JSAILS_TEST_S3=1`) exercises write/read/stat/list/delete, multipart writes
and a signed URL against the running store.

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
