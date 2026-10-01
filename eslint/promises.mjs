/**
 * Promise safety for shipped code (every workspace `src/`).
 *
 * `no-floating-promises` comes from the recommended type-checked preset with
 * `ignoreVoid: true`, which sanctions `void promise` as an escape hatch. Here it
 * is turned off: a promise in `src/` is awaited, returned, ended with a
 * rejection handler, or handed to `detach(promise, report)` from
 * `core/src/support/detach.ts` (`jsails/support`), which always names where a
 * rejection goes; `escalate` is the reporter for a promise that must never
 * reject. `no-void` closes the same hatch for non-promise
 * expressions, and `jsails/no-silent-rejection-handler` forbids the silent
 * swallow (`.catch(() => {})`, a dropped `.catch(() => undefined)`,
 * `.catch(noop)`, `detach(p, () => {})`) unless a comment says why.
 *
 * Tests keep their override in `eslint.config.mjs` (node:test scheduler calls);
 * a rejection there is caught at run time instead: `scripts/run-tests.mjs` fails
 * a test file on an unhandled rejection, including one that arrives after its
 * tests ended.
 */

const SHIPPED_SOURCE = ['core/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'];

/** Unwraps TypeScript-only wrappers that do not change a value. */
function unwrap(node) {
  let current = node;
  while (
    current?.type === 'TSAsExpression' ||
    current?.type === 'TSSatisfiesExpression' ||
    current?.type === 'TSNonNullExpression'
  ) {
    current = current.expression;
  }
  return current;
}

/** A value that carries nothing from the error: a literal, `undefined`, `{}`, `[]`. */
function isInert(node) {
  const value = unwrap(node);
  if (value === null || value === undefined) return true; // a bare `return;`
  switch (value.type) {
    case 'Literal':
      return true;
    case 'TemplateLiteral':
      return value.expressions.length === 0;
    case 'Identifier':
      return value.name === 'undefined';
    case 'ObjectExpression':
      return value.properties.length === 0;
    case 'ArrayExpression':
      return value.elements.length === 0;
    case 'UnaryExpression':
      return value.operator === 'void' && isInert(value.argument);
    default:
      return false;
  }
}

function isFunction(node) {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression';
}

/**
 * How a handler function drops the error: `'empty'` (an empty body), `'inert'`
 * (it only returns a value that carries nothing from the error), or undefined
 * when it does something.
 */
function silenceOf(fn) {
  if (fn.body.type !== 'BlockStatement') return isInert(fn.body) ? 'inert' : undefined;
  const { body } = fn.body;
  if (body.length === 0) return 'empty';
  if (body.length === 1 && body[0].type === 'ReturnStatement' && isInert(body[0].argument)) {
    return 'inert';
  }
  return undefined;
}

/** The function a handler identifier names, when it is defined in this file. */
function resolveFunction(context, identifier) {
  let scope = context.sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) {
      const [definition] = variable.defs;
      if (variable.defs.length !== 1 || definition === undefined) return undefined;
      if (definition.type === 'FunctionName') return definition.node;
      if (
        definition.type === 'Variable' &&
        definition.parent.kind === 'const' &&
        isFunction(definition.node.init)
      ) {
        return definition.node.init;
      }
      return undefined;
    }
    scope = scope.upper;
  }
  return undefined;
}

const STATEMENT = /(?:Statement|Declaration)$/;

/**
 * The statement that holds `node`, widened to the outermost statement starting
 * on the same line (`if (body) body.cancel().catch(...)` is one line, so the
 * comment above it belongs to the `if`).
 */
function enclosingStatement(node) {
  let current = node;
  while (current.parent && !STATEMENT.test(current.type)) current = current.parent;
  while (
    current.parent &&
    STATEMENT.test(current.parent.type) &&
    current.parent.loc.start.line === current.loc.start.line
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * Whether the promise a call produces is dropped: the call is its own
 * statement (possibly awaited, or followed by `.finally()`), or the concise
 * body of an arrow whose contextual type returns `void` (a callback whose
 * result nobody reads). A use of the value, such as
 * `const stat = await lstat(path).catch(() => undefined)`, is not dropped:
 * there the handler maps a failure to a value the code goes on to read.
 */
function isDropped(context, call) {
  let current = call;
  for (;;) {
    const parent = current.parent;
    if (
      parent.type === 'ChainExpression' ||
      parent.type === 'AwaitExpression' ||
      parent.type === 'TSAsExpression' ||
      parent.type === 'TSNonNullExpression'
    ) {
      current = parent;
      continue;
    }
    if (
      parent.type === 'MemberExpression' &&
      parent.object === current &&
      !parent.computed &&
      parent.property.name === 'finally' &&
      parent.parent.type === 'CallExpression' &&
      parent.parent.callee === parent
    ) {
      current = parent.parent;
      continue;
    }
    if (parent.type === 'ExpressionStatement') return true;
    if (parent.type === 'UnaryExpression' && parent.operator === 'void') return true;
    if (parent.type === 'SequenceExpression') return parent.expressions.at(-1) !== current;
    if (parent.type === 'ArrowFunctionExpression' && parent.body === current) {
      return returnsVoid(context, parent);
    }
    return false;
  }
}

/** Whether an arrow's contextual type (the parameter it is passed as) returns void. */
function returnsVoid(context, arrow) {
  const services = context.sourceCode.parserServices;
  if (services?.program === undefined || services.program === null) return false;
  const checker = services.program.getTypeChecker();
  const type = checker.getContextualType(services.esTreeNodeToTSNodeMap.get(arrow));
  const signatures = type?.getCallSignatures() ?? [];
  return (
    signatures.length > 0 &&
    signatures.every((signature) => checker.typeToString(signature.getReturnType()) === 'void')
  );
}

/**
 * A rejection handler that drops the error without saying why:
 *
 * - an empty function body, anywhere;
 * - a function that only returns a literal, `undefined`, `{}` or `[]`
 *   (`.catch(() => undefined)`), where the resulting promise is dropped;
 * - either of those passed by name (`.catch(noop)`) when this file defines it;
 * - any of those as `detach(promise, report)`'s reporter, which exists so that
 *   a rejection always goes somewhere.
 *
 * A comment inside the handler, or on the line directly above its statement,
 * saying why the rejection is irrelevant (a best-effort teardown whose primary
 * error wins, a promise marked handled because another path awaits it) is the
 * same allowance core `no-empty` gives a commented `catch {}` block.
 */
const noSilentRejectionHandler = {
  meta: {
    type: 'problem',
    schema: [],
    docs: {
      description: 'Disallow an unexplained rejection handler that drops the error',
    },
    messages: {
      silent:
        'This rejection handler drops the error without saying why. Handle it, say in a comment why it is irrelevant, or pass the promise to detach(promise, report) with a real reporter.',
    },
  },
  create(context) {
    const { sourceCode } = context;

    const explained = (handler, fn, call) => {
      if (sourceCode.getCommentsInside(handler).length > 0) return true;
      if (fn !== handler && sourceCode.getCommentsInside(fn).length > 0) return true;
      const statement = enclosingStatement(call);
      const before = sourceCode.getCommentsBefore(statement).at(-1);
      return before !== undefined && before.loc.end.line >= statement.loc.start.line - 1;
    };

    /** `alwaysDropped`: the call's result can never be read (detach). */
    const check = (handler, call, alwaysDropped) => {
      if (handler === undefined) return;
      const fn =
        handler.type === 'Identifier' ? resolveFunction(context, handler) : unwrap(handler);
      if (!isFunction(fn) && fn?.type !== 'FunctionDeclaration') return;
      const silence = silenceOf(fn);
      if (silence === undefined) return;
      if (silence === 'inert' && !alwaysDropped && !isDropped(context, call)) return;
      if (explained(handler, fn, call)) return;
      context.report({ node: handler, messageId: 'silent' });
    };

    return {
      CallExpression(node) {
        const { callee } = node;
        const name =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression' && !callee.computed
              ? callee.property.name
              : undefined;
        if (callee.type === 'MemberExpression' && name === 'catch') {
          check(node.arguments[0], node, false);
        } else if (callee.type === 'MemberExpression' && name === 'then') {
          check(node.arguments[1], node, false);
        } else if (name === 'detach' && node.arguments.length >= 2) {
          check(node.arguments[1], node, true);
        }
      },
    };
  },
};

export const rules = { 'no-silent-rejection-handler': noSilentRejectionHandler };

export default [
  {
    files: SHIPPED_SOURCE,
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      'no-void': 'error',
      'jsails/no-silent-rejection-handler': 'error',
    },
  },
  {
    // `detach` is the primitive the rule above points at: it must start the
    // rejection handler without awaiting it.
    files: ['core/src/support/detach.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
];
