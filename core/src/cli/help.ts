/**
 * Help text, generated from descriptors: the global help (`jsails --help`)
 * and one command's (`jsails <command> --help`). Pure functions over data;
 * the global help's dependency and app sections are listed by
 * `command-lookup.ts`, which reads files and imports nothing from the
 * project.
 */

import type { CommandDescriptor, CommandOption, CommandPositional } from './descriptor.js';
import { HELP_OPTION, NO_INTERACTION_OPTION } from './command-args.js';

/** Width of the global help's command column, excluding the indent. */
const COMMAND_COLUMN = 22;

/** A two-column row: `left`, padded, then `right`; a long left side wraps. */
function row(left: string, right: string, width: number): string[] {
  if (right === '') return [`  ${left}`];
  return left.length < width
    ? [`  ${left.padEnd(width)}${right}`]
    : [`  ${left}`, `${' '.repeat(2 + width)}${right}`];
}

function positionalUsage(positional: CommandPositional): string {
  const name = positional.variadic === true ? `${positional.name}...` : positional.name;
  return positional.required === false ? `[<${name}>]` : `<${name}>`;
}

function optionUsage(flag: string, option: CommandOption): string {
  const short = option.short === undefined ? '    ' : `-${option.short}, `;
  const value = option.type === 'string' ? ` ${option.value ?? '<value>'}` : '';
  return `${short}--${flag}${value}`;
}

/** The parts of a descriptor its help shows. */
export type HelpSubject = Pick<
  CommandDescriptor,
  'name' | 'summary' | 'details' | 'options' | 'positionals' | 'passthrough'
>;

/**
 * One command's help. `interactiveFlag` lists `--no-interaction`, which the
 * commands that run app code take.
 */
export function renderCommandHelp(command: HelpSubject, interactiveFlag = false): string {
  const lines = [`jsails ${command.name} - ${command.summary}`, '', 'Usage:'];
  if (command.passthrough === true) {
    lines.push(`  jsails ${command.name} [arguments...]`);
  } else {
    const positionals = (command.positionals ?? []).map(positionalUsage);
    lines.push(`  ${['jsails', command.name, '[options]', ...positionals].join(' ')}`);
  }
  const positionals = command.positionals ?? [];
  if (positionals.length > 0) {
    const width = Math.max(...positionals.map((positional) => positional.name.length + 4)) + 2;
    lines.push('', 'Arguments:');
    for (const positional of positionals) {
      lines.push(...row(positionalUsage(positional), positional.summary, width));
    }
  }
  if (command.passthrough !== true) {
    const options: [string, CommandOption][] = [
      ...Object.entries(command.options),
      ...(interactiveFlag
        ? [['no-interaction', NO_INTERACTION_OPTION] as [string, CommandOption]]
        : []),
      ['help', HELP_OPTION],
    ];
    const usages = options.map(([flag, option]) => optionUsage(flag, option));
    const width = Math.min(Math.max(...usages.map((usage) => usage.length)) + 2, 30);
    lines.push('', 'Options:');
    options.forEach(([, option], index) => {
      lines.push(...row(usages[index] as string, option.summary, width));
    });
  }
  if (command.details !== undefined && command.details.length > 0) {
    lines.push('', ...command.details);
  }
  return `${lines.join('\n')}\n`;
}

/** A command a dependency declares, as help lists it. */
export interface ListedDependencyCommand {
  readonly name: string;
  readonly summary: string;
  readonly packageName: string;
}

/** An app command, as help lists it: its summary only when the cache knows the file. */
export interface ListedAppCommand {
  readonly name: string;
  readonly summary: string | undefined;
  /** Its source exists but its built module does not. */
  readonly unbuilt: boolean;
}

/** What the global help lists besides the built-ins. */
export interface GlobalHelpSections {
  readonly dependencies: readonly ListedDependencyCommand[];
  readonly app: readonly ListedAppCommand[];
  /** Value-free lines about declarations help could not use. */
  readonly problems: readonly string[];
}

/** The global help: built-ins, then dependency and app commands, then the globals. */
export function renderGlobalHelp(
  builtins: readonly Pick<CommandDescriptor, 'name' | 'summary'>[],
  sections: GlobalHelpSections,
): string {
  const lines = [
    'jsails - TypeScript application framework CLI',
    '',
    'Usage:',
    '  jsails [--env <name>] <command> [options]',
    '',
    'Commands:',
  ];
  for (const command of builtins) lines.push(...row(command.name, command.summary, COMMAND_COLUMN));
  if (sections.dependencies.length > 0) {
    lines.push('', 'Commands from dependencies:');
    for (const command of sections.dependencies) {
      lines.push(
        ...row(command.name, `${command.summary} (${command.packageName})`, COMMAND_COLUMN),
      );
    }
  }
  lines.push('', 'App commands (dist/commands/):');
  if (sections.app.length === 0) lines.push('  none');
  for (const command of sections.app) {
    const summary = command.unbuilt ? 'not built: run the build first' : (command.summary ?? '');
    lines.push(...row(command.name, summary, COMMAND_COLUMN));
  }
  if (sections.problems.length > 0) {
    lines.push('', 'Problems:', ...sections.problems.map((problem) => `  ${problem}`));
  }
  lines.push(
    '',
    'Global options (before the command):',
    ...row(
      '--env <name>',
      'The environment to run as (default: JSAILS_ENV, or development)',
      COMMAND_COLUMN,
    ),
    ...row('--version', 'Print the jsails version', COMMAND_COLUMN),
    ...row('-h, --help', 'Show this help', COMMAND_COLUMN),
    '',
    'Run "jsails <command> --help" for the options of one command.',
  );
  return `${lines.join('\n')}\n`;
}
