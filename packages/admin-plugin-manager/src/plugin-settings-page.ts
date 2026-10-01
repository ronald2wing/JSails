/**
 * The plugin settings page: its render side and its POST handler.
 *
 * One form is rendered per installed plugin whose manifest declares a
 * `settings` schema, its properties projected through `projectSettingsSchema`: editable fields
 * (string/number/boolean) render as inputs, `unknown` fields render only
 * whether a value is stored (the value itself may be a secret and is never
 * echoed, nor submitted). Every form on the page shares one document, so
 * element ids carry the plugin id, and control names carry a `setting:` prefix
 * so a schema key can never shadow the form's own `id`, `action`, or `_csrf`
 * fields. The POST rebuilds the entry's settings from the editable submitted
 * fields (a blank number is unset, falling back to its declared default),
 * preserving unknown keys, and persists through the managed state source under
 * {@link withStateLock}. Only available in managed mode; every failure is a
 * value-free error response.
 */

import {
  adminBadRequestResponse,
  adminForbiddenResponse,
  adminNotFoundResponse,
  adminRedirectResponse,
  adminServerErrorResponse,
  csrfInput,
  hiddenInput,
  panelDocumentOptions,
  renderAdminDocumentWithTheme,
  type AdminPagePostContext,
  type AdminPageRenderContext,
} from '@jsails/admin';
import { PLUGIN_ID_PATTERN } from 'jsails/plugins';
import { h, type ComponentChild } from 'preact';

import { projectSettingsSchema, type SettingsFieldDescriptor } from './directory/settings.js';
import { loadInstalledPlugins } from './installed-plugins.js';
import type { ResolvedPluginManagerOptions } from './plugin-manager.js';
import {
  PLUGIN_NOTICE_SETTINGS_SAVED,
  readPluginNotice,
  renderPluginNotice,
} from './plugin-notices.js';
import { withStateLock } from './state-lock.js';

/** Upper bound on a submitted setting value length. */
const MAX_SETTING_VALUE_LENGTH = 4096;

/** Prefix of every submitted setting control name. */
const SETTING_FIELD_PREFIX = 'setting:';

/** The stored settings of one plugin, when any. */
type StoredSettings = Record<string, unknown> | undefined;

/**
 * Render the plugin settings page: one form per installed plugin whose manifest
 * declares a `settings` schema. Only available in managed mode.
 */
export async function renderPluginSettingsPage(
  context: AdminPageRenderContext,
  options: ResolvedPluginManagerOptions,
): Promise<string> {
  const notice = readPluginNotice(context.url.searchParams.get('notice'));
  const path = context.path;
  const body: ComponentChild[] = [h('h1', null, 'Plugin Settings')];
  if (notice !== undefined) {
    body.push(renderPluginNotice(notice));
  }

  const managed = options.managed === true && options.stateSource !== undefined;
  if (!managed) {
    body.push(h('p', null, 'Plugin settings require a managed plugin state source.'));
  } else {
    body.push(...(await renderPluginSettingsForms(options, path, context.session.csrfToken)));
  }

  body.push(h('a', { href: path }, 'Back to dashboard'));
  return renderAdminDocumentWithTheme(panelDocumentOptions(context, 'Plugin Settings'), ...body);
}

/** Render a settings section per installed plugin that declares a schema. */
async function renderPluginSettingsForms(
  options: ResolvedPluginManagerOptions,
  path: string,
  csrf: string,
): Promise<ComponentChild[]> {
  const { discovered, state } = await loadInstalledPlugins(options);
  const installed = (discovered?.plugins ?? []).filter((plugin) =>
    Object.hasOwn(state.plugins, plugin.id),
  );
  if (installed.length === 0) {
    return [h('p', null, 'No installed plugins to configure.')];
  }
  return installed.map((plugin) =>
    renderSettingsSection({
      id: plugin.id,
      fields: projectSettingsSchema(plugin.manifest.settings?.properties),
      current: state.plugins[plugin.id]?.settings,
      path,
      csrf,
    }),
  );
}

/** The inputs of one plugin's settings section. */
interface SettingsSection {
  readonly id: string;
  readonly fields: readonly SettingsFieldDescriptor[];
  readonly current: StoredSettings;
  readonly path: string;
  readonly csrf: string;
}

/** One plugin's settings section: heading plus a form when fields exist. */
function renderSettingsSection(section: SettingsSection): ComponentChild {
  const { id, fields, current, path, csrf } = section;
  if (fields.length === 0) {
    return h('section', null, h('h2', null, id), h('p', null, 'No configurable settings.'));
  }
  const controls: ComponentChild[] = fields.map((field) =>
    field.type === 'unknown'
      ? renderUnknownField(field, current)
      : renderTypedField(id, field, current),
  );
  return h(
    'section',
    null,
    h('h2', null, id),
    h(
      'form',
      { method: 'post', action: `${path}/plugin-settings` },
      csrfInput(csrf),
      hiddenInput('action', 'save-settings'),
      hiddenInput('id', id),
      ...controls,
      h('button', { type: 'submit' }, 'Save settings'),
    ),
  );
}

/** The submitted control name of a setting key. */
function settingFieldName(key: string): string {
  return `${SETTING_FIELD_PREFIX}${key}`;
}

/**
 * The element id of one plugin's setting control. `:` never occurs in a plugin
 * id, so two plugins' ids cannot collide, and the key is encoded so the id
 * stays a single token.
 */
function settingElementId(pluginId: string, key: string): string {
  return `setting:${pluginId}:${encodeURIComponent(key)}`;
}

/** Render an editable input for a typed field, pre-filled from current settings. */
function renderTypedField(
  pluginId: string,
  field: SettingsFieldDescriptor,
  current: StoredSettings,
): ComponentChild {
  const id = settingElementId(pluginId, field.key);
  const name = settingFieldName(field.key);
  if (field.type === 'boolean') {
    return h(
      'label',
      { htmlFor: id },
      h('input', {
        type: 'checkbox',
        name,
        id,
        value: 'on',
        ...(fieldBooleanValue(field, current) ? { checked: true } : {}),
      }),
      ` ${field.label}`,
    );
  }
  return h(
    'div',
    null,
    h('label', { htmlFor: id }, field.label),
    h('input', {
      type: field.type === 'number' ? 'number' : 'text',
      name,
      id,
      value: fieldStringValue(field, current),
    }),
  );
}

/**
 * Render an unknown-shaped field as a read-only note saying only whether a
 * value is stored: its shape is not editable here and it may carry a secret,
 * so the value is never echoed and never submitted.
 */
function renderUnknownField(
  field: SettingsFieldDescriptor,
  current: StoredSettings,
): ComponentChild {
  const stored = current !== undefined && Object.hasOwn(current, field.key);
  return h(
    'div',
    null,
    h('span', null, field.key),
    h('p', null, stored ? 'A value is stored (hidden; not editable here).' : 'No value stored.'),
  );
}

/** Resolve a string/number field's input value (current, then default, else ''). */
function fieldStringValue(field: SettingsFieldDescriptor, current: StoredSettings): string {
  const currentValue = current?.[field.key];
  if (currentValue !== undefined && currentValue !== null) {
    return String(currentValue);
  }
  if (field.defaultValue !== undefined) {
    return String(field.defaultValue);
  }
  return '';
}

/** Resolve a boolean field's checked state (current, then default, else false). */
function fieldBooleanValue(field: SettingsFieldDescriptor, current: StoredSettings): boolean {
  const currentValue = current?.[field.key];
  if (typeof currentValue === 'boolean') {
    return currentValue;
  }
  return field.defaultValue === true;
}

/**
 * Handle the settings page POST: validate the target id against the managed
 * state, rebuild the entry's settings from the editable submitted fields, and
 * persist. Value-free errors for every failure.
 */
export async function handlePluginSettingsPost(
  context: AdminPagePostContext,
  options: ResolvedPluginManagerOptions,
): Promise<Response> {
  if (context.body['action'] !== 'save-settings') {
    return adminBadRequestResponse();
  }
  const stateSource = options.stateSource;
  if (options.managed !== true || stateSource === undefined) {
    return adminForbiddenResponse('plugin state is not managed');
  }
  const id = context.body['id'];
  if (id === undefined || !PLUGIN_ID_PATTERN.test(id)) {
    return adminBadRequestResponse();
  }

  return withStateLock(stateSource, async () => {
    const { discovered, state } = await loadInstalledPlugins(options);
    const manifest = discovered?.plugins.find((plugin) => plugin.id === id)?.manifest;
    if (manifest === undefined) {
      return adminNotFoundResponse();
    }
    if (!Object.hasOwn(state.plugins, id)) {
      return adminNotFoundResponse();
    }

    const entry = state.plugins[id]!;
    const settings = buildSettings(
      projectSettingsSchema(manifest.settings?.properties),
      context.body,
      entry.settings,
    );
    if (settings === undefined) {
      return adminBadRequestResponse();
    }

    // Only this id's row is written, so a stale snapshot of the other plugins
    // can never overwrite or drop them.
    try {
      await stateSource.putEntry(id, { ...entry, settings });
    } catch {
      return adminServerErrorResponse();
    }

    return adminRedirectResponse(
      `${context.path}/plugin-settings?notice=${PLUGIN_NOTICE_SETTINGS_SAVED}`,
    );
  });
}

/**
 * Build the next settings object: preserve unknown keys, apply the editable
 * submitted fields. An absent field, and a blank number (an empty number input
 * submits `''`, which `Number` would read as `0`), is unset: it takes the
 * declared default, else is removed. `undefined` when a submitted value is too
 * long or a number field is not numeric.
 */
function buildSettings(
  fields: readonly SettingsFieldDescriptor[],
  body: Record<string, string>,
  existing: StoredSettings,
): Record<string, unknown> | undefined {
  const settings: Record<string, unknown> = { ...existing };
  for (const field of fields) {
    if (field.type === 'unknown') {
      continue;
    }
    if (field.type === 'boolean') {
      settings[field.key] = body[settingFieldName(field.key)] === 'on';
      continue;
    }
    const raw = body[settingFieldName(field.key)];
    if (raw === undefined || (field.type === 'number' && raw.trim() === '')) {
      if (field.defaultValue !== undefined) {
        settings[field.key] = field.defaultValue;
      } else {
        delete settings[field.key];
      }
      continue;
    }
    if (raw.length > MAX_SETTING_VALUE_LENGTH) {
      return undefined;
    }
    if (field.type === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        return undefined;
      }
      settings[field.key] = value;
      continue;
    }
    settings[field.key] = raw;
  }
  return settings;
}
