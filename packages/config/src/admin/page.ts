/**
 * The config admin page: one form per config set, rendered from the set's own
 * field declarations, so a plugin declares its settings once and gets an edit
 * form for free.
 *
 * A field that code overrides is shown disabled with its forced value and a
 * "Set in code" note, and is never submitted or written. A save checks every
 * submitted field through its declaration; any invalid value refuses the whole
 * form with a value-free 400. The page reads and writes through the same
 * {@link Config} service the app runs on.
 */

import { h, type ComponentChild } from 'preact';

import {
  actionForm,
  adminBadRequestResponse,
  adminRedirectResponse,
  defineAdminPage,
  hiddenInput,
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
  renderNotice,
  type AdminPage,
  type AdminPageAuthorize,
  type AdminPagePostContext,
  type AdminPageRenderContext,
} from '@jsails/admin';
import type { JsonValue } from 'jsails/plugin-sdk';

import type { Config } from '../config.js';
import { ConfigError } from '../config-error.js';
import type { ConfigSet } from '../config-set.js';
import type { ConfigField } from '../fields.js';

/** Options for {@link defineConfigAdminPage}. */
export interface ConfigAdminPageOptions {
  /** The service the app runs on: `configPlugin(...).config`. */
  readonly config: Config;
  /**
   * Who may use the page, checked after the panel's own `authorize`; exact
   * `true` allows. Without it the page is served to no one: the panel gate
   * admits a session to the panel, not to every page in it.
   */
  readonly authorize?: AdminPageAuthorize;
  /** The admin nav label. Defaults to `Configuration`. */
  readonly label?: string;
  /** Override the panel base path used by form targets and redirects. */
  readonly path?: string;
}

const SLUG = 'config';
const SAVED = 'config_saved';
/** Form field names are prefixed so a key never collides with `action`, `set`, or `_csrf`. */
const FIELD_PREFIX = 'field.';

/** Define the frozen config admin page (slug `config`). */
export function defineConfigAdminPage(options: ConfigAdminPageOptions): AdminPage {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('defineConfigAdminPage requires an options object');
  }
  const { config } = options;
  if (config === null || typeof config !== 'object' || typeof config.active !== 'function') {
    throw new TypeError('defineConfigAdminPage requires the config service');
  }
  const label = options.label ?? 'Configuration';
  const pagePath = (context: AdminPageRenderContext): string =>
    `${options.path ?? context.path}/${SLUG}`;

  return defineAdminPage({
    slug: SLUG,
    label,
    ...(options.authorize === undefined ? {} : { authorize: options.authorize }),
    render: async (context) => {
      const body: ComponentChild[] = [h('h1', null, label)];
      if (context.url.searchParams.get('notice') === SAVED) {
        body.push(renderNotice('Configuration saved.'));
      }
      if (config.sets.length === 0) body.push(h('p', null, 'No config sets are declared.'));
      for (const set of config.sets) {
        body.push(await renderSet(config, set, context.session.csrfToken, pagePath(context)));
      }
      return renderAdminDocumentWithTheme(panelDocumentOptions(context, label), ...body);
    },
    handlePost: (context) => handleSave(config, context, pagePath(context)),
  });
}

/** Render one set: a section with a form over its fields. */
async function renderSet(
  config: Config,
  set: ConfigSet,
  csrf: string,
  path: string,
): Promise<ComponentChild> {
  const active = await config.active(set);
  const effective = await config.get(set);
  const forced = new Set(config.overridden(set));
  const controls: ComponentChild[] = [hiddenInput('set', set.name)];
  for (const [key, field] of Object.entries(set.fields)) {
    const isForced = forced.has(key);
    controls.push(
      renderField(key, field, (isForced ? effective : active)[key] as JsonValue, isForced),
    );
  }
  return h(
    'section',
    { class: 'admin-config-set', id: `config-${set.name}` },
    h('h2', null, set.label ?? set.name),
    actionForm({ path, csrf, action: 'save', label: 'Save', controls }),
  );
}

/** One labeled control; a forced field is disabled and never submitted. */
function renderField(
  key: string,
  field: ConfigField,
  value: JsonValue,
  forced: boolean,
): ComponentChild {
  const name = `${FIELD_PREFIX}${key}`;
  const common = { name, ...(forced ? { disabled: true } : {}) };
  const shown = field.toForm(value);
  let control: ComponentChild;
  switch (field.kind) {
    case 'boolean':
      control = h('input', { ...common, type: 'checkbox', checked: value === true });
      break;
    case 'integer':
      control = h('input', {
        ...common,
        type: 'number',
        value: shown,
        ...(field.min === undefined ? {} : { min: String(field.min) }),
        ...(field.max === undefined ? {} : { max: String(field.max) }),
      });
      break;
    case 'choice':
      control = h(
        'select',
        common,
        ...(field.options ?? []).map((option) =>
          h('option', { value: option, ...(option === value ? { selected: true } : {}) }, option),
        ),
      );
      break;
    case 'json':
      control = h('textarea', { ...common, rows: 6 }, shown);
      break;
    case 'text':
      control = field.multiline
        ? h('textarea', { ...common, rows: 4 }, shown)
        : h('input', {
            ...common,
            type: 'text',
            value: shown,
            ...(field.required ? { required: true } : {}),
            ...(field.max === undefined ? {} : { maxlength: String(field.max) }),
          });
      break;
  }
  return h(
    'div',
    { class: 'admin-config-field' },
    h('label', null, field.label ?? key, ' ', control),
    ...(forced ? [h('p', { class: 'admin-config-forced' }, 'Set in code')] : []),
  );
}

/** Save one set from the submitted form. */
async function handleSave(
  config: Config,
  context: AdminPagePostContext,
  path: string,
): Promise<Response> {
  const set =
    context.body['action'] === 'save' ? config.find(context.body['set'] ?? '') : undefined;
  if (set === undefined) return adminBadRequestResponse();
  const forced = new Set(config.overridden(set));
  const values: Record<string, unknown> = {};
  try {
    for (const [key, field] of Object.entries(set.fields)) {
      if (forced.has(key)) continue;
      values[key] = field.fromForm(context.body[`${FIELD_PREFIX}${key}`]);
    }
    await config.set(set, values);
  } catch (error) {
    if (error instanceof ConfigError) return adminBadRequestResponse();
    throw error;
  }
  return adminRedirectResponse(`${path}?notice=${SAVED}#config-${set.name}`);
}
