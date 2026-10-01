/**
 * `defineCommand`: how a dependency or an app writes a command.
 *
 * ```ts
 * // commands/invoices/send.ts, run as `jsails invoices:send 42 --force`
 * export default defineCommand({
 *   summary: 'Send one invoice',
 *   options: { force: { type: 'boolean', summary: 'Send it again' } },
 *   positionals: [{ name: 'id', summary: 'The invoice id' }],
 *   needs: { services: [] },
 *   async run(ctx) {
 *     await sendInvoice(ctx.services.registry.get(invoicesToken), ctx.positionals[0]);
 *     ctx.stdout('sent');
 *   },
 * });
 * ```
 *
 * The name is not part of the definition: an app command's comes from its
 * path under `commands/` (`invoices/send` is `invoices:send`), a dependency
 * command's from its package's `jsails.commands`. The definition is checked
 * here, once, and frozen; the dispatcher accepts a module's default export
 * only when this function made it. Such a command always opens the sealed
 * credentials and needs at least the resolved environment: it is app code,
 * and the dispatcher resolves the environment before it imports the module.
 */

import type { Awaitable } from '../contracts/awaitable.js';
import { PLUGIN_ROLES, type PluginRole } from '../plugins/contract/lifecycle.js';
import type {
  CommandContext,
  CommandNeeds,
  CommandOption,
  CommandOptions,
  CommandPositional,
} from './descriptor.js';
import { CliErrors } from './errors.js';

/** The brand of a {@link DefinedCommand}; `Symbol.for`, so a second framework copy agrees. */
const DEFINED_COMMAND: unique symbol = Symbol.for('jsails.defined-command') as never;

/**
 * What a dependency or app command may need: at least the environment.
 *
 * @public
 */
export type DefinedCommandNeeds = Exclude<CommandNeeds, 'nothing'>;

/**
 * What {@link defineCommand} takes.
 *
 * @public
 */
export interface CommandDefinition<
  O extends CommandOptions = CommandOptions,
  N extends DefinedCommandNeeds = DefinedCommandNeeds,
> {
  /** One line for help. */
  readonly summary: string;
  /** Its options, by flag name; `--help` and `--no-interaction` are added. */
  readonly options?: O;
  /** Its positional arguments, in order. */
  readonly positionals?: readonly CommandPositional[];
  /** What the dispatcher sets up before `run`; defaults to `environment`. */
  readonly needs?: N;
  /** Lines its help prints under the options. */
  readonly details?: readonly string[];
  /** The command body; nothing returned is exit code 0. */
  run(context: CommandContext<O, N>): Awaitable<number | void>;
}

/**
 * A checked, frozen command definition.
 *
 * @public
 */
export interface DefinedCommand<
  O extends CommandOptions = CommandOptions,
  N extends DefinedCommandNeeds = DefinedCommandNeeds,
> {
  readonly [DEFINED_COMMAND]: true;
  readonly summary: string;
  readonly options: O;
  readonly positionals: readonly CommandPositional[];
  readonly needs: N;
  readonly details: readonly string[];
  run(context: CommandContext<O, N>): Awaitable<number | void>;
}

const FLAG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const POSITIONAL = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const RESERVED_FLAGS = new Set(['help', 'no-interaction']);
const MAX_LINE = 200;

function isLine(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_LINE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validOptions(options: unknown): boolean {
  if (!isRecord(options)) return false;
  const shorts = new Set<string>(['h', 'n']);
  for (const [flag, option] of Object.entries(options)) {
    if (!FLAG.test(flag) || RESERVED_FLAGS.has(flag) || !isRecord(option)) return false;
    if (option['type'] !== 'string' && option['type'] !== 'boolean') return false;
    if (!isLine(option['summary'])) return false;
    const short = option['short'];
    if (short !== undefined) {
      if (typeof short !== 'string' || !/^[a-zA-Z]$/.test(short) || shorts.has(short)) {
        return false;
      }
      shorts.add(short);
    }
    if (option['multiple'] !== undefined && typeof option['multiple'] !== 'boolean') return false;
    if (option['value'] !== undefined && !isLine(option['value'])) return false;
  }
  return true;
}

function validPositionals(positionals: unknown): boolean {
  if (!Array.isArray(positionals)) return false;
  let optionalSeen = false;
  return positionals.every((positional: unknown, index) => {
    if (!isRecord(positional)) return false;
    if (typeof positional['name'] !== 'string' || !POSITIONAL.test(positional['name'])) {
      return false;
    }
    if (!isLine(positional['summary'])) return false;
    const required = positional['required'];
    const variadic = positional['variadic'];
    if (required !== undefined && typeof required !== 'boolean') return false;
    if (variadic !== undefined && typeof variadic !== 'boolean') return false;
    if (variadic === true && index !== positionals.length - 1) return false;
    if (required !== false && optionalSeen) return false;
    if (required === false) optionalSeen = true;
    return true;
  });
}

function validRoles(roles: unknown): roles is readonly PluginRole[] {
  return (
    Array.isArray(roles) &&
    roles.every((role) => (PLUGIN_ROLES as readonly unknown[]).includes(role))
  );
}

/** Whether `needs` is a needs level a dependency or app command may declare. */
function validNeeds(needs: unknown): needs is DefinedCommandNeeds {
  if (needs === 'environment' || needs === 'app' || needs === 'plugins') return true;
  if (!isRecord(needs)) return false;
  const keys = Object.keys(needs);
  if (keys.length !== 1) return false;
  return (
    (keys[0] === 'services' && validRoles(needs['services'])) ||
    (keys[0] === 'kernel' && validRoles(needs['kernel']))
  );
}

function freezeNeeds(needs: DefinedCommandNeeds): DefinedCommandNeeds {
  if (typeof needs === 'string') return needs;
  return 'services' in needs
    ? Object.freeze({ services: Object.freeze([...needs.services]) })
    : Object.freeze({ kernel: Object.freeze([...needs.kernel]) });
}

function invalid(
  field: 'definition' | 'summary' | 'options' | 'positionals' | 'needs' | 'details' | 'run',
): Error {
  return new CliErrors.Error('invalid_command_definition', { field });
}

/**
 * Define a command for a dependency's `jsails.commands` or an app's
 * `commands/` directory. Throws `cli.invalid_command_definition`, naming the
 * field, for a malformed definition.
 *
 * @public
 */
export function defineCommand<
  const O extends CommandOptions = Record<never, never>,
  const N extends DefinedCommandNeeds = 'environment',
>(definition: CommandDefinition<O, N>): DefinedCommand<O, N> {
  if (!isRecord(definition)) throw invalid('definition');
  if (!isLine(definition.summary)) throw invalid('summary');
  const options = definition.options ?? {};
  if (!validOptions(options)) throw invalid('options');
  const positionals = definition.positionals ?? [];
  if (!validPositionals(positionals)) throw invalid('positionals');
  const needs = definition.needs ?? 'environment';
  if (!validNeeds(needs)) throw invalid('needs');
  const details = definition.details ?? [];
  if (!Array.isArray(details) || !details.every((line) => typeof line === 'string')) {
    throw invalid('details');
  }
  if (typeof definition.run !== 'function') throw invalid('run');
  const run = definition.run.bind(definition);
  return Object.freeze({
    [DEFINED_COMMAND]: true as const,
    summary: definition.summary,
    options: Object.freeze(
      Object.fromEntries(
        Object.entries(options).map(([flag, option]) => [
          flag,
          Object.freeze({ ...(option as CommandOption) }),
        ]),
      ),
    ) as unknown as O,
    positionals: Object.freeze(positionals.map((positional) => Object.freeze({ ...positional }))),
    needs: freezeNeeds(needs) as N,
    details: Object.freeze([...details]),
    run,
  });
}

/**
 * Whether `value` is a command {@link defineCommand} made.
 *
 * @public
 */
export function isDefinedCommand(value: unknown): value is DefinedCommand {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[DEFINED_COMMAND] === true
  );
}
