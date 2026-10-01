/**
 * Admin wizard: a multi-step form descriptor with per-step validation and
 * navigation state.
 *
 * `defineWizard({ steps: [{ name, label, fields }] })` validates the step
 * specification and returns a deeply frozen {@link Wizard} descriptor. Each
 * step names the resource-level fields it owns; the available fields change
 * with each step, and per-step validation gates the transition.
 *
 * The render helper `renderWizard(...)` emits step navigation (Previous /
 * Next buttons plus the active step's fields). The `currentStep` state is
 * caller-managed: advancing requires the caller to validate the current
 * step's field subset against the resource schema before incrementing
 * `currentStep`. The module is ORM-free and performs no I/O.
 */

import { h, type ComponentChild, type VNode } from 'preact';
import { isRecord } from 'jsails/plugin-sdk';

import { AdminDefinitionError } from './errors.js';
import { csrfInput, hiddenInput } from './forms.js';
import {
  collectSectionFields,
  validateNamedSections,
  type NamedSection,
  type SectionFieldCoverage,
} from './named-sections.js';
import type { ResourceField } from './resource/index.js';
import type { TabRenderState } from './tabs.js';

/** One step in a wizard. */
export type WizardStep = NamedSection;

/** Specification passed to {@link defineWizard}. */
export interface WizardDefinition {
  /** Ordered, non-empty step list with unique names. */
  readonly steps: readonly WizardStep[];
}

/** A frozen, validated wizard descriptor. */
export interface Wizard {
  /** Ordered, frozen step list. */
  readonly steps: readonly WizardStep[];
}

/**
 * Validate a wizard spec and return a deeply frozen descriptor. Steps must
 * be non-empty with unique names; each step's `fields` must be a non-empty
 * array of strings (validated against the resource fields at render time).
 */
export function defineWizard(spec: WizardDefinition): Wizard {
  if (!isRecord(spec)) {
    throw new AdminDefinitionError('invalid_wizard', 'defineWizard requires a spec object');
  }
  return Object.freeze({
    steps: validateNamedSections(spec.steps, { code: 'invalid_wizard', label: 'wizard step' }),
  });
}

/**
 * Extract the subset of submitted values that belong to a given wizard step.
 * This is a defensive helper that never reads the resource schema; the caller
 * validates the returned subset against the resource's full Zod schema.
 */
export function wizardStepValues(
  step: WizardStep,
  values: Record<string, string>,
): Record<string, string> {
  const fields = new Set(step.fields);
  return Object.freeze(
    Object.fromEntries(Object.entries(values).filter(([key]) => fields.has(key))),
  );
}

/**
 * Collect all fields referenced by every step and report any name that does
 * not match a resource-level field.
 */
export function collectWizardFields(
  wizard: Wizard,
  resourceFields: readonly ResourceField[],
): SectionFieldCoverage {
  return collectSectionFields(wizard.steps, resourceFields);
}

/** Options for {@link renderWizard}. */
export interface RenderWizardOptions {
  /** The zero-based current step index. */
  readonly currentStep: number;
  /** The total step count (validates `currentStep` is in range). */
  readonly totalSteps: number;
  /**
   * Renders the input element for a single field. Receives the field
   * descriptor, the render state, and an element id.
   */
  readonly renderField: (field: ResourceField, state: TabRenderState, id: string) => VNode<any>;
}

/**
 * Render a wizard form. Emits step navigation (step indicator, Previous /
 * Next buttons, and a Submit button on the last step) plus the active step's
 * fields. The first step has no Previous button; the last step has a Submit
 * instead of Next. Buttons carry explicit `name`/`value` markers so the
 * server can detect navigation intent.
 */
export function renderWizard(
  wizard: Wizard,
  resourceFields: readonly ResourceField[],
  state: TabRenderState,
  options: RenderWizardOptions,
): VNode<any> {
  const { currentStep, totalSteps } = options;
  const clamped = Math.max(0, Math.min(currentStep, totalSteps - 1));

  const fieldMap = new Map(resourceFields.map((f) => [f.name, f]));

  // Step indicator
  const stepIndicators: ComponentChild[] = wizard.steps.map((step, index) =>
    h(
      'li',
      {
        key: step.name,
        class: index === clamped ? 'admin-wizard-step-active' : undefined,
        role: 'presentation',
      },
      h(
        'span',
        { class: 'admin-wizard-step-label' },
        index === clamped
          ? h('strong', null, step.label)
          : h(
              'span',
              {
                class:
                  index < clamped ? 'admin-wizard-step-completed' : 'admin-wizard-step-upcoming',
              },
              step.label,
            ),
      ),
    ),
  );

  // Active step fields
  const activeStep = wizard.steps[clamped]!;
  const activeFields = activeStep.fields
    .map((name) => fieldMap.get(name))
    .filter((f): f is ResourceField => f !== undefined);

  // Hidden input carrying the wizard step marker so the server can detect it.
  const csrfHidden = csrfInput(state.csrf);
  const backHidden = state.back === '' ? null : hiddenInput('_back', state.back);
  const stepHidden = hiddenInput('_wizard_step', String(clamped));

  // Navigation buttons
  const navButtons: ComponentChild[] = [];
  if (clamped > 0) {
    navButtons.push(
      h(
        'button',
        { type: 'submit', name: '_wizard_prev', value: '1', class: 'admin-wizard-prev' },
        'Previous',
      ),
    );
  }
  if (clamped < totalSteps - 1) {
    navButtons.push(
      h(
        'button',
        { type: 'submit', name: '_wizard_next', value: '1', class: 'admin-wizard-next' },
        'Next',
      ),
    );
  } else {
    navButtons.push(h('button', { type: 'submit', class: 'admin-wizard-submit' }, 'Save'));
  }

  return h(
    'div',
    { class: 'admin-wizard' },
    h('ol', { class: 'admin-wizard-steps' }, ...stepIndicators),
    h(
      'div',
      { class: 'admin-wizard-body' },
      ...activeFields.map((field) => {
        const id = `field-${field.name}`;
        return options.renderField(field, state, id);
      }),
    ),
    h('div', { class: 'admin-wizard-footer' }, csrfHidden, backHidden, stepHidden, ...navButtons),
  );
}
