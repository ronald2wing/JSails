/**
 * The lowering of the function kinds — page, layout, error, not-found, view
 * and island (sfc-plan §2.2) — to a shadow module whose default export is one
 * function component:
 *
 * ```tsx
 * import type { ComponentChild as __ComponentChild, … } from 'jsails/view';   // header, unmapped
 * import Card from '../ui/card.jsails';                       // resolved names (scope pass)
 * <script content>                                            // Verbatim
 * <imports and type declarations of <script setup>>           // Verbatim, hoisted
 * export default async function __Page(__props: __PageProps<typeof load>, __context: __RequestContext): Promise<__ComponentChild> {
 *   const page = __props.page;                                // free names (scope pass)
 *   <script setup content, macro calls removed>               // Verbatim
 *   let __live0: __ComponentChild = null; …                   // hoisted mounts (live-mounts.ts)
 *   return (<>…</>);                                          // template-jsx.ts
 * }
 * ```
 *
 * An island's function is declared without the export, and the module's
 * default export is `__defineIsland("<id>", Name)`, which names it with the
 * id its file gives (`islandIdFor`): the server markup and the browser
 * registry read the id from the module itself. Its `defineEmits<E>()` adds
 * the `on…` handler props of `E` to the props type, and a bound
 * `const emit = defineEmits<E>()` reads `__emitter<(E)>(__props)`.
 *
 * `async` is written only when setup awaits or a live component mounts (a
 * page that does neither would otherwise trip `require-await` in generated
 * code), and every generated function has an explicit return type. Helper
 * imports carry a `__` alias and are imported only when used, so they never
 * collide with an author binding or trip `noUnusedLocals` in code the author
 * cannot see.
 *
 * The module is assembled twice from the same segments: once without the
 * scope pass's declarations, which the pass then reads, and once with them.
 * Segments carry source positions, not generated ones, so the second
 * assembly reuses every segment of the first. Which tags are live or islands
 * is known only after the scope pass (a catalog name) or from the scripts'
 * imports, so the template is lowered again for the second assembly, with
 * live mounts hoisted and island tags mounted; the first lowering leaves
 * every island check to the second. The scope pass's result still holds,
 * because neither names anything the template did not.
 */

import { isIslandId } from '../../view/island-props.js';
import { islandIdFor, islandPathIsId, pascalCase, sfcKind, type SfcKind } from '../conventions.js';
import type { SfcBlock, SfcFile, SfcTemplateBlock } from './blocks.js';
import type { SfcDiagnostics } from './diagnostics.js';
import type { SfcKindSpec } from './kinds.js';
import { writeLiveMounts } from './live-mounts.js';
import { importSpecifier, type NameResolver } from './name-resolver.js';
import { analyseScope, type RegionScope, type ScopeImport } from './scope.js';
import {
  analyseScript,
  analyseSetup,
  type JsailsImport,
  type PropsMacroCall,
} from './script-analysis.js';
import { SegmentWriter } from './segment-writer.js';
import { assembleShadow, SpanFeature, type MappedSegment, type Shadow } from './segments.js';
import type { SourceSpace } from './source-space.js';
import type { ElementNode } from './template-ast.js';
import {
  lowerTemplateRoot,
  onceSite,
  PROPS_PARAMETER,
  type IslandRules,
  type TemplateLowering,
  type TemplateRules,
  type ViewHelper,
} from './template-jsx.js';

/** A resolved name the module imports. */
export interface SfcImport {
  readonly name: string;
  readonly specifier: string;
  /** The export imported: a name, or `default`. */
  readonly export: string;
}

/** The result of lowering a function kind. */
export interface FunctionKindLowering {
  readonly shadow: Shadow;
  /** The names `<script>` exports, then `default`. */
  readonly exports: readonly string[];
  readonly imports: readonly SfcImport[];
}

/** Inputs of {@link compileFunctionKind}. */
export interface FunctionKindInput {
  readonly file: SfcFile;
  readonly template: SfcTemplateBlock;
  /** The component's files; every offset of `file` is an offset of this space. */
  readonly space: SourceSpace;
  readonly spec: SfcKindSpec;
  readonly resolver: NameResolver;
  readonly diagnostics: SfcDiagnostics;
  /** The scope id its template's outermost elements carry (`style.ts`). */
  readonly scopeId: string;
}

/** Navigation features of the generated function's name (docs/design/sfc.md §6.3 item 2). */
const DECLARATION_FEATURES =
  SpanFeature.Hover |
  SpanFeature.Definition |
  SpanFeature.References |
  SpanFeature.DocumentHighlights;

/**
 * Lower a function-kind file, or return `undefined` after reporting why it
 * cannot be. Diagnostics go to `input.diagnostics`.
 */
export function compileFunctionKind(input: FunctionKindInput): FunctionKindLowering | undefined {
  const { file, template, space, spec, diagnostics } = input;
  const script = analyseScript(file.script, spec, diagnostics);
  const setup = analyseSetup(file.scriptSetup, spec, diagnostics);
  const name = functionName(file.file, spec, template, diagnostics);
  const islandId = spec.kind === 'island' ? islandPathId(file.file, template, diagnostics) : null;
  if (diagnostics.hasErrors || name === undefined || islandId === undefined) return undefined;

  const writerFor = (): SegmentWriter => new SegmentWriter(space);
  const templateOwner = { start: template.start, end: template.contentStart };

  const moduleWriter = writerFor();
  writeScript(moduleWriter, file.script, null);
  writeHoisted(moduleWriter, setup.hoisted);

  const island = spec.kind === 'island';
  const emits = setup.defineEmits;

  /** The function's signature, body and closing, with `liveTags` and `islands` mounted. */
  const lower = (liveTags: ReadonlySet<string>, islands: IslandRules | null) => {
    const body = writerFor();
    writeSetup(body, file.scriptSetup, setup.hoisted, [
      setup.defineProps,
      setup.defineSlots,
      setup.defineEmits,
    ]);
    const mounts: ReadonlyMap<ElementNode, string> =
      liveTags.size === 0
        ? new Map()
        : writeLiveMounts(template.root.children, {
            writer: body,
            liveTags,
            mountsLive: spec.mountsLive,
            diagnostics,
          });
    const rules: TemplateRules = {
      kind: spec.kind,
      slots: spec.slots,
      mounts,
      live: null,
      islands,
      scopeId: input.scopeId,
    };
    const lowering = lowerTemplateRoot(template.root.children, templateOwner, {
      writer: body,
      rules,
      diagnostics,
    });

    const async = spec.mayAwait && (setup.awaits || mounts.size > 0);
    const signature = writerFor();
    signature.atom(
      `${island ? '' : 'export default '}${async ? 'async ' : ''}function `,
      templateOwner.start,
      templateOwner.end,
    );
    const nameOwner = setup.defineProps?.call ?? templateOwner;
    signature.atom(name, nameOwner.start, nameOwner.end, DECLARATION_FEATURES);
    signature.atom(`(${PROPS_PARAMETER}: `, templateOwner.start, templateOwner.end);
    writePropsType(signature, spec, script.exportsLoad, setup, lowering, templateOwner);
    if (spec.context) {
      signature.atom(', __context: __RequestContext', templateOwner.start, templateOwner.end);
    }
    signature.atom(
      `): ${async ? 'Promise<__ComponentChild>' : '__ComponentChild'} {\n`,
      templateOwner.start,
      templateOwner.end,
    );
    const close = writerFor();
    close.atom('}\n', templateOwner.start, templateOwner.end);
    for (let site = 0; site < lowering.onceSites; site += 1) {
      close.atom(
        `const ${onceSite(site)} = new WeakSet<object>();\n`,
        templateOwner.start,
        templateOwner.end,
      );
    }
    if (islandId !== null) {
      close.atom(
        `export default __defineIsland(${JSON.stringify(islandId)}, ${name});\n`,
        templateOwner.start,
        templateOwner.end,
      );
    }
    if (script.serverOnly !== null) {
      close.atom(
        `Object.defineProperty(${name}, __SERVER_ONLY, { value: true });\n`,
        script.serverOnly.start,
        script.serverOnly.end,
      );
    }
    const helpers = new Set<HeaderHelper>(lowering.helpers);
    if (island) helpers.add('defineIsland');
    if (emits !== null && emits.statement === null) helpers.add('emitter');
    const header = headerText({
      viewTypes: [
        ...(spec.props === 'load' && script.exportsLoad ? ['PageProps as __PageProps'] : []),
        ...(emits === null ? [] : ['EmitProps as __EmitProps']),
      ],
      helpers,
      requestContext: spec.context,
      serverOnly: script.serverOnly !== null,
      mountLive: mounts.size > 0,
      defineLive: false,
    });
    return { header, signature, body, close };
  };

  const first = lower(new Set(), null);
  if (diagnostics.hasErrors) return undefined;
  const assemble = (
    pass: ReturnType<typeof lower>,
    imports: readonly MappedSegment[],
    prelude: readonly MappedSegment[],
  ): Shadow =>
    assembleShadow({
      header: pass.header,
      body: [
        ...imports,
        ...moduleWriter.segments(),
        ...pass.signature.segments(),
        ...prelude,
        ...pass.body.segments(),
        ...pass.close.segments(),
      ],
      footer: '',
    });

  const bodyStart =
    first.header.length + length(moduleWriter.segments()) + length(first.signature.segments());
  const scope = analyseScope(
    assemble(first, [], []),
    [
      {
        start: bodyStart,
        end: bodyStart + length(first.body.segments()),
        kindNames: new Set(spec.context ? ['context'] : []),
        unbound: 'prop',
      },
    ],
    { space, resolver: input.resolver, diagnostics },
  );
  if (scope === undefined || diagnostics.hasErrors) return undefined;

  const jsailsImports = [...script.jsailsImports, ...setup.jsailsImports];
  const liveTags = new Set([...scope.liveTags, ...importsOfKind(jsailsImports, 'live')]);
  const final = lower(liveTags, {
    tags: new Set([...scope.islandTags, ...importsOfKind(jsailsImports, 'island')]),
    mode: spec.islands,
  });
  if (diagnostics.hasErrors) return undefined;

  const imports = importSegments(writerFor(), file.file, scope.imports);
  const prelude = writerFor();
  writePrelude(prelude, scope.regions[0] as RegionScope, {
    kindName: () => '__context',
    prop: PROPS_PARAMETER,
  });
  return Object.freeze({
    shadow: assemble(final, imports, prelude.segments()),
    exports: Object.freeze([...script.exports, 'default']),
    imports: resolvedImports(file.file, scope.imports),
  });
}

/** The resolved names of a module, as {@link SfcImport}s. */
export function resolvedImports(
  fromFile: string,
  imports: readonly ScopeImport[],
): readonly SfcImport[] {
  return Object.freeze(
    imports.map((entry) =>
      Object.freeze({
        name: entry.name,
        specifier: importSpecifier(fromFile, entry.resolved.source),
        export: entry.resolved.export,
      }),
    ),
  );
}

/**
 * The local names of default imports that load a `.jsails` file of `kind`: a
 * relative `.jsails` specifier that resolves, from the file holding the
 * import, to a path of that kind (`components/` for a live component,
 * `islands/` for an island).
 */
export function importsOfKind(imports: readonly JsailsImport[], kind: SfcKind): readonly string[] {
  return imports
    .filter((entry) => {
      const resolved = new URL(entry.specifier, `file:///project/${entry.from}`).pathname;
      return (
        resolved.startsWith('/project/') && sfcKind(resolved.slice('/project/'.length)) === kind
      );
    })
    .map((entry) => entry.name);
}

/**
 * Copy `<script>`'s body to module scope, Verbatim, without the range `cut`
 * (a live component's `defineLive` statement). The body, not the content, is
 * copied, so `<script>` and the file `x/x.ts` that replaces it in a folder
 * give the same text; an empty body writes nothing.
 */
export function writeScript(
  writer: SegmentWriter,
  block: SfcBlock | null,
  cut: { readonly start: number; readonly end: number } | null,
): void {
  if (block === null || block.bodyStart === block.contentEnd) return;
  if (cut === null) {
    writer.verbatim(block.bodyStart, block.contentEnd);
  } else {
    writer.verbatim(block.bodyStart, cut.start);
    writer.verbatim(cut.end, block.contentEnd);
  }
  writer.atom('\n', block.contentEnd - 1, block.contentEnd);
}

/** Copy `<script setup>`'s hoisted declarations to module scope. */
export function writeHoisted(
  writer: SegmentWriter,
  hoisted: readonly { readonly start: number; readonly end: number }[],
): void {
  for (const statement of hoisted) {
    writer.verbatim(statement.start, statement.end);
    writer.atom('\n', statement.start, statement.end);
  }
}

export function length(segments: readonly MappedSegment[]): number {
  return segments.reduce((total, segment) => total + segment.text.length, 0);
}

/**
 * The default export's local name: the reserved name of a page-tree kind, or
 * a view's or an island's PascalCase basename (`ui/tag-badge.jsails` →
 * `TagBadge`), which must be a binding a module can declare.
 */
function functionName(
  path: string,
  spec: SfcKindSpec,
  template: SfcTemplateBlock,
  diagnostics: SfcDiagnostics,
): string | undefined {
  if (spec.functionName !== null) return spec.functionName;
  const base = (path.split('/').pop() ?? '').replace(/\.jsails$/, '');
  const name = pascalCase(base);
  // PascalCase never yields a reserved word (all lowercase), so the
  // identifier shape is the whole check.
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    diagnostics.error(
      'sfc.invalid_component_name',
      'A view is named after its file; this file name does not give a component name',
      template.start,
      template.contentStart,
    );
    return undefined;
  }
  return name;
}

/**
 * An island's id, the one its path gives (`islandIdFor`), or `undefined`
 * after reporting a path that does not give one: a folder or file name not
 * in kebab case, which another island file could share the id of, or an id
 * `defineIsland` refuses, which would throw when the module loads.
 */
function islandPathId(
  path: string,
  template: SfcTemplateBlock,
  diagnostics: SfcDiagnostics,
): string | undefined {
  const id = islandIdFor(path);
  const report = (message: string): undefined => {
    diagnostics.error('sfc.invalid_island_id', message, template.start, template.contentStart);
    return undefined;
  };
  if (!islandPathIsId(path)) {
    return report(
      "An island's path under islands/ is its id, so each folder and file name is in kebab case (load-more.jsails, not LoadMore.jsails)",
    );
  }
  if (!isIslandId(id)) {
    return report(
      "An island's path under islands/ is its id: letters, digits and . _ $ - in each name, at most 200 characters, and not a name every object has (constructor)",
    );
  }
  return id;
}

/**
 * Copy `<script setup>` into the render function: Verbatim, without the
 * hoisted statements and the macro statements, and with a bound macro call
 * reading the props parameter instead: `const { a } = defineProps<T>()`
 * reads `__props`, and `const emit = defineEmits<E>()` reads
 * `__emitter<(E)>(__props)`, the type argument copied Verbatim.
 */
export function writeSetup(
  writer: SegmentWriter,
  block: SfcBlock | null,
  hoisted: readonly { readonly start: number; readonly end: number }[],
  macros: readonly (PropsMacroCall | null)[],
): void {
  if (block === null) return;
  const cuts: { start: number; end: number; write: () => void }[] = [
    ...hoisted.map((range) => ({ ...range, write: () => undefined })),
  ];
  for (const macro of macros) {
    if (macro === null) continue;
    const { call, statement, type } = macro;
    if (statement !== null) {
      cuts.push({ start: statement.start, end: statement.end, write: () => undefined });
    } else if (macro.macro === 'defineEmits') {
      cuts.push({
        start: call.start,
        end: call.end,
        write: () => {
          writer.atom('__emitter<(', call.start, call.end);
          writer.verbatim(type.start, type.end);
          writer.atom(`)>(${PROPS_PARAMETER})`, call.start, call.end);
        },
      });
    } else {
      cuts.push({
        start: call.start,
        end: call.end,
        write: () => writer.atom(PROPS_PARAMETER, call.start, call.end),
      });
    }
  }
  cuts.sort((a, b) => a.start - b.start);
  let cursor = block.contentStart;
  for (const cut of cuts) {
    writer.verbatim(cursor, cut.start);
    cut.write();
    cursor = cut.end;
  }
  writer.verbatim(cursor, block.contentEnd);
  writer.atom('\n', block.contentEnd - 1, block.contentEnd);
}

/**
 * The props parameter's type: what the kind's props come from, intersected
 * with the slots a view declares or, without `defineSlots`, the unscoped
 * slots its template renders, and with the handler props of an island's
 * events.
 */
function writePropsType(
  writer: SegmentWriter,
  spec: SfcKindSpec,
  exportsLoad: boolean,
  setup: {
    readonly defineProps: PropsMacroCall | null;
    readonly defineSlots: PropsMacroCall | null;
    readonly defineEmits: PropsMacroCall | null;
  },
  lowering: TemplateLowering,
  owner: { readonly start: number; readonly end: number },
): void {
  const atom = (text: string): void => writer.atom(text, owner.start, owner.end);
  if (spec.props === 'load') {
    atom(exportsLoad ? '__PageProps<typeof load>' : 'Record<never, never>');
    return;
  }
  if (spec.props === 'error') {
    atom('{ readonly error: { readonly status: number; readonly message: string } }');
    return;
  }
  const parts: (() => void)[] = [];
  for (const macro of [setup.defineProps, setup.defineSlots, setup.defineEmits]) {
    if (macro === null) continue;
    const wrapper = macro.macro === 'defineEmits' ? '__EmitProps<(' : '(';
    parts.push(() => {
      writer.atom(wrapper, macro.type.start, macro.type.end);
      writer.verbatim(macro.type.start, macro.type.end);
      writer.atom(macro.macro === 'defineEmits' ? ')>' : ')', macro.type.start, macro.type.end);
    });
  }
  const inferred = new Map<string, boolean>();
  if (setup.defineSlots === null) {
    for (const slot of lowering.slots) {
      if (!slot.scoped && !(spec.children && slot.prop === 'children')) {
        inferred.set(slot.prop, true);
      }
    }
  }
  if (spec.children) parts.push(() => atom('{ readonly children: __ComponentChild }'));
  if (inferred.size > 0) {
    const members = [...inferred.keys()]
      .map((prop) => `readonly ${prop}?: __ComponentChild`)
      .join('; ');
    parts.push(() => atom(`{ ${members} }`));
  }
  if (parts.length === 0) {
    atom('Record<never, never>');
    return;
  }
  parts.forEach((part, index) => {
    if (index > 0) atom(' & ');
    part();
  });
}

/**
 * The bindings at the top of a render function: each kind name it uses, as
 * `kindName` reads it, then `const name = <prop>.name;` for each prop (a live
 * component's state field), the property name an Alias of the first use.
 */
export function writePrelude(
  writer: SegmentWriter,
  scope: RegionScope,
  read: { readonly kindName: (name: string) => string; readonly prop: string },
): void {
  for (const binding of scope.kindNames) {
    writer.atom(
      `  const ${binding.name} = ${read.kindName(binding.name)};\n`,
      binding.firstUse.start,
      binding.firstUse.end,
    );
  }
  for (const binding of scope.props) {
    const { start, end } = binding.firstUse;
    writer.atom(`  const ${binding.name} = ${read.prop}.`, start, end);
    writer.alias(binding.name, start, end);
    writer.atom(';\n', start, end);
  }
}

/** One import per resolved name, owned by the name's first use. */
export function importSegments(
  writer: SegmentWriter,
  fromFile: string,
  imports: readonly ScopeImport[],
): readonly MappedSegment[] {
  for (const entry of imports) {
    const specifier = JSON.stringify(importSpecifier(fromFile, entry.resolved.source));
    const exported = entry.resolved.export;
    const clause =
      exported === 'default'
        ? entry.name
        : exported === entry.name
          ? `{ ${entry.name} }`
          : `{ ${/^[A-Za-z_$][\w$]*$/.test(exported) ? exported : JSON.stringify(exported)} as ${entry.name} }`;
    writer.atom(`import ${clause} from ${specifier};\n`, entry.firstUse.start, entry.firstUse.end);
  }
  return writer.segments();
}

/** A binding the unmapped header imports for generated code: a template's, or a module's. */
export type HeaderHelper = ViewHelper | 'defineIsland' | 'emitter';

/** The `jsails/view` values generated code calls, in header order. */
const VIEW_HELPERS = [
  'bindAttributes',
  'bindControl',
  'defineIsland',
  'emitter',
  'Island',
  'normalizeClass',
  'normalizeStyle',
  'renderList',
] as const satisfies readonly HeaderHelper[];

/** What a module's unmapped header imports. */
export interface HeaderNeeds {
  /** `jsails/view` types besides `ComponentChild`, written `Name as __Name`. */
  readonly viewTypes: readonly string[];
  readonly helpers: ReadonlySet<HeaderHelper>;
  readonly requestContext: boolean;
  readonly serverOnly: boolean;
  readonly mountLive: boolean;
  readonly defineLive: boolean;
}

/** The unmapped header: the framework types and helpers the module uses. */
export function headerText(needs: HeaderNeeds): string {
  const lines: string[] = [];
  const viewTypes = ['ComponentChild as __ComponentChild', ...needs.viewTypes];
  lines.push(`import type { ${viewTypes.join(', ')} } from 'jsails/view';`);
  const helpers = VIEW_HELPERS.filter((helper) => needs.helpers.has(helper));
  if (helpers.length > 0) {
    lines.push(
      `import { ${helpers.map((helper) => `${helper} as __${helper}`).join(', ')} } from 'jsails/view';`,
    );
  }
  if (needs.helpers.has('Fragment')) {
    lines.push("import { Fragment as __Fragment } from 'jsails/jsx-runtime';");
  }
  if (needs.helpers.has('JSX')) {
    lines.push("import type { JSX as __JSX } from 'jsails/jsx-runtime';");
  }
  if (needs.requestContext) {
    lines.push("import type { RequestContext as __RequestContext } from 'jsails';");
  }
  if (needs.serverOnly) lines.push("import { SERVER_ONLY as __SERVER_ONLY } from 'jsails/pages';");
  const serverComponents = [
    ...(needs.defineLive ? ['defineLiveComponent as __defineLiveComponent'] : []),
    ...(needs.mountLive ? ['mountLive as __mountLive'] : []),
  ];
  if (serverComponents.length > 0) {
    lines.push(`import { ${serverComponents.join(', ')} } from 'jsails/server-components';`);
  }
  return `${lines.join('\n')}\n`;
}
