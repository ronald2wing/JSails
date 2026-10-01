/**
 * `jsails agents:setup` — emits `.mcp.json`, `AGENTS.md`, and the loadable
 * JSails skill, with exclusive creation and idempotent re-runs.
 */

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  runAgentsSetupCommand,
  type AgentsSetupDeps,
} from '../../../src/cli/commands/agents-setup.js';

/**
 * The command resolves its outputs against `cwd` with the platform's path
 * rules, so the in-memory files are keyed the same way (`D:\app\...` on
 * Windows).
 */
const root = resolve('/app');

function at(relative: string): string {
  return resolve(root, relative);
}

function depsFor(): { deps: AgentsSetupDeps; files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    deps: {
      exists: (path) => files.has(path),
      readFile: async (path) => files.get(path) ?? '',
      writeFile: async (path, content) => {
        files.set(path, content);
      },
      mkdir: async () => undefined,
      cwd: root,
    },
  };
}

describe('agents:setup', () => {
  it('writes all three canonical artifacts', async () => {
    const { files, deps } = depsFor();
    const code = await runAgentsSetupCommand({ force: false }, deps);
    assert.equal(code, 0);
    assert.ok(files.get(at('.mcp.json'))?.includes('"jsails"'));
    assert.ok(files.get(at('AGENTS.md'))?.length !== undefined);
    assert.ok(files.get(at('AGENTS.md'))?.includes('JSails'));
    assert.ok(files.get(at('.agents/skills/jsails/SKILL.md'))?.includes('jsails_describe'));
  });

  it('merges the jsails server into an existing .mcp.json without clobbering', async () => {
    const { files, deps } = depsFor();
    files.set(at('.mcp.json'), '{"mcpServers":{"other":{"command":"x"}}}');
    await runAgentsSetupCommand({ force: false }, deps);
    const parsed = JSON.parse(files.get(at('.mcp.json'))!) as {
      mcpServers: Record<string, unknown>;
    };
    assert.ok('other' in parsed.mcpServers);
    assert.ok('jsails' in parsed.mcpServers);
  });

  it('refuses to overwrite AGENTS.md without --force', async () => {
    const { files, deps } = depsFor();
    files.set(at('AGENTS.md'), 'existing');
    await runAgentsSetupCommand({ force: false }, deps);
    assert.equal(files.get(at('AGENTS.md')), 'existing');
  });

  it('--force overwrites AGENTS.md and the skill', async () => {
    const { files, deps } = depsFor();
    files.set(at('AGENTS.md'), 'old');
    files.set(at('.agents/skills/jsails/SKILL.md'), 'old-skill');
    await runAgentsSetupCommand({ force: true }, deps);
    assert.notEqual(files.get(at('AGENTS.md')), 'old');
    assert.ok(files.get(at('.agents/skills/jsails/SKILL.md'))?.includes('jsails_describe'));
  });
});
