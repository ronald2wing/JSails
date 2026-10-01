/**
 * The command authoring surface, on the root entry and on `jsails/kernel`:
 * `defineCommand` for a dependency's `jsails.commands` or an app's
 * `commands/` modules, the context its `run` receives (prompts included, as
 * `context.prompter`), and the `cli.*` codes.
 */

export {
  defineCommand,
  isDefinedCommand,
  type CommandDefinition,
  type DefinedCommand,
  type DefinedCommandNeeds,
} from '../cli/define-command.js';

export type {
  CommandContext,
  CommandInvocation,
  CommandNeeds,
  CommandOption,
  CommandOptions,
  CommandPositional,
  CommandValues,
  Prompter,
} from '../cli/descriptor.js';

export { CliErrors } from '../cli/errors.js';
