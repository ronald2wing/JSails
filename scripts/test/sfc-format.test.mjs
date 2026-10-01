/**
 * The `.jsails` format corpus (docs/design/sfc.md §5, §10): the repository's
 * Prettier configuration formats `**\/*.jsails` with the `vue` parser, and
 * formatting the corpus is idempotent, keeps every diagnostic, lowers to the
 * same shadow TSX (or, where Prettier rewrites code, the same compiled
 * module), and renders the same HTML, byte for byte. The static `class`,
 * `style`, `srcset` and `allow` values Prettier's HTML printer reprints are
 * no exception: the compiler writes them in a canonical form
 * (docs/design/sfc.md §5.2). A file whose lowering has not landed keeps its
 * blocks and lowers to exactly the `sfc.not_lowered` of that lowering, so the
 * ratchet fails the day it lands.
 *
 * It reads the compiler from core's build (`core/dist/src/compiler/sfc/`), as
 * every CI leg, `npm test` and `npm run check` build before the tooling tests.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as prettier from 'prettier';

import { repoRoot } from '../workspaces.mjs';
import { FORMAT_CATALOG, FORMAT_CORPUS, FORMAT_MODULES } from './fixtures/sfc-format-corpus.mjs';

const CORE_DIST = join(repoRoot, 'core', 'dist', 'src');

/** Import a module of core's build. */
async function core(path) {
  return import(pathToFileURL(join(CORE_DIST, path)).href);
}

/** oxc as core's compiler loads it (`rolldown/utils`, a dependency of core). */
const oxc = await import(
  pathToFileURL(createRequire(join(repoRoot, 'core', 'package.json')).resolve('rolldown/utils'))
    .href
);

let lowerSfc;
let nameTable;
let parseSfcBlocks;
let renderToString;
let jsx;
let Fragment;
let components;
let protocol;
let scratch;

before(async () => {
  if (!existsSync(join(CORE_DIST, 'compiler', 'sfc', 'lower.js'))) {
    throw new Error('sfc-format reads core/dist: build core first (npm run build -w jsails)');
  }
  ({ lowerSfc } = await core('compiler/sfc/lower.js'));
  ({ nameTable } = await core('compiler/sfc/name-resolver.js'));
  ({ parseSfcBlocks } = await core('compiler/sfc/blocks.js'));
  ({ renderToString } = await core('jsx/render-to-string.js'));
  ({ jsx, Fragment } = await core('jsx/jsx-runtime.js'));
  components = {
    ...(await core('server-components/registry.js')),
    ...(await core('server-components/runtime/index.js')),
    ...(await core('server-components/snapshot.js')),
  };
  protocol = await core('server-components/protocol.js');
  scratch = mkdtempSync(join(tmpdir(), 'jsails-sfc-format-'));
});

after(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

/** Format `source` as the repository formats the file at `path` (the parser comes from the config). */
async function format(source, path) {
  const filepath = join(repoRoot, path);
  const options = await prettier.resolveConfig(filepath);
  return prettier.format(source, { ...options, filepath });
}

const formatted = new Map();
/** The corpus file `file`, formatted once. */
async function formattedSource(file) {
  if (!formatted.has(file.path)) formatted.set(file.path, await format(file.source, file.path));
  return formatted.get(file.path);
}

function resolver() {
  return nameTable(
    Object.fromEntries(
      Object.entries(FORMAT_CATALOG).map(([name, entry]) => [
        name,
        {
          source: entry.package === undefined ? { path: entry.path } : { package: entry.package },
          export: entry.export,
        },
      ]),
    ),
  );
}

function lower(source, path) {
  return lowerSfc(source, path, { resolver: resolver() });
}

function codes(lowering) {
  return lowering.diagnostics.map((entry) => `${entry.severity} ${entry.code}`);
}

/** The module oxc compiles a shadow to: what the build ships. */
function compiled(lowering) {
  const output = oxc.transformSync(`${lowering.file}.tsx`, lowering.tsx, {
    lang: 'tsx',
    jsx: { runtime: 'automatic', importSource: 'jsails' },
  });
  assert.deepEqual(output.errors, [], `${lowering.file} compiles`);
  return output.code;
}

/**
 * Point the package imports of a compiled module (the framework, `zod`) at the
 * repository's, and its `.jsails` imports at its compiled siblings.
 */
function relink(code) {
  return code.replace(
    /(from\s*|import\s*)(["'])([^"']+)\2/g,
    (match, keyword, _quote, specifier) => {
      if (specifier.endsWith('.jsails')) return `${keyword}${JSON.stringify(`${specifier}.js`)}`;
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
        return `${keyword}${JSON.stringify(import.meta.resolve(specifier))}`;
      }
      return match;
    },
  );
}

/** Compile `lowerings` and the corpus modules into a fresh directory and import every lowering. */
async function load(lowerings, label) {
  const root = mkdtempSync(join(scratch, `${label}-`));
  const write = (path, code) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), code);
  };
  write('package.json', '{"type":"module"}\n');
  for (const module of FORMAT_MODULES) {
    const output = oxc.transformSync(module.path, module.source, { lang: 'ts' });
    assert.deepEqual(output.errors, [], module.path);
    write(module.path.replace(/\.ts$/, '.js'), output.code);
  }
  for (const lowering of lowerings) write(`${lowering.file}.js`, relink(compiled(lowering)));
  const modules = new Map();
  for (const lowering of lowerings) {
    modules.set(lowering.file, await import(pathToFileURL(join(root, `${lowering.file}.js`)).href));
  }
  return modules;
}

function requestContext({ pathname, params }) {
  const url = new URL(`http://localhost${pathname}`);
  return { request: new Request(url), url, params, session: null };
}

const SIGNING_KEY = 'sfc-format-corpus-signing-key-0123456789abcdef';

/** True for the default export of a live component: a server component definition. */
function isLiveComponent(value) {
  return typeof value === 'object' && value !== null && typeof value.render === 'function';
}

/**
 * Mask what differs between two mounts of one component (its instance id, and
 * the snapshot and render tag derived from it).
 */
function maskInstance(html) {
  let masked = html.replace(
    new RegExp(`id="${protocol.COMPONENT_ROOT_ID_PREFIX}[^"]*"`, 'g'),
    'id="…"',
  );
  for (const name of [protocol.COMPONENT_SNAPSHOT_ATTRIBUTE, protocol.COMPONENT_RENDER_ATTRIBUTE]) {
    masked = masked.replace(new RegExp(`${name}="[^"]*"`, 'g'), `${name}="…"`);
  }
  return masked;
}

/** A live component's render case: mounted as a page serves it, or its static form. */
async function renderLive(definition, renderCase, context) {
  const runtime = components.createServerComponentsRuntime({
    components: components.componentRegistryFromMap({ [definition.name]: definition }),
    signer: new components.HmacComponentSigner({ key: SIGNING_KEY }),
  });
  if (renderCase.static === true) {
    return runtime.render(
      definition.name,
      { ...context, renderMode: 'static' },
      { staticMode: true },
    );
  }
  return maskInstance(await runtime.render(definition.name, context));
}

/** The HTML one render case of `module` produces. */
async function render(module, renderCase) {
  const context = requestContext(renderCase.context ?? { pathname: '/', params: {} });
  if (isLiveComponent(module.default)) return renderLive(module.default, renderCase, context);
  const props =
    renderCase.props ?? (typeof module.load === 'function' ? await module.load(context) : {});
  // An island calls hooks, which run inside a component render only.
  if (typeof module.default.islandId === 'string')
    return renderToString(jsx(module.default, props));
  const child = await module.default(props, context);
  return renderToString(jsx(Fragment, { children: child }));
}

const lowered = FORMAT_CORPUS.filter((file) => file.pending === undefined);
const pending = FORMAT_CORPUS.filter((file) => file.pending !== undefined);

/** Where the `sfc.not_lowered` of a pending file's lowering sits: offset 0 for a kind. */
const PENDING_AT = {
  kind: () => 0,
};

describe('Prettier configuration for .jsails', () => {
  it('resolves the vue parser for .jsails and .jsails.template files, none ignored', async () => {
    for (const path of [
      'pages/index.jsails',
      'website/pages/index.jsails',
      'packages/admin/src/views/x.jsails',
      'core/templates/starter/pages/index.jsails.template',
    ]) {
      const info = await prettier.getFileInfo(join(repoRoot, path), {
        resolveConfig: true,
        ignorePath: [join(repoRoot, '.gitignore'), join(repoRoot, '.prettierignore')],
      });
      assert.deepEqual(info, { ignored: false, inferredParser: 'vue' }, path);
    }
  });

  it('leaves the .jsails inputs under test fixtures as written', async () => {
    for (const path of [
      'core/test/compiler/sfc/fixtures/app/pages/layout.jsails',
      'core/test/compiler/sfc/fixtures/app/ui/card.jsails',
      'packages/admin/test/fixtures/views/x.jsails',
    ]) {
      const info = await prettier.getFileInfo(join(repoRoot, path), {
        resolveConfig: true,
        ignorePath: [join(repoRoot, '.gitignore'), join(repoRoot, '.prettierignore')],
      });
      assert.equal(info.ignored, true, path);
    }
  });

  it('makes `prettier --check .` check the .jsails files it finds', () => {
    // The directory mirrors the repository: the configuration Prettier finds
    // (an explicit --config does not take part in expanding a directory).
    const dir = mkdtempSync(join(scratch, 'cli-'));
    copyFileSync(join(repoRoot, '.prettierrc.json'), join(dir, '.prettierrc.json'));
    mkdirSync(join(dir, 'pages'));
    writeFileSync(
      join(dir, 'pages', 'messy.jsails'),
      '<template>\n<p   class="a">x</p>\n</template>\n',
    );
    writeFileSync(
      join(dir, 'pages', 'tidy.jsails'),
      '<template>\n  <p class="a">x</p>\n</template>\n',
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.resolve('prettier/bin/prettier.cjs')), '--check', '.'],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /messy\.jsails/);
    assert.doesNotMatch(output, /tidy\.jsails/);
  });
});

describe('the format corpus', () => {
  it('holds every construct, whitespace case and printed attribute sfc.md §5.1 lists', () => {
    const all = FORMAT_CORPUS.map((file) => file.source).join('\n');
    for (const construct of [
      '<script lang="ts">',
      '<script setup lang="ts">',
      '<template static>',
      '<style scoped>',
      '<!-- prettier-ignore -->\n    <pre js-pre>{{a+b}}',
      '<!-- prettier-ignore --><code js-pre>',
      '<template js-for=',
      '<template #row="{ item, index }">',
      '<template #header>',
      ':class=',
      '@submit.prevent=',
      '@click=',
      'js-model.trim=',
      '{{ `${b-a}` }}',
      '<input class=',
      '<br>',
      '<pre>',
      '<textarea',
      '&amp;',
      'Braces { and } and a > are text',
      '<TagBadge tag="first-tag-with-a-long-name" :count="1" /> <TagBadge',
      '</em> you <strong>',
      '<div>a</div> <div>b</div>',
      '<div>text<p>x</p>more</div>',
      '<div> text </div>',
      '<button> x </button>',
      '<span> x </span>',
      '<span> <b>bold</b> </span>',
      'a<button>x</button>b',
      '<script setup lang="ts">const links = await navigation();</script>',
      'class="  card   wide',
      'style="COLOR:#FFAA00;margin:0 auto;transition:opacity .30s ease,',
      '<img src="/a.png" srcset="/a.png 1x,/b.png   2x"',
      '<source srcset="/hero-small.webp 480w,',
      "allow=\"fullscreen;autoplay  'self';camera",
      'class="note  muted" :class="{ wide }" style="background:URL(/bg.png)',
      'class=" spread   box " style="padding:.50EM 1.0em" js-bind="extra"',
      '<TagBadge class="  a   b "',
      'content:&quot;\\201C&quot;',
    ]) {
      assert.ok(all.includes(construct), `the corpus holds ${JSON.stringify(construct)}`);
    }
  });

  it('formats idempotently', async () => {
    for (const file of FORMAT_CORPUS) {
      const once = await formattedSource(file);
      assert.notEqual(once, file.source, `${file.path} is unformatted, so formatting it is tested`);
      assert.equal(await format(once, file.path), once, `${file.path} formats in one pass`);
    }
  });

  it('keeps every diagnostic of every file', async () => {
    for (const file of FORMAT_CORPUS) {
      const before = lower(file.source, file.path);
      const after = lower(await formattedSource(file), file.path);
      assert.deepEqual(codes(after), codes(before), file.path);
      if (file.pending === undefined) {
        assert.deepEqual(codes(before), [], `${file.path} lowers cleanly`);
      }
    }
  });

  it('lowers to the same shadow text, or the same compiled module where Prettier rewrites code', async () => {
    for (const file of lowered) {
      const before = lower(file.source, file.path);
      const after = lower(await formattedSource(file), file.path);
      assert.ok(before.shadow !== null && after.shadow !== null, file.path);
      if (file.reformatsCode === true) {
        assert.notEqual(after.tsx, before.tsx, `${file.path}: Prettier rewrites code, as flagged`);
        assert.equal(compiled(after), compiled(before), file.path);
      } else {
        assert.equal(after.tsx, before.tsx, file.path);
        assert.deepEqual(
          after.shadow.spans.map((span) => span.kind),
          before.shadow.spans.map((span) => span.kind),
          `${file.path}: the same segments`,
        );
      }
    }
  });

  it('renders the same HTML before and after formatting', async () => {
    const originals = await load(
      lowered.map((file) => lower(file.source, file.path)),
      'original',
    );
    const formattedModules = await load(
      await Promise.all(lowered.map(async (file) => lower(await formattedSource(file), file.path))),
      'formatted',
    );
    for (const file of lowered) {
      assert.ok((file.renders ?? []).length > 0, `${file.path} has a render case`);
      for (const renderCase of file.renders) {
        const html = await render(originals.get(file.path), renderCase);
        const after = await render(formattedModules.get(file.path), renderCase);
        assert.equal(after, html, `${file.path} renders the same after formatting`);
        for (const expected of renderCase.contains) {
          assert.ok(html.includes(expected), `${file.path} renders ${expected}:\n${html}`);
        }
      }
    }
  });

  it('calls from each live component template only the actions it declares', () => {
    const live = FORMAT_CORPUS.filter((file) => file.source.includes('defineLive('));
    assert.ok(live.length > 0);
    for (const file of live) {
      const blocks = parseSfcBlocks(file.source, file.path);
      const actions = liveActions(blocks.script.content);
      const called = handlerNames(blocks.template.root.children);
      assert.ok(called.length > 0, file.path);
      assert.deepEqual(
        called.filter((name) => !actions.includes(name)),
        [],
        file.path,
      );
    }
  });

  it('keeps the blocks of files whose lowering has not landed', async () => {
    for (const file of pending) {
      const at = PENDING_AT[file.pending](file.source);
      assert.ok(at >= 0, `${file.path}: holds what its pending lowering reads`);
      // A kind's diagnostic hides every other one, so a file waits on one lowering only.
      for (const [other, find] of Object.entries(PENDING_AT)) {
        if (other !== 'kind' && other !== file.pending) {
          assert.equal(find(file.source), -1, `${file.path}: also waits on ${other}`);
        }
      }
      assert.deepEqual(
        lower(file.source, file.path).diagnostics.map((entry) => [
          entry.severity,
          entry.code,
          entry.start,
        ]),
        [['error', 'sfc.not_lowered', at]],
        `${file.path}: the ${file.pending} lowering has landed, so give it render cases instead of pending`,
      );
      assert.deepEqual(
        structure(await formattedSource(file), file.path),
        structure(file.source, file.path),
        file.path,
      );
    }
  });
});

/** The action names the `defineLive({ actions })` call of a script declares, or null without one. */
function liveActions(script) {
  const result = oxc.parseSync('script.ts', script, { lang: 'ts' });
  assert.deepEqual(result.errors, []);
  for (const statement of result.program.body) {
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    if (call?.type !== 'CallExpression' || call.callee.name !== 'defineLive') continue;
    const actions = call.arguments[0].properties.find((entry) => entry.key.name === 'actions');
    return actions.value.properties.map((entry) => entry.key.name);
  }
  return null;
}

/** The function name each event handler of a template tree calls or names, in order. */
function handlerNames(nodes) {
  return nodes.flatMap((node) => {
    if (node.kind !== 'element') return [];
    const own = node.attributes.flatMap((attribute) => {
      if (attribute.kind !== 'on' || attribute.handlerForm !== 'expression') return [];
      const program = oxc.parseSync('handler.ts', `(${attribute.handler.code});`, {
        lang: 'ts',
        preserveParens: false,
      }).program;
      const expression = program.body[0].expression;
      const callee = expression.type === 'CallExpression' ? expression.callee : expression;
      return callee.type === 'Identifier' ? [callee.name] : [];
    });
    return [...own, ...handlerNames(node.children)];
  });
}

/** The program `code` parses to, without positions, raw spellings or parentheses. */
function syntax(code, lang = 'tsx') {
  const result = oxc.parseSync(`code.${lang}`, code, { lang, preserveParens: false });
  assert.deepEqual(result.errors, [], code);
  return JSON.stringify(result.program, (key, value) =>
    key === 'start' || key === 'end' || key === 'raw' ? undefined : value,
  );
}

/** A template node tree as text: tags, decoded text after the whitespace rule, and attribute syntax. */
function templateTree(nodes) {
  return nodes.map((node) => {
    if (node.kind === 'text') return { text: node.value };
    if (node.kind === 'interpolation')
      return { interpolation: syntax(`(${node.expression.code});`) };
    return {
      tag: node.tag,
      attributes: node.attributes.map(attributeSyntax),
      children: templateTree(node.children),
    };
  });
}

function attributeSyntax(attribute) {
  switch (attribute.kind) {
    case 'static':
      return ['static', attribute.name, attribute.value];
    case 'bind':
      return ['bind', attribute.name, syntax(`(${attribute.expression.code});`)];
    case 'on':
      return [
        'on',
        attribute.event,
        attribute.modifiers,
        attribute.handler === null
          ? null
          : syntax(
              attribute.handlerForm === 'expression'
                ? `(${attribute.handler.code});`
                : attribute.handler.code,
            ),
      ];
    case 'slot':
      return [
        'slot',
        attribute.name,
        attribute.params === null ? null : syntax(`(${attribute.params.code}) => 0;`),
      ];
    default:
      return ['directive', attribute.name, attribute.modifiers, directiveValue(attribute.value)];
  }
}

function directiveValue(value) {
  switch (value.kind) {
    case 'expression':
      return syntax(`(${value.expression.code});`);
    case 'for':
      return [
        syntax(`(${value.alias.code}) => 0;`),
        value.keyword,
        syntax(`(${value.source.code});`),
      ];
    case 'name':
      return value.name;
    case 'hydrate':
      return value.trigger;
    default:
      return null;
  }
}

/** Every block of a file a kind's lowering will read, compared by syntax rather than spelling. */
function structure(source, path) {
  const file = parseSfcBlocks(source, path);
  assert.deepEqual(
    file.diagnostics.filter((entry) => entry.severity === 'error'),
    [],
    path,
  );
  return {
    script: file.script === null ? null : syntax(file.script.content),
    scriptSetup: file.scriptSetup === null ? null : syntax(file.scriptSetup.content),
    template: file.template === null ? null : templateTree(file.template.root.children),
    templateStatic:
      file.templateStatic === null ? null : templateTree(file.templateStatic.root.children),
    styles: file.styles.map((style) => [style.scoped, style.content]),
  };
}
