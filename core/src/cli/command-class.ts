/**
 * Class-based CLI commands.
 *
 * A command class is the file-level authoring shape:
 *
 * ```ts
 * export default class SendInvoice extends Command {
 *   static readonly signature = 'invoices:send {id} {--force}';
 *   static readonly summary = 'Send one invoice';
 *
 *   async handle(): Promise<number> {
 *     await sendInvoice(this.argument('id')!, { force: this.option('force') === true });
 *     this.stdout('sent');
 *     return 0;
 *   }
 * }
 * ```
 *
 * The class is instantiated once per invocation. The base injects the parsed
 * arguments/options and the command context; `defineCommand` remains the inline
 * authoring form for simple or config-declared commands.
 */

import type { Awaitable } from '../internal/awaitable.js';
import type { CliCommand, CommandAudience } from './command-registry.js';
import {
  defineCommand,
  type CommandContext,
  type ParsedCommandInput,
  type Prompter,
  SignatureError,
} from './command-signature.js';

/** Constructor shape accepted by {@link commandFromClass}. */
export interface CommandClass<T extends Command = Command> {
  new (): T;
  readonly signature: string;
  readonly summary?: string;
  readonly usage?: string;
  readonly audience?: CommandAudience;
  toCliCommand(): CliCommand;
}

/**
 * Base class for a file-level command.
 *
 * `signature` is required on every concrete subclass. `summary`, `usage`, and
 * `audience` are optional; `defineCommand` supplies the same defaults as the
 * inline form.
 */
export abstract class Command {
  declare static readonly signature: string;
  declare static readonly summary?: string;
  declare static readonly usage?: string;
  declare static readonly audience?: CommandAudience;

  #input: ParsedCommandInput | undefined;
  #context: CommandContext | undefined;

  /** Parsed positional arguments. Available only inside `handle`. */
  protected get arguments(): ParsedCommandInput['arguments'] {
    return this.#requireInput().arguments;
  }

  /** Parsed options. Available only inside `handle`. */
  protected get options(): ParsedCommandInput['options'] {
    return this.#requireInput().options;
  }

  /** The original raw tokens. */
  protected get rawArgs(): readonly string[] {
    return this.#requireInput().rawArgs;
  }

  /** The invocation context (stdout/stderr/cwd/config/prompter). */
  protected get context(): CommandContext {
    if (this.#context === undefined) {
      throw new SignatureError('command context is only available while the command runs');
    }
    return this.#context;
  }

  /** Interactive prompt helpers. */
  protected get prompter(): Prompter {
    return this.context.prompter;
  }

  /** Read one positional argument. */
  protected argument(name: string): string | undefined {
    return this.arguments[name];
  }

  /** Read one option. */
  protected option(name: string): string | boolean | undefined {
    return this.options[name];
  }

  /** Write a line to stdout. */
  protected stdout(text: string): void {
    this.context.stdout(text);
  }

  /** Write a line to stderr. */
  protected stderr(text: string): void {
    this.context.stderr(text);
  }

  /** The command body. */
  abstract handle(): Awaitable<number | void>;

  /** @internal Run one invocation. */
  async execute(input: ParsedCommandInput, context: CommandContext): Promise<number | void> {
    this.#input = input;
    this.#context = context;
    return this.handle();
  }

  /** Build the `CliCommand` adapter for this class. */
  static toCliCommand(): CliCommand {
    return commandFromClass(this as unknown as CommandClass);
  }

  #requireInput(): ParsedCommandInput {
    if (this.#input === undefined) {
      throw new SignatureError('command input is only available while the command runs');
    }
    return this.#input;
  }
}

/** True when `value` is a command class (extends {@link Command}). */
export function isCommandClass(value: unknown): value is CommandClass {
  return typeof value === 'function' && value.prototype instanceof Command;
}

/**
 * Adapt a command class to the runtime `CliCommand` contract. The class is
 * instantiated per invocation, so command state never leaks between runs.
 */
export function commandFromClass(CommandType: CommandClass): CliCommand {
  if (!isCommandClass(CommandType)) {
    throw new SignatureError('command class must extend Command');
  }
  if (typeof CommandType.signature !== 'string' || CommandType.signature.trim() === '') {
    throw new SignatureError('command class must declare a non-empty static signature');
  }
  return defineCommand({
    signature: CommandType.signature,
    ...(CommandType.summary === undefined ? {} : { summary: CommandType.summary }),
    ...(CommandType.usage === undefined ? {} : { usage: CommandType.usage }),
    ...(CommandType.audience === undefined ? {} : { audience: CommandType.audience }),
    async run(input, context) {
      const command = new CommandType();
      return command.execute(input, context);
    },
  });
}
