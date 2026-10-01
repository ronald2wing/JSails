/**
 * The option set shared by the `flags` built-in commands, and the checks that
 * reject a flag passed to a command that does not read it.
 *
 * Every check runs before the command's implementation is imported, so a typo
 * fails fast without loading TypeORM, BullMQ, or the app.
 */

export const GLOBAL_OPTIONS = Object.freeze({
  config: { type: 'string', short: 'c' },
  'app-config': { type: 'string' },
  name: { type: 'string' },
  'jsails-dependency': { type: 'string' },
  'package-dependency': { type: 'string', multiple: true },
  install: { type: 'boolean', default: false },
  'no-git': { type: 'boolean', default: false },
  admin: { type: 'boolean', default: false },
  blog: { type: 'boolean', default: false },
  saas: { type: 'boolean', default: false },
  cli: { type: 'boolean', default: false },
  starter: { type: 'boolean', default: false },
  'allow-destructive': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  sql: { type: 'boolean', default: false },
  only: { type: 'string', multiple: true },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} as const);

type GlobalFlag = keyof typeof GLOBAL_OPTIONS;

const CREATE_ONLY = ['create'] as const;

/** Flags read by a subset of commands; `config` and `help` apply everywhere. */
const FLAG_COMMANDS: ReadonlyArray<readonly [GlobalFlag, readonly string[]]> = [
  ['allow-destructive', ['db:push']],
  ['dry-run', ['db:push']],
  ['sql', ['db:diff']],
  ['app-config', ['db:push', 'db:diff']],
  ['name', CREATE_ONLY],
  ['jsails-dependency', CREATE_ONLY],
  ['package-dependency', CREATE_ONLY],
  ['install', CREATE_ONLY],
  ['no-git', CREATE_ONLY],
  ['admin', CREATE_ONLY],
  ['blog', CREATE_ONLY],
  ['saas', CREATE_ONLY],
  ['cli', CREATE_ONLY],
  ['starter', CREATE_ONLY],
  ['only', ['seed']],
  ['json', ['queue', 'schedules']],
];

/** Mutually exclusive `create` presets, each with the presets it rejects. */
const PRESET_CONFLICTS: ReadonlyArray<readonly [GlobalFlag, readonly GlobalFlag[]]> = [
  ['cli', ['starter', 'admin', 'blog', 'saas']],
  ['starter', ['admin', 'blog', 'saas']],
  ['saas', ['admin', 'blog']],
];

function isSet(value: unknown): boolean {
  return value !== undefined && value !== false;
}

function joinFlags(flags: readonly string[]): string {
  const named = flags.map((flag) => `--${flag}`);
  return named.length <= 2
    ? named.join(' or ')
    : `${named.slice(0, -1).join(', ')}, or ${named.at(-1) as string}`;
}

/**
 * The usage error for a flag combination `command` does not accept, or
 * `undefined` when every flag is valid for it.
 */
export function invalidFlagMessage(
  command: string,
  values: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const [flag, commands] of FLAG_COMMANDS) {
    if (isSet(values[flag]) && !commands.includes(command)) {
      return `--${flag} is only valid for ${commands.join(' and ')}`;
    }
  }
  if (command !== 'create') {
    return undefined;
  }
  if (values.config !== undefined) {
    return 'create does not take --config';
  }
  for (const [preset, conflicts] of PRESET_CONFLICTS) {
    if (isSet(values[preset]) && conflicts.some((other) => isSet(values[other]))) {
      return `--${preset} cannot be combined with ${joinFlags(conflicts)}`;
    }
  }
  return undefined;
}

/**
 * The value of `flag` in `argv`, given either as the following token or in the
 * `--flag=value` form; `undefined` when the flag is absent or has no value.
 */
export function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === flag) {
      return argv[index + 1];
    }
    if (token !== undefined && token.startsWith(`${flag}=`)) {
      return token.slice(flag.length + 1);
    }
  }
  return undefined;
}
