/**
 * Help and usage text for the jamal command.
 *
 * Kept separate from control flow so the text can be reviewed and edited
 * without touching command logic. Every string is emitted verbatim and never
 * influences behavior.
 */

export const JAMAL_USAGE = `jamal - local services and single-host production deploys

Usage:
    jamal <verb> [options]

Jamal reads one config file, jamal.config.ts in the project root. The local
verbs drive Docker Compose on this machine; the production verbs drive one
server over ssh and run only on Linux and macOS.

Local Docker (Sail-like) verbs — require Docker with the compose plugin and
always act on the local project, even when the config has a production
section:
  up [--detach]           materialize .jamal/compose.yml from the config,
                          then docker compose up -d --wait
                          (detached and health-waited by default)
  down [--volumes [--yes]]
                          docker compose down: stop and remove the containers
                          and network; the named data volumes are kept, so
                          the next "up" finds the same data. --volumes then
                          also deletes every volume labelled with the project,
                          naming each one; it asks you to type the project
                          name, or --yes confirms without a prompt
  ps                      docker compose ps
  logs [--follow] [service]
                          docker compose logs
  exec <service> -- <cmd...>
                          docker compose exec <service> <cmd...>

down/ps/logs/exec use the managed .jamal/compose.yml and its project; run
"jamal up" to generate it first. The project is config.service, which names
the containers, network, and volumes, so give every app its own. While
containers of the project exist that another directory created, every local
verb refuses (project_in_use) rather than drive, replace, or delete them.

Every verb first resolves the project's environment as the jsails CLI does,
never overriding a variable already set, and "npx jsails jamal <verb>" gives a
verb the same environment as "npx jamal <verb>". JSAILS_ENV names it; NODE_ENV
follows from it (development, test, otherwise production), and a NODE_ENV that
contradicts it refuses the verb (environment.conflict):
  local verbs (up, down, ps, logs, exec, and the shortcuts) run as development
    unless JSAILS_ENV says otherwise: .env, .env.development, the development
    credentials, then .env.local. Compose interpolates the managed file from
    them.
  every other verb acts for the deployed app, production unless JSAILS_ENV
    names another (staging). Such an environment reads no .env file at all,
    only the real environment, JSAILS_SECRETS_FILE and its sealed
    credentials, so a $NAME in the secrets files never resolves to a
    development value. A sealed credentials document without its key refuses
    the verb (credentials.missing_key): set JSAILS_CREDENTIALS_KEY or add
    config/credentials/<env>.key. Started under a jsails command that resolved
    another environment, it refuses (environment.inherited_mismatch).
    Resolution consumes JSAILS_CREDENTIALS_KEY; deploy and rollback deliver
    the key ring of the sealed credentials to the app container themselves, in
    its release's secrets file, so the secrets files and config.env must not
    name it.

local.app in the config says where the app runs: "host" (the default; run
it yourself with "npm run dev"), "dev" (a container with the project mounted
and "jsails dev" reloading on save, like Laravel Sail), or "image" (built from
the project's Dockerfile, like production).

Dev-container shortcuts (local.app: "dev") — run one command in a fresh app
container, starting the services it depends on; every argument passes through:
  jsails <args...>        node_modules/.bin/jsails <args...>  (db:push, make:model, ...)
  npm <args...>           npm <args...>                       (install, run build, ...)
  npx <args...>           npx <args...>
  node <args...>          node <args...>
  test [args...]          npm test [-- args...]
  shell                   an interactive bash shell in the app container

Production verbs (require config.production; one server):
  deploy [--allow-dirty] [--dry-run]
                          Perform a real production deploy of the commit the
                          checkout is at: build and push the image locally,
                          then pull it by digest, run, health-check, switch,
                          and retire every other container of the app. The
                          server records the release (state.json and an
                          immutable manifest). A dirty tree is refused unless
                          --allow-dirty. --dry-run prints the plan.
  rollback [--dry-run]    Run the previous release the server records again,
                          with the image digest and secrets it ran with.
                          Pass --dry-run to print the plan and run nothing.
  status                  List containers on the server (docker ps)
  prune --keep <n> [--images <ref>...]
                          Plan which images to remove, keeping the <n> most
                          recent per service. Images must be passed explicitly
                          (e.g. from "docker image ls" output, newest first).
  secrets <print|fetch|extract> [name] [--destination <name>] [--secrets-path <path>]
                          Inspect the deploy secrets files (.jamal/secrets-common
                          then .jamal/secrets[.<destination>]). "print" lists the
                          resolved names only; "fetch <name>" prints one value;
                          "extract <key>" prints one value from a JSON secret.
  domain <add|list|remove>
                          Manage the proxy's public domains. See
                          "jamal domain --help".
  accessory <boot|start|stop|reboot|logs|remove|details> [name] [--follow] [--dry-run]
                          Manage backing service containers (mariadb, postgres,
                          valkey) on the server. See "jamal accessory --help".
  app <boot|start|stop|details|containers|logs|exec>
                          Manage the app container on the server. Every verb
                          targets the live release the server serves. See
                          "jamal app --help".
  lock <status|release> [--dry-run]
                          Show who holds the deploy lock, or remove a lock a
                          killed deploy left behind. See "jamal lock --help".
  backup <accessory> [--out <dir>]
                          Dump one accessory (mariadb, postgres, valkey) to
                          .jamal/backups/<app>-<accessory>-<time>.<ext> with a
                          .sha256 file beside it. See "jamal backup --help".
  restore <accessory> <file> [--yes]
                          Replace one accessory's data with a backup file.
                          See "jamal restore --help".
  cache-proxy <plan|status> [--release <id>]
                          Inspect the Varnish caching reverse-proxy (opt-in via
                          "cacheProxy.enabled"). See "jamal cache-proxy --help".

"jamal logs" and "jamal exec" always inspect the local Compose project; use
"jamal app logs" and "jamal app exec" for the deployed container.

Options:
  --dry-run        Print the production plan (deploy/rollback) and run nothing
  --detach         Accepted for \`up\`; already the default (up always detaches)
  --follow         Follow logs instead of a one-shot dump (logs only)
  --allow-dirty    Deploy uncommitted changes, recording the release as dirty
                   (deploy only)
  -h, --help       Show this help
`;

export const JAMAL_DEPLOY_USAGE = `jamal deploy - run a production release on the configured server

Usage:
  jamal deploy [options]

deploy EXECUTES a real production release of the commit the checkout is at.
It builds and pushes <image>:<release id> locally (the release id is the UTC
time and the commit, YYYYMMDDHHMMSS-<sha12>), then, holding the deploy lock,
reads what the server holds, pulls the image by its registry digest, runs,
health-checks, and switches to it on config.production.server, records it in
the server's state.json and an immutable release manifest, and retires every
other container of the app. A tree with uncommitted changes is refused.

Options:
  --allow-dirty    Deploy uncommitted changes, recording the release as dirty
  --dry-run        Print the plan from a read-only look at the server and run
                   nothing
  -h, --help       Show this help
`;

export const DOMAIN_USAGE = `jamal domain - manage the proxy's public domains

Usage:
  jamal domain <add|list|remove> [options]

Production only: "jamal domain" requires config.production (the remote server)
and resolves the backend service from --service (or config.service). Every verb
drives the running kamal-proxy container over ssh.

Subcommands:
  add <host>    Route <host> to the live release's container, terminating TLS
                at the proxy by default. The server names the live release, so
                it must already serve one. Holds the deploy lock.
  list          Dump the proxy's routing table on the remote server.
  remove <host> Remove the service (and its routed host) from the proxy. The
                proxy removes by service, so <host> names the domain but the
                operation is service-scoped.

Notes:
  These verbs drive the proxy's runtime deploy/remove API over ssh, not a config
  file: a host added here is NOT recorded in deploy.yml, so a later external
  "kamal deploy" may overwrite or conflict with it. Use on-demand TLS for
  unknown/customer hosts, and note that --tls static hosts and on-demand TLS are
  mutually exclusive.

Options:
  --service <name>  Backend service name (defaults to config.service)
  --no-tls          (add only) Do not terminate TLS at the proxy
  --dry-run         Print the exact ssh command without running it
  -h, --help        Show this help
`;

export const ACCESSORY_USAGE = `jamal accessory - manage backing service containers on the remote server

Usage:
  jamal accessory <boot|start|stop|reboot|logs|remove|details> [name] [options]

Production only: "jamal accessory" requires config.production (the remote server).
Every verb drives docker commands over ssh on the target server.

Verbs:
  boot [name]    Create the data volume (idempotent) and start the container
                 if it is not already running. With no name, boot every backing
                 service (mariadb, postgres, valkey).
  start [name]   Start an existing stopped container. No name -> all.
  stop [name]    Stop a running container. No name -> all.
  reboot [name]  Restart a container. No name -> all.
  logs <name> [--follow]
                 Show (or follow) the logs of one accessory container. Requires
                 a name (a single service; no "all" mode).
  remove [name]  Stop and remove a container (the data volume is left intact).
                 No name -> all.
  details <name> Show one accessory container's state, image, labels, mounts,
                 and networks as JSON, never its environment (it holds the
                 credentials). Requires a name.

Options:
  --follow        Follow logs instead of a one-shot dump (logs only)
  --dry-run       Print the exact ssh command(s) without running them
  -h, --help      Show this help
`;

export const APP_USAGE = `jamal app - manage the app container on the remote server

Usage:
  jamal app <boot|start|stop|details|containers|logs|exec> [options]

Production only: "jamal app" requires config.production (the remote server).
Every verb targets the web container of the live release, which the server's
state and proxy name (a production deploy must already serve one).

Verbs:
  boot            Start the app container if it is not already running.
  start           Start the live release's container.
  stop            Stop the live release's container.
  details         Show the live release's container's state, image, labels,
                  mounts, and networks as JSON, never its environment (it holds
                  the secrets).
  containers      List the app's containers on the server (filtered by service name).
  logs [--follow] Show (or follow) the logs of the live release's container.
  exec -- <cmd...>
                  Run <cmd...> inside the live release's container.
                  Requires "--" before the command.

Options:
  --follow        Follow logs instead of a one-shot dump (logs only)
  --dry-run       Print the exact ssh command without running it
  -h, --help      Show this help
`;

export const LOCK_USAGE = `jamal lock - inspect or clear the remote deploy lock

Usage:
  jamal lock <status|release> [options]

Production only: requires config.production (the remote server). A deploy,
rollback, backup, restore, or domain add holds a lock directory
(~/.jamal/apps/<service>[.<destination>]/lock on the server) for its whole
run and releases it when it ends, fails, or is interrupted with Ctrl-C. Every
command it sends runs only while the lock still holds its token, so a run
whose lock was released by force stops at its next command. One whose
process died outright cannot release it, and the next one then stops with
"the deploy lock is already held".

Verbs:
  status          Show whether the lock is held and, when recorded, by whom
                  (user@machine, the start time, the lock's sequence number,
                  and a backup or restore's verb and accessory).
  release         Remove the lock. Run it only when no deploy is running.

Options:
  --dry-run       Print the ssh command without running it
  -h, --help      Show this help
`;

export const CACHE_PROXY_USAGE = `jamal cache-proxy - inspect the Varnish caching reverse-proxy

Usage:
  jamal cache-proxy <plan|status> [options]

The cache proxy is opt-in (default OFF) and switchable by toggling
"cacheProxy.enabled" in the jamal config; "jamal deploy" boots it when enabled.
Both verbs are read-only: they load the config and print text, and never
execute docker or ssh.

Verbs:
  status          Report the cache-proxy configuration: enabled state, image,
                  size, and cookie allowlist, plus how to switch it.
  plan [--release <id>]
                  Print the VCL (Varnish Configuration Language) that
                  "jamal deploy" would write to ~/.jamal/cache-proxy/default.vcl,
                  with the cookie allowlist applied. The backend is the web
                  container of the given release. Requires "cacheProxy.enabled": true.

Options:
  --release <id>  Release id used to name the plan's backend container
                  (plan only; defaults to a <release-id> stand-in, since a
                  deploy chooses its id when it runs)

  -h, --help      Show this help
`;

export const BACKUP_USAGE = `jamal backup - dump one accessory on the remote server to a local file

Usage:
  jamal backup <accessory> [options]

Production only: requires config.production (the remote server). <accessory>
is a mariadb, postgres, or valkey key of config.services. The dump runs inside
the accessory container, with the credentials of the container's own
environment, and streams over ssh into
  <out>/<app>-<accessory>-<UTC time>.<ext>
(.sql for mariadb, .dump for postgres, .rdb for valkey), written to a partial
file and renamed into place once complete, mode 0600, with a sha256sum-format
<file>.sha256 beside it. The backup holds the deploy lock, so no deploy runs
meanwhile; the accessory keeps serving.

  mariadb     mariadb-dump --single-transaction --routines --triggers --events
              of the app database, as the app user
  postgres    pg_dump --format=custom of the app database
  valkey      BGSAVE, a wait for that save to complete, then dump.rdb

Options:
  --out <dir>     Directory to write to (default .jamal/backups, which the
                  starter's .gitignore covers); created mode 0700
  -h, --help      Show this help
`;

export const RESTORE_USAGE = `jamal restore - replace one accessory's data with a backup file

Usage:
  jamal restore <accessory> <file> [options]

Production only: requires config.production (the remote server). The file
must have the <file>.sha256 that "jamal backup" wrote, must match it, and must
be a dump of the accessory's kind; all three are checked before anything is
asked or sent. A restore replaces ALL of the accessory's data, so it needs
--yes, or the accessory name typed at the terminal. The dump is then sent
into the container and checked again there, before anything is replaced:

  mariadb     drop and recreate the app database, then load the dump as the
              app user with client commands disabled (--sandbox); a load
              that fails leaves the database partly restored
  postgres    load into a scratch database in one transaction, then swap it
              for the app database (open connections are ended); a load that
              fails leaves the app database untouched
  valkey      stop the container, make the dump the base of a fresh
              append-only directory and dump.rdb, start it, and wait until it
              answers; the stop, swap, and start run as one command on the
              server, so a dropped connection cannot leave it stopped

The restore holds the deploy lock. Take a backup first if the current data
may be needed again. Restore only files you trust: the checksum proves a
file is intact, not who wrote it, and a dump is executed by the database.

Options:
  --yes           Confirm replacing the accessory's data without a prompt
  -h, --help      Show this help
`;
