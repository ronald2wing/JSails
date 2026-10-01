import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';

import { Command, commandFromClass, isCommandClass } from '../../src/cli/command-class.js';
import { collectConfigCommands, createCliCommandRegistry } from '../../src/cli/command-registry.js';
import { discoverAppCommands } from '../../src/cli/discovery.js';
import { defineCommandJob } from '../../src/jobs/command-job.js';

const fixturesRoot = mkdtempSync(join(tmpdir(), 'jsails-command-class-'));

after(() => {
  rmSync(fixturesRoot, { recursive: true, force: true });
});

function context(): {
  readonly configPath: string;
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly interactive: boolean;
  readonly lines: string[];
} {
  const lines: string[] = [];
  return {
    configPath: 'jsails.app.js',
    cwd: fixturesRoot,
    stdout: (text) => lines.push(text),
    stderr: (text) => lines.push(`[stderr] ${text}`),
    interactive: false,
    lines,
  };
}

class GreetCommand extends Command {
  static readonly signature = 'greet {name} {--loud}';
  static readonly summary = 'Greet someone';
  static readonly audience = 'user' as const;

  async handle(): Promise<number> {
    const name = this.argument('name') ?? 'world';
    const greeting = this.option('loud') === true ? name.toUpperCase() : name;
    this.stdout(`Hello, ${greeting}!`);
    return 0;
  }
}

describe('class-based commands', () => {
  it('adapts a command class to the CliCommand contract', async () => {
    const command = commandFromClass(GreetCommand);
    assert.equal(command.name, 'greet');
    assert.equal(command.summary, 'Greet someone');
    assert.equal(command.audience, 'user');

    const ctx = context();
    assert.equal(await command.run(['Ada', '--loud'], ctx), 0);
    assert.deepEqual(ctx.lines, ['Hello, ADA!']);
  });

  it('recognizes command classes structurally', () => {
    assert.equal(isCommandClass(GreetCommand), true);
    assert.equal(isCommandClass(class NotACommand {}), false);
    assert.equal(GreetCommand.toCliCommand().name, 'greet');
  });

  it('instantiates one command instance per invocation', async () => {
    let instances = 0;
    class CountCommand extends Command {
      static readonly signature = 'count';
      static readonly summary = 'Count';
      readonly id = ++instances;

      handle(): number {
        this.stdout(String(this.id));
        return 0;
      }
    }

    const command = commandFromClass(CountCommand);
    const first = context();
    const second = context();
    await command.run([], first);
    await command.run([], second);
    assert.deepEqual(first.lines, ['1']);
    assert.deepEqual(second.lines, ['2']);
  });

  it('works in config-declared command arrays', async () => {
    const [command] = collectConfigCommands({ commands: [GreetCommand] });
    assert.ok(command);
    const registry = createCliCommandRegistry([command]);
    const ctx = context();
    assert.equal(await registry.run('greet', ['Ada'], ctx), 0);
    assert.deepEqual(ctx.lines, ['Hello, Ada!']);
  });

  it('is discoverable as a compiled default export', async () => {
    const root = join(fixturesRoot, 'discover');
    const commandsDir = join(root, 'commands');
    mkdirSync(commandsDir, { recursive: true });
    const indexUrl = pathToFileURL(new URL('../../src/index.js', import.meta.url).pathname).href;
    writeFileSync(
      join(commandsDir, 'greet.js'),
      `import { Command } from ${JSON.stringify(indexUrl)};
export default class GreetCommand extends Command {
  static signature = 'greet {name}';
  static summary = 'Greet someone';
  async handle() { this.stdout('Hello, ' + this.argument('name') + '!'); return 0; }
}
`,
    );

    const commands = await discoverAppCommands(root);
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.name, 'greet');
    const ctx = context();
    assert.equal(await commands[0]?.run(['Ada'], ctx), 0);
    assert.deepEqual(ctx.lines, ['Hello, Ada!']);
  });

  it('can be wrapped as a command job', () => {
    const job = defineCommandJob(GreetCommand, { name: 'greetJob', args: ['Ada'] });
    assert.equal(job.name, 'greetJob');
    assert.equal(job.schema.safeParse({}).success, true);
  });
});
