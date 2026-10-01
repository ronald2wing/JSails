/**
 * The file sets `createStarterFiles` must generate, checked through the
 * packaged `jsails` module installed in the admin fixture rather than the
 * repo's source copy. The admin set is derived from `WEB_TEMPLATE_FILES` in
 * `core/src/app/starter/presets.ts` (each template with its `.template` suffix
 * stripped) plus the generated `AGENTS.md`; the saas set is the admin set plus
 * its tenant-scoped model, and the other presets are checked by count here and
 * by full key set in `core/test/app/starter.test.ts`.
 */

/** Every file `createStarterFiles({ admin: true })` generates, order-independent. */
export const ADMIN_PRESET_FILES = [
  '.env.auth.example',
  '.gitignore',
  'AGENTS.md',
  'api/me.ts',
  'app/application-auth.ts',
  'app/application-client.ts',
  'app/application-command.ts',
  'app/application-component.ts',
  'app/application-plugin.ts',
  'app/application-resource.ts',
  'app/application-testing.ts',
  'auth/README.md',
  'client/main.tsx',
  'commands/login.ts',
  'commands/logout.ts',
  'commands/whoami.ts',
  'components/load-more-feed.tsx',
  'components/task-list.tsx',
  'jamal.config.ts',
  'jsails.app.js',
  'jsails.database.js',
  'package.json',
  'pages/about.tsx',
  'pages/dashboard.tsx',
  'pages/device.tsx',
  'pages/index.tsx',
  'pages/live.tsx',
  'pages/load-more.tsx',
  'pages/login.tsx',
  'pages/register.tsx',
  'pages/tasks.tsx',
  'playwright.config.ts',
  'scripts/auth-migrate.mjs',
  'scripts/create-user.mjs',
  'scripts/db-push.mjs',
  'scripts/run-tests.mjs',
  'test/app.test.ts',
  'test/auth.test.ts',
  'test/browser/auth.spec.ts',
  'test/browser/fixtures.ts',
  'test/browser/home.spec.ts',
  'tsconfig.client.json',
  'tsconfig.json',
  'ui/class-names.ts',
  'ui/dialog.tsx',
  'ui/field.tsx',
  'ui/counter.tsx',
  'ui/layout.tsx',
  'ui/live-posts.tsx',
  'ui/register-form.tsx',
  'ui/styles.css',
  'ui/task-notes.ts',
  'vite.config.js',
].sort();

/** The default preset: a static site. */
export const STATIC_PRESET_FILE_COUNT = 29;

/** The `--blog` preset: the admin set plus the two blog pages and the theme helper. */
export const BLOG_PRESET_FILE_COUNT = ADMIN_PRESET_FILES.length + 3;

/** The `--saas` preset: the admin set plus the tenant-owned example model. */
export const SAAS_PRESET_FILES = [...ADMIN_PRESET_FILES, 'models/project.ts'].sort();

/**
 * A script run inside the fixture with `node --input-type=module`, so a bare
 * `import('jsails')` resolves the installed package and proves it reads its
 * own bundled templates and `AGENTS.md`.
 */
export function packagedStarterScript() {
  return `
    const { createStarterFiles } = await import('jsails');
    const { files } = await createStarterFiles({ admin: true });
    const keys = Object.keys(files).sort();
    const expected = ${JSON.stringify(ADMIN_PRESET_FILES)};
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      throw new Error('unexpected file set: ' + JSON.stringify(keys));
    }
    for (const key of keys) {
      if (typeof files[key] !== 'string' || files[key].length === 0) {
        throw new Error('empty generated file: ' + key);
      }
    }
    if (!files['AGENTS.md'].includes('Working with JSails')) {
      throw new Error('bundled AGENTS.md guide missing from packaged module');
    }
    if (!/@import ['"]tailwindcss['"]/.test(files['ui/styles.css'])) {
      throw new Error('bundled styles template missing from packaged module');
    }
    if (!files['pages/index.tsx'].includes('counter-root')) {
      throw new Error('bundled page template missing from packaged module');
    }
    const staticFiles = await createStarterFiles();
    const staticCount = Object.keys(staticFiles.files).length;
    if (staticCount !== ${STATIC_PRESET_FILE_COUNT}) {
      throw new Error('default starter must produce ${STATIC_PRESET_FILE_COUNT} files, got ' + staticCount);
    }
    if (!/use:\\s*\\[\\]/.test(staticFiles.files['jsails.app.js'])) {
      throw new Error('default starter app config must declare plugins.use: []');
    }
    const blogFiles = await createStarterFiles({ blog: true });
    const blogCount = Object.keys(blogFiles.files).length;
    if (blogCount !== ${BLOG_PRESET_FILE_COUNT}) {
      throw new Error('blog variant must produce ${BLOG_PRESET_FILE_COUNT} files, got ' + blogCount);
    }
    if (!blogFiles.files['pages/blog/index.tsx'] || !blogFiles.files['pages/blog/[slug].tsx']) {
      throw new Error('blog variant missing the two blog pages');
    }
    if (!blogFiles.files['jsails.app.js'].includes("'@jsails/blog'")) {
      throw new Error("blog variant app config missing '@jsails/blog'");
    }
    const saasFiles = await createStarterFiles({ saas: true });
    const saasKeys = Object.keys(saasFiles.files).sort();
    if (JSON.stringify(saasKeys) !== JSON.stringify(${JSON.stringify(SAAS_PRESET_FILES)})) {
      throw new Error('unexpected saas file set: ' + JSON.stringify(saasKeys));
    }
    if (!/^@tenantScoped\\('tenantId'\\)$/m.test(saasFiles.files['models/project.ts'])) {
      throw new Error('saas variant model must declare tenantScoped');
    }
    console.log(
      'PACKAGED_STARTER_OK ' + keys.length + ' files (blog variant ' + blogCount +
        ', saas variant ' + saasKeys.length + ')',
    );
  `;
}
