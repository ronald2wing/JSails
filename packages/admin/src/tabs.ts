/**
 * Admin tabs: a form-layout descriptor that groups existing resource fields
 * into named tabs for the create/edit form.
 *
 * `defineTabs({ tabs: [{ name, label, fields }] })` validates the tab
 * specification and returns a deeply frozen {@link Tabs} descriptor. Each
 * tab's `fields` list names the resource-level fields it groups; those names
 * are validated against the actual {@link ResourceField} set at render time,
 * so a tab referencing an unknown field is a detectable configuration error.
 *
 * Validation still runs over the flattened full field set; tabs change only
 * the visual layout. `renderTabs(...)` emits tab nav markup plus every tab's
 * field set, with the first tab active by default. The module is ORM-free and
 * performs no I/O.
 */

import { h, type ComponentChild, type VNode } from 'preact';
import { isRecord } from 'jsails/plugin-sdk';

import { AdminDefinitionError } from './errors.js';
import {
  collectSectionFields,
  validateNamedSections,
  type NamedSection,
  type SectionFieldCoverage,
} from './named-sections.js';
import type { ResourceField } from './resource/index.js';

/** One tab in a tab set. */
export type TabDefinition = NamedSection;

/** Specification passed to {@link defineTabs}. */
export interface TabsDefinition {
  /** Ordered tab list; must be non-empty and have unique names. */
  readonly tabs: readonly TabDefinition[];
}

/** A frozen, validated tabs descriptor. */
export interface Tabs {
  /** Ordered, frozen tab list. */
  readonly tabs: readonly TabDefinition[];
}

/**
 * Validate a tabs spec and return a deeply frozen descriptor. Each tab's
 * `fields` must be a non-empty array of strings; the render-time consumer
 * validates those names against the actual resource fields.
 */
export function defineTabs(spec: TabsDefinition): Tabs {
  if (!isRecord(spec)) {
    throw new AdminDefinitionError('invalid_tabs', 'defineTabs requires a spec object');
  }
  return Object.freeze({
    tabs: validateNamedSections(spec.tabs, { code: 'invalid_tabs', label: 'tab' }),
  });
}

/** State passed into the render helpers for tab/wizard layouts. */
export interface TabRenderState {
  /** The flattened submitted/record string values keyed by field name. */
  readonly values: Record<string, string>;
  /** Validation errors keyed by field name (with dotted paths for repeaters). */
  readonly errors: Record<string, string>;
  /** CSRF token injected into the form. */
  readonly csrf: string;
  /** Form action URL. */
  readonly action: string;
  /** Canonical table-state query string (no leading `?`). */
  readonly back: string;
}

/**
 * Collect the union of all fields referenced by every tab and report any name
 * that does not match a resource-level field. Fields outside any tab are
 * included at render time (they live below the tab set).
 */
export function collectTabFields(
  tabs: Tabs,
  resourceFields: readonly ResourceField[],
): SectionFieldCoverage {
  return collectSectionFields(tabs.tabs, resourceFields);
}

/** Options for {@link renderTabs}. */
export interface RenderTabsOptions {
  /** The zero-based index of the active tab. Defaults to 0. */
  readonly activeTab?: number;
  /**
   * Renders the input element for a single field. Receives the field
   * descriptor, the render state, and an element id.
   */
  readonly renderField: (field: ResourceField, state: TabRenderState, id: string) => VNode<any>;
}

/**
 * Render a tabbed form layout. The tab nav is a list of `<button>` elements;
 * the first tab is active by default. Each tab panel renders its declared
 * fields in order using the provided `renderField` callback.
 *
 * Validation still runs over the flattened full field set controlled by the
 * resource; the tabs only affect the visual grouping.
 */
export function renderTabs(
  tabs: Tabs,
  resourceFields: readonly ResourceField[],
  state: TabRenderState,
  options: RenderTabsOptions,
): VNode<any> {
  const activeIndex = options.activeTab ?? 0;
  const clamped = Math.max(0, Math.min(activeIndex, tabs.tabs.length - 1));

  const fieldMap = new Map(resourceFields.map((f) => [f.name, f]));
  const tabFieldSet = collectSectionFields(tabs.tabs, resourceFields).fields;

  const navItems: ComponentChild[] = tabs.tabs.map((tab, index) =>
    h(
      'li',
      {
        class: index === clamped ? 'admin-tab-active' : undefined,
        role: 'presentation',
      },
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': index === clamped ? 'true' : 'false',
          'aria-controls': `tabpanel-${tab.name}`,
          id: `tab-${tab.name}`,
          class: 'admin-tab-btn',
          ...(index !== clamped ? { 'data-tab': tab.name } : {}),
        },
        tab.label,
      ),
    ),
  );

  const panels: ComponentChild[] = tabs.tabs.map((tab, index) => {
    const fields = tab.fields
      .map((name) => fieldMap.get(name))
      .filter((f): f is ResourceField => f !== undefined);
    return h(
      'div',
      {
        id: `tabpanel-${tab.name}`,
        role: 'tabpanel',
        'aria-labelledby': `tab-${tab.name}`,
        class: 'admin-tab-panel',
        hidden: index !== clamped ? true : undefined,
      },
      ...fields.map((field) => {
        const id = `field-${field.name}`;
        return options.renderField(field, state, id);
      }),
    );
  });

  // Fields outside any tab render below the tab set.
  const remaining = resourceFields.filter((f) => !tabFieldSet.has(f.name));
  const remainingPanels: ComponentChild[] = remaining.map((field) => {
    const id = `field-${field.name}`;
    return options.renderField(field, state, id);
  });

  return h(
    'div',
    { class: 'admin-tabs' },
    h('ul', { role: 'tablist', class: 'admin-tab-list' }, ...navItems),
    ...panels,
    ...remainingPanels,
  );
}
