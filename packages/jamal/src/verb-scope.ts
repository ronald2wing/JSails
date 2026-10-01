/**
 * The one split of jamal's verbs into local verbs and server verbs.
 *
 * The local verbs drive the managed local Compose project (`up`, `down`,
 * `logs`, `ps`, `exec`) or run one command in the dev app container (the
 * shortcuts). Every other verb reaches, or plans for, the server: `deploy`,
 * `rollback`, `status`, `app`, `accessory`, `domain`, `lock`, `backup`,
 * `restore`, `prune`, `secrets`, and `cache-proxy`. Two rules follow from the
 * split: a server verb runs in the deployed app's environment rather than the
 * developer's (`bin.ts`), and it refuses on Windows (`platform.ts`).
 */

/** The verbs that act on this machine; every other verb is a server verb. */
const LOCAL_VERBS: ReadonlySet<string> = new Set([
  'up',
  'down',
  'logs',
  'ps',
  'exec',
  'jsails',
  'npm',
  'npx',
  'node',
  'test',
  'shell',
]);

/** Whether `verb` acts on this machine rather than for the deployed app. */
export function isLocalVerb(verb: string): boolean {
  return LOCAL_VERBS.has(verb);
}

/**
 * The environment the bin resolves for `verb` when `JSAILS_ENV` names none:
 * `development` for a local verb, `production` for a server verb, which acts
 * for the deployed app. `undefined` resolves nothing: a server verb on
 * Windows, which the command refuses with `unsupported_platform` before a
 * credentials refusal could preempt it, and which has no use for a
 * decryption.
 */
export function verbDefaultEnvironment(
  verb: string,
  platform: NodeJS.Platform = process.platform,
): 'development' | 'production' | undefined {
  if (isLocalVerb(verb)) return 'development';
  return platform === 'win32' ? undefined : 'production';
}
