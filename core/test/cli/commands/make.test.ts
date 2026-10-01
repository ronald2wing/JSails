/**
 * Tests for the `jsails make:*` generators, run through the dispatcher: file generation per generator
 * type, name normalization, validation, and exclusive creation.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { renderSfcTemplate } from '../../../src/cli/commands/make-templates.js';
import { dispatch } from '../../../src/cli/dispatch.js';
import { joinSfc } from '../../../src/compiler/sfc/layout.js';
import { lowerSfc } from '../../../src/compiler/sfc/lower.js';

/** Run `jsails make:<type> ...args` through the dispatcher, as the CLI parses it. */
function runMakeCommand(type: string, args: readonly string[]): Promise<number> {
  return dispatch([`make:${type}`, ...args], {
    cwd: process.cwd(),
    stdout: () => undefined,
    stderr: () => undefined,
  });
}

/**
 * The `make:*` generators write into a temp directory (via `--dir`), so the
 * repo tree is never touched. Each case asserts the generated path, its
 * exclusive-creation semantics, and the rendered content (name normalization,
 * conventional imports, and the per-type scaffold). No generated file is ever
 * compiled here — the starter owns compilation.
 */

const tmpRoot = mkdtempSync(
  join(fileURLToPath(new URL('../..', import.meta.url)), 'make-fixture-'),
);

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let dirSeq = 0;

function freshDir(): string {
  const dir = join(tmpRoot, `make-${dirSeq++}`);
  return dir;
}

/** A fresh project directory that syncs `.jsails` sidecars, where `--mfc` may write a folder. */
function syncedDir(): string {
  const dir = freshDir();
  mkdirSync(join(dir, '.jsails', 'sfc'), { recursive: true });
  return dir;
}

function read(dir: string, relative: string): string {
  return readFileSync(join(dir, relative), 'utf8');
}

describe('runMakeCommand: file generation', () => {
  it('generates a page with normalized name and layout wiring', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('page', ['BlogPost', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'pages/blog-post.tsx');
    assert.match(
      content,
      /import \{ UiLayout, loadLayout, type LayoutAssets \} from '\.\.\/ui\/layout\.js'/,
    );
    assert.match(content, /export default function BlogPostPage/);
    assert.match(content, /<UiLayout title="Blog Post — JSails Starter"/);
    const test = read(dir, 'test/pages/blog-post.test.ts');
    assert.match(test, /createTestRequestContext/);
    assert.match(test, /import BlogPostPage, \{ load \} from '\.\.\/\.\.\/pages\/blog-post\.js'/);
  });

  it('generates an API route under api/', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('api', ['health', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'api/health.ts');
    assert.match(content, /export function GET\(_request: Request, _context: RequestContext\)/);
    assert.match(content, /Response\.json\(\{ ok: true \}\)/);
    assert.match(read(dir, 'test/api/health.test.ts'), /GET\(context\.request, context\)/);
  });

  it('generates a job with a camelCase definition name', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('job', ['send-reminder', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'jobs/send-reminder.job.ts');
    assert.match(content, /export default class SendReminderJob extends ApplicationJob/);
    assert.match(content, /static readonly jobName = 'sendReminder'/);
    assert.doesNotMatch(content, /application-job/);
    assert.match(content, /import \{ z \} from 'zod'/);
    assert.match(read(dir, 'test/jobs/send-reminder.test.ts'), /SendReminderJob\.schema\.parse/);
  });

  it('generates a model that declares only its shape', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('model', ['blog_post', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'models/blog-post.ts');
    assert.match(content, /export class BlogPost extends ApplicationRecord/);
    // The implicit shape: a bare `declare` field, no TypeORM decorators.
    assert.match(content, /declare name: string;/);
    assert.doesNotMatch(content, /@Entity|@Column|@PrimaryGeneratedColumn/);
    // `ApplicationRecord` is autoloaded; the generated model has no import.
    assert.doesNotMatch(content, /application-record/);
    assert.doesNotMatch(content, /^import /m);
    assert.match(read(dir, 'test/models/blog-post.test.ts'), /new BlogPost\(\)/);
  });

  it('generates a defineCommand module and its runCommand test', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('command', ['report', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'commands/report.ts');
    assert.match(content, /import \{ defineCommand \} from '\.\.\/app\/application-command\.js'/);
    assert.match(content, /export default defineCommand\(\{/);
    assert.match(content, /summary: 'report command'/);
    assert.match(content, /context\.stdout\('report command'\)/);
    const test = read(dir, 'test/commands/report.test.ts');
    assert.match(test, /import \{ runCommand \} from 'jsails\/testing'/);
    assert.match(test, /runCommand\(reportCommand, \{/);
  });

  it('generates a server component with a Zod state schema', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('server-component', ['form-card', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'components/form-card.tsx');
    assert.match(content, /import \{ z \} from 'zod'/);
    assert.match(
      content,
      /import \{ defineComponent, serverAction \} from 'jsails\/server-components'/,
    );
    assert.match(content, /defineComponent<FormCardState>/);
    assert.match(content, /name: 'form-card'/);
    assert.match(content, /staticFallback/);
    assert.match(read(dir, 'test/components/form-card.test.ts'), /createComponentTestHarness/);
  });

  it('writes a .jsails component folder with --mfc, split as convert splits it', async () => {
    const cases = [
      { type: 'page', dir: 'pages' },
      { type: 'server-component', dir: 'components' },
    ] as const;
    for (const { type, dir: conventional } of cases) {
      const dir = syncedDir();
      const code = await runMakeCommand(type, ['FormCard', '--mfc', '--dir', dir]);
      assert.equal(code, 0);
      const component = `${conventional}/form-card.jsails`;
      const folder = {
        template: read(dir, `${conventional}/form-card/form-card.jsails`),
        script: read(dir, `${conventional}/form-card/form-card.ts`),
      };
      assert.equal(existsSync(join(dir, component)), false);
      assert.equal(existsSync(join(dir, 'test')), false, 'no companion test');
      assert.doesNotMatch(folder.template, /<script lang="ts">/);
      const joined = joinSfc(folder, component);
      assert.ok(joined.ok);
      assert.equal(joined.source, renderSfcTemplate(type, 'FormCard'));
      const lowering = lowerSfc(folder, component);
      assert.deepEqual(lowering.diagnostics, []);
      assert.notEqual(lowering.shadow, null);
    }
  });

  it('refuses --mfc for a generator without a .jsails kind, and writes nothing', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('model', ['post', '--mfc', '--dir', dir]);
    assert.equal(code, 2);
    assert.equal(existsSync(dir), false);
  });

  it('refuses --mfc in a project that does not sync sidecars, and writes nothing', async (t) => {
    const errors: string[] = [];
    t.mock.method(console, 'error', (line: string) => errors.push(line));
    for (const type of ['page', 'server-component'] as const) {
      const dir = freshDir();
      mkdirSync(join(dir, '.jsails'), { recursive: true });
      const code = await runMakeCommand(type, ['about', '--mfc', '--dir', dir]);
      assert.equal(code, 1);
      assert.deepEqual(readdirSync(dir), ['.jsails']);
      assert.deepEqual(readdirSync(join(dir, '.jsails')), []);
    }
    assert.deepEqual(errors, [
      'jsails make:page: this project does not sync .jsails sidecars (.jsails/sfc), which a component folder needs',
      'jsails make:server-component: this project does not sync .jsails sidecars (.jsails/sfc), which a component folder needs',
    ]);
  });

  it(
    'removes the files --mfc wrote when a later one cannot be created, keeping what is not its own',
    {
      skip: process.platform === 'win32' && 'creating a symbolic link needs a privilege on Windows',
    },
    async (t) => {
      t.mock.method(console, 'error', () => undefined);
      const dir = syncedDir();
      const folder = join(dir, 'pages', 'about-us');
      mkdirSync(folder, { recursive: true });
      // A dangling link passes the existence check and then fails the
      // exclusive create, as a file another run created in between does.
      symlinkSync(join(folder, 'elsewhere.ts'), join(folder, 'about-us.ts'));
      const code = await runMakeCommand('page', ['about-us', '--mfc', '--dir', dir]);
      assert.equal(code, 1);
      assert.deepEqual(readdirSync(folder), ['about-us.ts']);
      assert.equal(lstatSync(join(folder, 'about-us.ts')).isSymbolicLink(), true);
    },
  );

  it('refuses --mfc over an existing component, in either layout, and writes nothing', async () => {
    for (const existing of ['pages/about.jsails', 'pages/about/about.ts']) {
      const dir = syncedDir();
      mkdirSync(join(dir, 'pages', 'about'), { recursive: true });
      writeFileSync(join(dir, ...existing.split('/')), 'keep\n');
      const code = await runMakeCommand('page', ['about', '--mfc', '--dir', dir]);
      assert.equal(code, 1);
      assert.equal(read(dir, existing), 'keep\n');
      assert.equal(existsSync(join(dir, 'pages/about/about.jsails')), false);
    }
  });

  it('generates a serializer with a field map', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('serializer', ['user-profile', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'serializers/user-profile.ts');
    assert.match(content, /import \{ defineSerializer, string \} from 'jsails\/api'/);
    assert.match(content, /export const userProfileSerializer = defineSerializer/);
    assert.match(content, /name: string\(\{ min: 1 \}\)/);
    assert.match(read(dir, 'test/serializers/user-profile.test.ts'), /userProfileSerializer/);
  });

  it('generates a middleware handler', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('middleware', ['log-visit', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'middleware/log-visit.ts');
    assert.match(content, /import type \{ RouteMiddleware \} from 'jsails'/);
    assert.match(content, /export const logVisit: RouteMiddleware = async \(context, next\)/);
    assert.match(content, /return next\(\)/);
    // The guidance describes the functional contract, never the Hono context.
    assert.match(content, /context\.session/);
    assert.doesNotMatch(content, /Hono|c\.var|c\.req|requestContext\(\)/);
    assert.match(read(dir, 'test/middleware/log-visit.test.ts'), /typeof logVisit/);
  });

  it('skips the companion test with --no-test', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('page', ['home', '--no-test', '--dir', dir]);

    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, 'pages/home.tsx')), true);
    assert.equal(existsSync(join(dir, 'test/pages/home.test.ts')), false);
  });
});

describe('runMakeCommand: name normalization and dir', () => {
  it('normalizes PascalCase input to a kebab file name', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('model', ['BlogPost', '--dir', dir]);

    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, 'models/blog-post.ts')), true);
  });

  it('writes into a nested --dir, creating missing directories', async () => {
    const dir = freshDir();
    const nested = join(dir, 'src', 'server');
    const code = await runMakeCommand('api', ['ping', '--dir', nested]);

    assert.equal(code, 0);
    assert.equal(existsSync(join(nested, 'api/ping.ts')), true);
  });
});

describe('runMakeCommand: validation and exclusive creation', () => {
  it('refuses to overwrite an existing file and leaves it intact', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('api', ['health', '--dir', dir]);
    assert.equal(code, 0);

    const path = join(dir, 'api/health.ts');
    writeFileSync(path, '// my custom route\n');
    const second = await runMakeCommand('api', ['health', '--dir', dir]);

    assert.equal(second, 1);
    assert.equal(read(dir, 'api/health.ts'), '// my custom route\n');
  });

  it('rejects an invalid name', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('api', ['9bad', '--dir', dir]);
    assert.equal(code, 2);
    assert.equal(existsSync(join(dir, 'api/9bad.ts')), false);
  });

  it('requires a name', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('page', ['--dir', dir]);
    assert.equal(code, 2);
  });

  it('rejects an unknown option', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('page', ['home', '--bogus', '--dir', dir]);
    assert.equal(code, 2);
  });
});

describe('runMakeCommand: content generators', () => {
  it('generates a content entry with YAML frontmatter', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('content', ['blog', 'hello-world', '--dir', dir]);

    assert.equal(code, 0);
    const content = read(dir, 'content/blog/hello-world.md');
    assert.match(content, /^---\ntitle: Hello World\ndate: \d{4}-\d{2}-\d{2}\ntags: \[\]\n---\n/m);
    assert.match(content, /Start writing here\./);
  });

  it('normalizes a PascalCase name to a kebab path and Title Case title', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('content', ['blog', 'HelloWorld', '--dir', dir]);

    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, 'content/blog/hello-world.md')), true);
    assert.match(read(dir, 'content/blog/hello-world.md'), /title: Hello World/);
  });

  it('honors --dir as the base directory', async () => {
    const dir = freshDir();
    const nested = join(dir, 'src', 'site');
    const code = await runMakeCommand('content', ['blog', 'hello', '--dir', nested]);

    assert.equal(code, 0);
    assert.equal(existsSync(join(nested, 'content/blog/hello.md')), true);
  });

  it('rejects an invalid content name without writing', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('content', ['blog', '9bad', '--dir', dir]);

    assert.equal(code, 2);
    assert.equal(existsSync(join(dir, 'content/blog/9bad.md')), false);
  });

  it('rejects a missing collection or name for make:content', async () => {
    const dir = freshDir();
    assert.equal(await runMakeCommand('content', ['--dir', dir]), 2);
    assert.equal(await runMakeCommand('content', ['blog', '--dir', dir]), 2);
  });

  it('refuses to overwrite an existing content entry and leaves it intact', async () => {
    const dir = freshDir();
    const code = await runMakeCommand('content', ['blog', 'hello', '--dir', dir]);
    assert.equal(code, 0);

    const path = join(dir, 'content/blog/hello.md');
    writeFileSync(path, '---\ntitle: Mine\n---\n');
    const second = await runMakeCommand('content', ['blog', 'hello', '--dir', dir]);

    assert.equal(second, 1);
    assert.equal(read(dir, 'content/blog/hello.md'), '---\ntitle: Mine\n---\n');
  });
});

// ---------------------------------------------------------------------------
// subprocess: CLI wiring
// ---------------------------------------------------------------------------

const cliPath = fileURLToPath(new URL('../../../src/cli/bin.cjs', import.meta.url));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The paths a CLI run reported as created, one per `Created <path>` line. */
function createdLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Created '))
    .map((line) => line.slice('Created '.length));
}

describe('cli: make subprocess', () => {
  it('lists every generator in the global help, and has no bare make', () => {
    const result = runCli(['--help'], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['model', 'server-component', 'serializer', 'middleware', 'content']) {
      assert.match(result.stdout, new RegExp(`^  make:${name} `, 'm'));
    }
    assert.match(result.stdout, /^  make:dockerfile /m);
    assert.doesNotMatch(result.stdout, /make:post|make:doc\b/);
    const bare = runCli(['make'], tmpRoot);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /unknown command make$/m);
  });

  it('prints per-type help for make:page --help', () => {
    const result = runCli(['make:page', '--help'], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /jsails make:page \[options\] <name>/);
    assert.match(result.stdout, /--dir <dir>/);
    assert.match(result.stdout, /--no-test/);
  });

  it('prints per-type help for make:content --help', () => {
    const result = runCli(['make:content', '--help'], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /jsails make:content \[options\] <collection> <name>/);
  });

  it('rejects an unknown make type', () => {
    const result = runCli(['make:bogus', 'x'], tmpRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown command make:bogus$/m);
  });

  it('creates a file through the CLI end to end', () => {
    const dir = join(tmpRoot, 'make-subprocess');
    const result = runCli(['make:command', 'hello', '--dir', dir], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'commands/hello.ts')), true);
    assert.equal(existsSync(join(dir, 'test/commands/hello.test.ts')), true);
    assert.ok(createdLines(result.stdout).includes(join(dir, 'commands', 'hello.ts')));
  });

  it('creates a server-component file through the CLI end to end', () => {
    const dir = join(tmpRoot, 'make-subprocess-sc');
    const result = runCli(['make:server-component', 'card', '--dir', dir], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'components/card.tsx')), true);
    assert.equal(existsSync(join(dir, 'test/components/card.test.ts')), true);
    assert.ok(createdLines(result.stdout).includes(join(dir, 'components', 'card.tsx')));
  });

  it('creates a content entry through the CLI end to end', () => {
    const dir = join(tmpRoot, 'make-subprocess-content');
    const result = runCli(['make:content', 'blog', 'first-post', '--dir', dir], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'content/blog/first-post.md')), true);
    assert.ok(createdLines(result.stdout).includes(join(dir, 'content', 'blog', 'first-post.md')));
  });

  it('creates a .jsails component folder through the CLI with make:server-component --mfc', () => {
    const dir = join(tmpRoot, 'make-subprocess-mfc');
    mkdirSync(join(dir, '.jsails', 'sfc'), { recursive: true });
    const result = runCli(['make:server-component', 'card', '--mfc', '--dir', dir], tmpRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(createdLines(result.stdout), [
      join(dir, 'components', 'card', 'card.jsails'),
      join(dir, 'components', 'card', 'card.ts'),
    ]);
  });
});
