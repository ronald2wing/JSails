/**
 * The lowering of a live component (`components/**.jsails`, sfc-plan §2.2,
 * §2.7) to a shadow module whose default export is its server component
 * definition:
 *
 * ```tsx
 * import { defineLiveComponent as __defineLiveComponent } from 'jsails/server-components';  // header
 * <script content, the defineLive statement cut>                      // Verbatim
 * <imports and type declarations of <script setup>>                   // Verbatim, hoisted
 * export default __defineLiveComponent("task-list", <stateSchema>)({  // id from the path
 *   <every other defineLive property>,                                // Verbatim
 *   render(__state, __tools): __ComponentChild {
 *     const errors = __tools.errors;                                  // kind names (scope pass)
 *     const done = __tools.computed("done");                          // derived keys
 *     const title = __state.title;                                    // state fields (scope pass)
 *     <script setup content>                                          // Verbatim
 *     return (<>…</>);                                                // template-jsx.ts, live rules
 *   },
 *   staticFallback(__context: __RequestContext): __ComponentChild {   // <template static>
 *     const context = __context;
 *     return (<>…</>);
 *   },
 * });
 * ```
 *
 * The definition takes the schema first (`defineLiveComponent(name, schema)`)
 * so TypeScript fixes the state type before it checks the other properties:
 * that is what types `run(state, args)`, the derived functions, and the
 * tools `render` receives, whose `call`/`submit` take only declared action
 * names. The render's free names are state fields, its kind names the tools'
 * (`errors`, `values`, `context`) and the keys of `derived`; the static form
 * has no state and names only `context`, imports and catalog names.
 *
 * As in `compile-page.ts` the module is assembled twice; the template is
 * lowered again for the second assembly with the scope pass's state-field
 * uses, so `js-show`/`js-text` on a bare field carry the client marker.
 */

import { componentIdFor } from '../conventions.js';
import type { SfcFile, SfcTemplateBlock } from './blocks.js';
import {
  headerText,
  importSegments,
  length,
  importsOfKind,
  resolvedImports,
  writeHoisted,
  writePrelude,
  writeScript,
  writeSetup,
  type FunctionKindLowering,
} from './compile-page.js';
import type { SfcDiagnostics } from './diagnostics.js';
import { LIVE_KIND } from './kinds.js';
import { analyseLiveDefinition, LIVE_TOOL_NAMES } from './live-definition.js';
import { writeLiveMounts } from './live-mounts.js';
import type { NameResolver } from './name-resolver.js';
import { analyseScope, type RegionScope } from './scope.js';
import { analyseScript, analyseSetup } from './script-analysis.js';
import { SegmentWriter } from './segment-writer.js';
import { assembleShadow, type MappedSegment, type Shadow } from './segments.js';
import type { SourceSpace } from './source-space.js';
import {
  lowerTemplateRoot,
  TOOLS_PARAMETER,
  type IslandRules,
  type ViewHelper,
} from './template-jsx.js';

/** Inputs of {@link compileLiveKind}. */
export interface LiveKindInput {
  readonly file: SfcFile;
  readonly template: SfcTemplateBlock;
  /** The component's files; every offset of `file` is an offset of this space. */
  readonly space: SourceSpace;
  readonly resolver: NameResolver;
  readonly diagnostics: SfcDiagnostics;
  /** The scope id its template's outermost elements carry (`style.ts`). */
  readonly scopeId: string;
}

/** The parameter a live render reads its state from. */
const STATE_PARAMETER = '__state';

const NO_MOUNTS = new Map();

/**
 * Lower a live component, or return `undefined` after reporting why it
 * cannot be. Diagnostics go to `input.diagnostics`.
 */
export function compileLiveKind(input: LiveKindInput): FunctionKindLowering | undefined {
  const { file, template, space, diagnostics } = input;
  const spec = LIVE_KIND;
  const script = analyseScript(file.script, spec, diagnostics);
  const setup = analyseSetup(file.scriptSetup, spec, diagnostics);
  const templateOwner = { start: template.start, end: template.contentStart };
  const definition = analyseLiveDefinition(file.script, templateOwner, diagnostics);
  const staticBlock = file.templateStatic;
  if (definition?.staticRender != null && staticBlock !== null) {
    diagnostics.error(
      'sfc.live_definition',
      "staticRender: 'initial' and <template static> are exclusive static forms",
      staticBlock.start,
      staticBlock.contentStart,
    );
  }
  if (diagnostics.hasErrors || definition === undefined) return undefined;

  const writerFor = (): SegmentWriter => new SegmentWriter(space);
  const call = definition.call;

  const moduleWriter = writerFor();
  writeScript(moduleWriter, file.script, definition.statement);
  writeHoisted(moduleWriter, setup.hoisted);

  const open = writerFor();
  open.atom(
    `export default __defineLiveComponent(${JSON.stringify(componentIdFor(file.file))}, `,
    call.start,
    call.end,
  );
  open.verbatim(definition.stateSchema.start, definition.stateSchema.end);
  open.atom(')({\n', call.start, call.end);
  for (const property of definition.properties) {
    open.atom('  ', property.start, property.end);
    open.verbatim(property.start, property.end);
    open.atom(',\n', property.start, property.end);
  }

  const async = setup.awaits;
  const renderOpen = writerFor();
  renderOpen.atom(
    `  ${async ? 'async ' : ''}render(${STATE_PARAMETER}, ${TOOLS_PARAMETER}): ${async ? 'Promise<__ComponentChild>' : '__ComponentChild'} {\n`,
    templateOwner.start,
    templateOwner.end,
  );
  const renderClose = writerFor();
  renderClose.atom('  },\n', templateOwner.start, templateOwner.end);
  const staticOwner =
    staticBlock === null ? null : { start: staticBlock.start, end: staticBlock.contentStart };
  const staticOpen = writerFor();
  const staticClose = writerFor();
  if (staticOwner !== null) {
    staticOpen.atom(
      '  staticFallback(__context: __RequestContext): __ComponentChild {\n',
      staticOwner.start,
      staticOwner.end,
    );
    staticClose.atom('  },\n', staticOwner.start, staticOwner.end);
  }
  const close = writerFor();
  close.atom('});\n', call.start, call.end);

  const lower = (propUses: ReadonlySet<number>, islands: IslandRules | null) => {
    const helpers = new Set<ViewHelper>();
    const render = writerFor();
    writeSetup(render, file.scriptSetup, setup.hoisted, [setup.defineProps, setup.defineSlots]);
    const lowering = lowerTemplateRoot(template.root.children, templateOwner, {
      writer: render,
      rules: {
        kind: spec.kind,
        slots: false,
        mounts: NO_MOUNTS,
        live: { propUses },
        islands,
        scopeId: input.scopeId,
      },
      diagnostics,
    });
    for (const helper of lowering.helpers) helpers.add(helper);
    const staticBody = writerFor();
    if (staticBlock !== null && staticOwner !== null) {
      const fallback = lowerTemplateRoot(staticBlock.root.children, staticOwner, {
        writer: staticBody,
        rules: {
          kind: spec.kind,
          slots: false,
          mounts: NO_MOUNTS,
          live: null,
          islands,
          scopeId: input.scopeId,
        },
        diagnostics,
      });
      for (const helper of fallback.helpers) helpers.add(helper);
    }
    return { render, staticBody, helpers };
  };

  const first = lower(new Set(), null);
  if (diagnostics.hasErrors) return undefined;
  const header = (pass: ReturnType<typeof lower>): string =>
    headerText({
      viewTypes: [],
      helpers: pass.helpers,
      requestContext: staticBlock !== null,
      serverOnly: false,
      mountLive: false,
      defineLive: true,
    });
  const assemble = (
    pass: ReturnType<typeof lower>,
    imports: readonly MappedSegment[],
    renderPrelude: readonly MappedSegment[],
    staticPrelude: readonly MappedSegment[],
  ): Shadow =>
    assembleShadow({
      header: header(pass),
      body: [
        ...imports,
        ...moduleWriter.segments(),
        ...open.segments(),
        ...renderOpen.segments(),
        ...renderPrelude,
        ...pass.render.segments(),
        ...renderClose.segments(),
        ...staticOpen.segments(),
        ...staticPrelude,
        ...pass.staticBody.segments(),
        ...staticClose.segments(),
        ...close.segments(),
      ],
      footer: '',
    });

  const renderStart =
    header(first).length +
    length(moduleWriter.segments()) +
    length(open.segments()) +
    length(renderOpen.segments());
  const renderEnd = renderStart + length(first.render.segments());
  const staticStart = renderEnd + length(renderClose.segments()) + length(staticOpen.segments());
  const derived = new Set(definition.derived);
  const scope = analyseScope(
    assemble(first, [], [], []),
    [
      {
        start: renderStart,
        end: renderEnd,
        kindNames: new Set([...LIVE_TOOL_NAMES, ...derived]),
        unbound: 'prop',
      },
      {
        start: staticStart,
        end: staticStart + length(first.staticBody.segments()),
        kindNames: new Set(['context']),
        unbound: 'static',
      },
    ],
    { space, resolver: input.resolver, diagnostics },
  );
  if (scope === undefined || diagnostics.hasErrors) return undefined;
  const [renderScope, staticScope] = scope.regions as [RegionScope, RegionScope];
  // A live component renders no other: its tags are reported where they stand.
  const jsailsImports = [...script.jsailsImports, ...setup.jsailsImports];
  const liveTags = new Set([...scope.liveTags, ...importsOfKind(jsailsImports, 'live')]);
  if (liveTags.size > 0) {
    for (const block of [template, staticBlock]) {
      if (block === null) continue;
      writeLiveMounts(block.root.children, {
        writer: writerFor(),
        liveTags,
        mountsLive: false,
        diagnostics,
      });
    }
    if (diagnostics.hasErrors) return undefined;
  }

  // Nor does it mount an island: the final lowering reports their tags.
  const final = lower(renderScope.propUses, {
    tags: new Set([...scope.islandTags, ...importsOfKind(jsailsImports, 'island')]),
    mode: spec.islands,
  });
  if (diagnostics.hasErrors) return undefined;
  const renderPrelude = writerFor();
  writePrelude(renderPrelude, renderScope, {
    kindName: (name) =>
      derived.has(name)
        ? `${TOOLS_PARAMETER}.computed(${JSON.stringify(name)})`
        : `${TOOLS_PARAMETER}.${name}`,
    prop: STATE_PARAMETER,
  });
  const staticPrelude = writerFor();
  writePrelude(staticPrelude, staticScope, { kindName: () => '__context', prop: '' });
  const imports = importSegments(writerFor(), file.file, scope.imports);
  return Object.freeze({
    shadow: assemble(final, imports, renderPrelude.segments(), staticPrelude.segments()),
    exports: Object.freeze([...script.exports, 'default']),
    imports: resolvedImports(file.file, scope.imports),
  });
}
