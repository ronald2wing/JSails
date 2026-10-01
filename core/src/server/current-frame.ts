/**
 * The context key the request frame is bound under, and its reader, in a
 * module that loads only the execution context: a first-party route handler
 * (the mail preview, which must answer only this machine) reads the frame
 * through `jsails/internal` without its package entry loading the request
 * pipeline that builds frames.
 */

import { createContextKey, getContext, type ContextKey } from '../context/execution-context.js';
import type { RequestFrame } from './request-frame.js';

/** The key the request pipeline binds each request's frame under. */
export const frameKey: ContextKey<RequestFrame> =
  createContextKey<RequestFrame>('jsails.request-frame');

/**
 * The frame of the request this code runs in, or `undefined` outside one.
 *
 * @public
 */
export function currentRequestFrame(): RequestFrame | undefined {
  return getContext(frameKey);
}
