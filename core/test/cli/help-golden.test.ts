/**
 * Golden help: what `jsails <command> --help` prints for every built-in
 * command equals that command's section of the committed CLI signature
 * (`api/cli.md`, written by `node scripts/cli-signature.mjs --write`). A
 * passthrough command hands `--help` to its program, so its section is held
 * against the help rendered from its descriptor instead.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { renderCommandHelp } from '../../src/cli/help.js';
import { BUILTIN_COMMANDS } from '../../src/cli/manifest.js';
import { CLI_SUITE_CONCURRENCY, runCli } from './spawn-cli.js';

const snapshot = readFileSync(new URL('../../../../api/cli.md', import.meta.url), 'utf8');
const dir = mkdtempSync(join(fileURLToPath(new URL('..', import.meta.url)), 'cli-golden-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** The help in `name`'s section of the snapshot. */
function section(name: string): string | undefined {
  const heading = `\n## ${name}\n\n\`\`\`text\n`;
  const start = snapshot.indexOf(heading);
  if (start === -1) return undefined;
  const end = snapshot.indexOf('```\n', start + heading.length);
  return end === -1 ? undefined : snapshot.slice(start + heading.length, end);
}

describe('golden help', { concurrency: CLI_SUITE_CONCURRENCY }, () => {
  it('lists exactly the built-in commands, in table order', () => {
    const headings = [...snapshot.matchAll(/^## (\S+)$/gm)].map((match) => match[1]);
    assert.deepEqual(
      headings,
      BUILTIN_COMMANDS.map((command) => command.name),
    );
  });

  for (const command of BUILTIN_COMMANDS) {
    it(`jsails ${command.name} --help`, async () => {
      const expected = section(command.name);
      assert.ok(expected !== undefined, `api/cli.md has no ${command.name} section`);
      if (command.passthrough === true) {
        assert.equal(renderCommandHelp(command), expected);
        return;
      }
      const result = await runCli([command.name, '--help'], { cwd: dir });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, expected);
    });
  }
});
