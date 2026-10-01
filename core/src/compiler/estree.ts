/**
 * Minimal ESTree view over rolldown's parsed program.
 *
 * The parser returns a typed ESTree program, but the compiler walks it as
 * untyped records. These guards keep that walk honest in one place instead of
 * repeating the same structural checks in every scanner.
 */

export interface EstreeNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export function asNode(value: unknown): EstreeNode | undefined {
  return value !== null &&
    typeof value === 'object' &&
    typeof (value as EstreeNode).type === 'string'
    ? (value as EstreeNode)
    : undefined;
}

export function asNodeArray(value: unknown): EstreeNode[] {
  return Array.isArray(value) ? (value as EstreeNode[]) : [];
}

export function nodeName(node: EstreeNode | undefined): string | undefined {
  return typeof node?.name === 'string' ? node.name : undefined;
}
