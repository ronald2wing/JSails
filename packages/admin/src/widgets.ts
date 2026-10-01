/**
 * Admin widgets: declarative stat cards for the dashboard.
 *
 * `defineWidget(spec)` validates a widget — a URL-safe `name`, a human `label`,
 * and a trusted `render` callback returning a stat value (a string or number)
 * for the current admin session — and returns a frozen {@link Widget}
 * descriptor. A panel declares widgets via `defineAdminPanel({ widgets })`; the
 * admin plugin renders each as a dashboard stat card (label plus the escaped
 * value).
 *
 * The module is ORM-free: it imports only the session contract (a type) and
 * performs no I/O.
 */

import type { Session } from 'jsails';
import { isRecord } from 'jsails/plugin-sdk';

import { AdminDefinitionError } from './errors.js';

/** Context handed to a widget's `render` callback. */
export interface AdminWidgetContext {
  /** The resolved, authorized admin session. */
  readonly session: Session;
  /** The panel base path (e.g. `/admin`). */
  readonly path: string;
}

/** A widget's trusted stat renderer; returns the value to display. */
export type AdminWidgetRender = (
  context: AdminWidgetContext,
) => string | number | Promise<string | number>;

/** A frozen, validated widget descriptor consumed by {@link adminPlugin}. */
export interface Widget {
  /** Unique widget name within a panel. */
  readonly name: string;
  /** Human card label. */
  readonly label: string;
  /** Render the stat value for the current session. */
  readonly render: AdminWidgetRender;
}

/** Specification passed to {@link defineWidget}. */
export interface WidgetDefinition {
  /** Unique widget name within a panel. */
  readonly name: string;
  /** Human card label. */
  readonly label: string;
  /** Render the stat value. */
  readonly render: AdminWidgetRender;
}

/** Raise the widget's value-free definition error. */
function invalid(message: string): AdminDefinitionError {
  return new AdminDefinitionError('invalid_widget', message);
}

/** The fields every widget kind shares: a spec object with a name and a label. */
interface WidgetSpecBase {
  readonly name: string;
  readonly label: string;
}

/** Validate the spec object plus the `name` and `label` every widget kind requires. */
function validateWidgetSpec(spec: unknown, factory: string): asserts spec is WidgetSpecBase {
  if (!isRecord(spec)) {
    throw invalid(`${factory} requires a spec object`);
  }
  if (typeof spec['name'] !== 'string' || spec['name'].trim() === '') {
    throw invalid('widget name must be a non-empty string');
  }
  if (typeof spec['label'] !== 'string' || spec['label'].trim() === '') {
    throw invalid('widget label must be a non-empty string');
  }
}

/** Validate a widget spec and return a frozen descriptor. */
export function defineWidget(spec: WidgetDefinition): Widget {
  validateWidgetSpec(spec, 'defineWidget');
  if (typeof spec.render !== 'function') {
    throw invalid('widget must define a render function');
  }
  return Object.freeze({ name: spec.name, label: spec.label, render: spec.render });
}

/** Specification for {@link defineProgressWidget}. */
export interface ProgressWidgetDefinition {
  readonly name: string;
  readonly label: string;
  readonly value: (context: AdminWidgetContext) => number | Promise<number>;
  readonly max?: number;
}

/** Validate a progress-widget spec and return a frozen descriptor. */
export function defineProgressWidget(spec: ProgressWidgetDefinition): Widget {
  validateWidgetSpec(spec, 'defineProgressWidget');
  if (typeof spec.value !== 'function') {
    throw invalid('progress widget must define a value function');
  }
  if (spec.max !== undefined) {
    if (typeof spec.max !== 'number' || spec.max <= 0 || !Number.isFinite(spec.max)) {
      throw invalid('progress widget max must be a positive number');
    }
  }

  return Object.freeze({
    name: spec.name,
    label: spec.label,
    render: async (context: AdminWidgetContext): Promise<string | number> => {
      const value = await spec.value(context);
      if (spec.max !== undefined) {
        return `${Math.round((value / spec.max) * 100)}%`;
      }
      return value;
    },
  });
}

/** Specification for {@link defineListWidget}. */
export interface ListWidgetDefinition {
  readonly name: string;
  readonly label: string;
  readonly items: (context: AdminWidgetContext) => readonly string[] | Promise<readonly string[]>;
}

/** Validate a list-widget spec and return a frozen descriptor. */
export function defineListWidget(spec: ListWidgetDefinition): Widget {
  validateWidgetSpec(spec, 'defineListWidget');
  if (typeof spec.items !== 'function') {
    throw invalid('list widget must define an items function');
  }

  return Object.freeze({
    name: spec.name,
    label: spec.label,
    render: async (context: AdminWidgetContext): Promise<string> => {
      const items = await spec.items(context);
      return items.join(', ');
    },
  });
}

/** Specification for {@link defineTrendWidget}. */
export interface TrendWidgetDefinition {
  readonly name: string;
  readonly label: string;
  readonly value: (context: AdminWidgetContext) => number | Promise<number>;
  readonly delta: (context: AdminWidgetContext) => number | Promise<number>;
}

/** Validate a trend-widget spec and return a frozen descriptor. */
export function defineTrendWidget(spec: TrendWidgetDefinition): Widget {
  validateWidgetSpec(spec, 'defineTrendWidget');
  if (typeof spec.value !== 'function') {
    throw invalid('trend widget must define a value function');
  }
  if (typeof spec.delta !== 'function') {
    throw invalid('trend widget must define a delta function');
  }

  return Object.freeze({
    name: spec.name,
    label: spec.label,
    render: async (context: AdminWidgetContext): Promise<string> => {
      const value = await spec.value(context);
      const delta = await spec.delta(context);
      const sign = delta >= 0 ? '+' : '';
      return `${value} (${sign}${delta})`;
    },
  });
}
