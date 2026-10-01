# @jsails/jamal

Jamal for [JSails](https://jsails.org): the `jamal` command that starts an app's backing services locally over Docker Compose (`jamal up`, `down`, `logs`, `ps`, `exec`) and deploys it to one server over SSH (`jamal deploy`, `rollback`, `status`, `app`, `accessory`, `domain`, `lock`). It is a regular dependency of the app: a deploy runs from a production install (CI with `npm ci --omit=dev`, or an operator's checkout), so the tool and the imports of `jamal.config.ts` must be present there.

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

Windows is supported for development only: there the local-services verbs run, and the verbs that reach a server refuse with `unsupported_platform`.

Documentation: <https://jsails.org/docs/deploy>
