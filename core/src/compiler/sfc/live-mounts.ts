/**
 * Hoisted mounts of live components in a page, a layout or the not-found
 * page (sfc-plan §2.6).
 *
 * A page renders its tree in one synchronous pass after awaiting its
 * function, and mounting a live component (authorize, initial state, a
 * signed snapshot) is async, so a live tag cannot render where it stands.
 * Each one becomes a binding the function fills before it returns, and the
 * template renders the binding in the tag's place:
 *
 * ```tsx
 * let __live0: __ComponentChild = null;
 * if (user) {                                   // the js-if chain around the tag
 *   __live0 = await __mountLive(TaskList, __context);
 * }
 * return (<>{(user) ? (<section>{__live0}</section>) : null}</>);
 * ```
 *
 * The hoist repeats the conditions on the tag's path as `if` statements, in
 * the template's order and with its `else if` structure, so each runs once
 * before the template however many live tags it guards, a component the
 * template would not render is not mounted, and TypeScript narrows inside
 * them as it does in the template. A condition therefore runs twice per
 * render, once here and once in the template, and must not have side effects
 * (documented with the format). The conditions are Verbatim copies, so a
 * diagnostic in one lands on the author's text.
 *
 * A mount cannot depend on a value the template computes per item or per
 * slot call, so a live tag inside a `js-for`, a scoped slot or a `<slot>`
 * fallback is `sfc.live_tag_position`; it takes no attributes besides its
 * `js-if` branch (`sfc.live_props_unsupported`), and only the kinds that may
 * mount accept it (`sfc.live_outside_page`).
 */

import type { SfcDiagnostics } from './diagnostics.js';
import type { SegmentWriter } from './segment-writer.js';
import {
  findDirective,
  isComponentTag,
  type ElementNode,
  type SlotAttribute,
  type TemplateExpression,
  type TemplateNode,
} from './template-ast.js';

/** Inputs of {@link writeLiveMounts}. */
export interface LiveMountContext {
  /** Writes the hoist into the render function, before its `return`. */
  readonly writer: SegmentWriter;
  /** The tag names that render a live component. */
  readonly liveTags: ReadonlySet<string>;
  /** Whether the kind may mount (`SfcLoweredSpec.mountsLive`). */
  readonly mountsLive: boolean;
  readonly diagnostics: SfcDiagnostics;
}

interface Range {
  readonly start: number;
  readonly end: number;
}

type Statement =
  | { readonly kind: 'mount'; readonly node: ElementNode; readonly binding: string }
  | { readonly kind: 'if'; readonly branches: readonly Branch[] };

interface Branch {
  /** The condition, or `null` for a `js-else`. */
  readonly condition: TemplateExpression | null;
  readonly owner: Range;
  readonly body: readonly Statement[];
}

/** The attributes a live tag accepts: its place in a `js-if` chain. */
const BRANCH_DIRECTIVES: ReadonlySet<string> = new Set(['js-if', 'js-else-if', 'js-else']);

/**
 * Write the hoisted mounts of the live tags among `children` and return each
 * mounted tag's binding, which the template renders in its place. Writes
 * nothing when no tag is live.
 */
export function writeLiveMounts(
  children: readonly TemplateNode[],
  context: LiveMountContext,
): ReadonlyMap<ElementNode, string> {
  const planner = new MountPlanner(context);
  const statements = planner.list(children, null);
  const { writer } = context;
  for (const [node, binding] of planner.mounts) {
    writer.atom(`  let ${binding}: __ComponentChild = null;\n`, node.start, node.startTagEnd);
  }
  const write = (list: readonly Statement[], depth: number): void => {
    const indent = '  '.repeat(depth);
    for (const statement of list) {
      if (statement.kind === 'mount') {
        const { node, binding } = statement;
        writer.atom(`${indent}${binding} = await __mountLive(`, node.start, node.startTagEnd);
        writer.verbatim(node.start + 1, node.start + 1 + node.tag.length);
        writer.atom(', __context);\n', node.start, node.startTagEnd);
        continue;
      }
      statement.branches.forEach((branch, index) => {
        const { owner } = branch;
        if (branch.condition === null) {
          writer.atom(' else {\n', owner.start, owner.end);
        } else {
          writer.atom(index === 0 ? `${indent}if (` : ' else if (', owner.start, owner.end);
          if (branch.condition.verbatim) {
            writer.verbatim(branch.condition.start, branch.condition.end);
          } else {
            writer.atom(branch.condition.code, branch.condition.start, branch.condition.end);
          }
          writer.atom(') {\n', owner.start, owner.end);
        }
        write(branch.body, depth + 1);
        writer.atom(`${indent}}`, owner.start, owner.end);
      });
      const last = statement.branches.at(-1) as Branch;
      writer.atom('\n', last.owner.start, last.owner.end);
    }
  };
  write(statements, 1);
  return planner.mounts;
}

/** Walks a template for live tags, reporting the misplaced ones. */
class MountPlanner {
  readonly mounts = new Map<ElementNode, string>();

  constructor(private readonly context: LiveMountContext) {}

  /**
   * The statements of a child list. `blocked` names the construct that makes
   * a mount impossible here, or is `null`.
   */
  list(nodes: readonly TemplateNode[], blocked: string | null): readonly Statement[] {
    const out: Statement[] = [];
    let index = 0;
    while (index < nodes.length) {
      const node = nodes[index] as TemplateNode;
      if (node.kind !== 'element' || node.raw) {
        index += 1;
        continue;
      }
      const condition = findDirective(node, 'js-if');
      if (condition === undefined) {
        out.push(...this.node(node, blocked));
        index += 1;
        continue;
      }
      const branches: Branch[] = [];
      while (index < nodes.length) {
        const branchNode = nodes[index] as TemplateNode;
        if (branchNode.kind !== 'element' || branchNode.raw) break;
        const directive =
          branches.length === 0
            ? findDirective(branchNode, 'js-if')
            : (findDirective(branchNode, 'js-else-if') ?? findDirective(branchNode, 'js-else'));
        if (directive === undefined) break;
        branches.push({
          condition: directive.value.kind === 'expression' ? directive.value.expression : null,
          owner: { start: branchNode.start, end: branchNode.startTagEnd },
          body: this.node(branchNode, blocked),
        });
        index += 1;
        if (directive.value.kind !== 'expression') break;
      }
      const last = branches.findLastIndex((branch) => branch.body.length > 0);
      if (last >= 0) out.push({ kind: 'if', branches: branches.slice(0, last + 1) });
    }
    return out;
  }

  /** The statements of one element, without its own `js-if`. */
  private node(node: ElementNode, blocked: string | null): readonly Statement[] {
    if (this.context.liveTags.has(node.tag)) return this.liveTag(node, blocked);
    if (findDirective(node, 'js-for') !== undefined) {
      this.list(node.children, 'A live component cannot mount inside a js-for loop');
      return [];
    }
    if (node.tag === 'slot') {
      this.list(node.children, 'A live component cannot mount in a <slot> fallback');
      return [];
    }
    if (node.tag !== 'component' && !isComponentTag(node.tag)) {
      return this.list(node.children, blocked);
    }
    const out: Statement[] = [];
    const content: TemplateNode[] = [];
    for (const child of node.children) {
      const slot =
        child.kind === 'element' && child.tag === 'template'
          ? child.attributes.find(
              (attribute): attribute is SlotAttribute => attribute.kind === 'slot',
            )
          : undefined;
      if (child.kind !== 'element' || slot === undefined) {
        content.push(child);
        continue;
      }
      if (slot.params !== null) {
        this.list(child.children, 'A live component cannot mount in a scoped slot');
        continue;
      }
      const body = this.list(child.children, blocked);
      const condition = findDirective(child, 'js-if');
      if (condition?.value.kind === 'expression' && body.length > 0) {
        out.push({
          kind: 'if',
          branches: [
            {
              condition: condition.value.expression,
              owner: { start: child.start, end: child.startTagEnd },
              body,
            },
          ],
        });
      } else {
        out.push(...body);
      }
    }
    out.push(...this.list(content, blocked));
    return out;
  }

  private liveTag(node: ElementNode, blocked: string | null): readonly Statement[] {
    const { diagnostics } = this.context;
    if (!this.context.mountsLive) {
      diagnostics.error(
        'sfc.live_outside_page',
        'A live component mounts in a page, a layout or the not-found page',
        node.start,
        node.startTagEnd,
      );
      return [];
    }
    if (blocked !== null) {
      diagnostics.error('sfc.live_tag_position', blocked, node.start, node.startTagEnd);
      return [];
    }
    let valid = true;
    for (const attribute of node.attributes) {
      if (attribute.kind === 'directive' && BRANCH_DIRECTIVES.has(attribute.name)) continue;
      valid = false;
      diagnostics.error(
        'sfc.live_props_unsupported',
        'A live component takes no attributes: it owns its state and renders from it',
        attribute.start,
        attribute.end,
      );
    }
    if (node.children.length > 0) {
      valid = false;
      diagnostics.error(
        'sfc.live_props_unsupported',
        'A live component takes no children',
        node.start,
        node.startTagEnd,
      );
    }
    if (!valid) return [];
    const binding = `__live${this.mounts.size}`;
    this.mounts.set(node, binding);
    return [{ kind: 'mount', node, binding }];
  }
}
