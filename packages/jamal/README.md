# @jsails/jamal

Jamal for [JSails](https://jsails.org): the `jamal` command that starts an app's backing services locally over Docker Compose (`jamal up`, `down`, `logs`, `ps`, `exec`) and deploys it to one server over SSH (`jamal deploy`, `rollback`, `status`, `app`, `accessory`, `domain`, `lock`), where `jamal backup <accessory>` and `jamal restore <accessory> <file>` dump and restore its MariaDB, PostgreSQL, and Valkey accessories. It is a regular dependency of the app: a deploy runs from a production install (CI with `npm ci --omit=dev`, or an operator's checkout), so the tool and the imports of `jamal.config.ts` must be present there.

```sh
npm install @jsails/jamal
```

The project's `jamal.config.ts` imports its config contract from the package:

```ts
import { defineJamal, secret } from '@jsails/jamal';

export default defineJamal({
  service: 'my-app',
  image: 'registry.example.com/my-app',
  env: { DATABASE_PASSWORD: secret('DATABASE_PASSWORD') },
  services: { db: { type: 'mariadb' } },
});
```

`service` names the app's local Compose project (its containers, network, and data volumes) and its production containers, so every app needs its own; a verb refuses (`project_in_use`) a project whose containers another directory created. Every verb resolves the project's environment the way the `jsails` CLI does (see [Configuration](https://jsails.org/docs/configuration#environment-files-and-credentials)). The local verbs (`up`, `down`, `ps`, `logs`, `exec`, and the dev-container shortcuts) run as `development` unless `JSAILS_ENV` names another; every other verb acts for the deployed app, so it runs as `production` unless `JSAILS_ENV` names another, and such an environment reads no `.env` file at all, only the real environment, `JSAILS_SECRETS_FILE` and its sealed credentials (see [Deploy](https://jsails.org/docs/deploy#secrets)). When that environment has sealed credentials, `jamal deploy` delivers their key ring to each release's secrets file itself (a rollback runs the previous release with the file it was deployed with), so `JSAILS_CREDENTIALS_KEY` is reserved in `.jamal/secrets*` and `config.env` (see [The credentials key](https://jsails.org/docs/deploy#the-credentials-key)). Loading the config also refuses a `config.env` key or alias for any other variable the environment resolver reserves (`NODE_ENV`, `JSAILS_SECRETS_FILE`, `JSAILS_ENV_RESOLVED`, `JSAILS_DEBUG`, and `JSAILS_ENV` other than as a clear entry; see [What runs on the server](https://jsails.org/docs/deploy#what-runs-on-the-server)). `jamal down` keeps the data volumes; `jamal down --volumes` deletes them after confirmation.

A deploy builds and pushes the committed checkout as `<image>:<release id>` (`YYYYMMDDHHMMSS-<sha12>`; a dirty tree needs `--allow-dirty`), then, holding the server's deploy lock, reads what the server holds and runs the release by its registry digest. The server is the only record: each release writes an immutable `releases/<id>/manifest.json` (image digest, commit, pinned proxy images, secret names) and the run compare-and-replaces `state.json` (the live and previous release); the proxy's target is the truth when they disagree. Every command a run sends under the lock carries the lock's token, so a run whose lock was force-released stops at its next command. `jamal rollback` runs the previous release again with its own image digest, secrets file, and recorded command; while kamal-proxy is down, the release `state.json` records stays live for `jamal app`, and a deploy or rollback is refused (`jamal_plan.proxy_down`) before it changes the server (see [What the server records](https://jsails.org/docs/deploy#what-the-server-records)).

Windows is supported for development only: there the local-services verbs run, and the verbs that reach a server refuse with `unsupported_platform`.

Documentation: <https://jsails.org/docs/deploy>
