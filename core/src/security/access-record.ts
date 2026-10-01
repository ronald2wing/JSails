/**
 * What the access chain decided for a request, as the response stage reads
 * it.
 *
 * The chain (`access-chain.ts`) records each admitted request's
 * {@link Admitted} and each denied request on its frame; the response
 * finalizer (`server/output.ts`) reads them back. {@link wasDenied} seals a
 * denial (`private, no-store`, no `Set-Cookie`), and
 * {@link isPubliclyCacheable} is the only access fact the cache policy may
 * use: an answer may be shared only when the surface is public and the caller
 * anonymous.
 *
 * It is apart from the chain so the cache and response stages read the
 * record without loading the chain's failure rendering. No runtime imports.
 *
 * The access probe is the access matrix's seam (`jsails/testing`): a request
 * the matrix synthesised in process carries an {@link AccessProbe}, which
 * `openFrame` copies onto the frame's request. The chain tells it each
 * denial and the surface whose chain denied, and the route boundary, where it
 * would run the route's middleware and handler, answers with the probe
 * instead, so the matrix sees every stage the request passed, which surface
 * decided it, and that no route code ran. Only code holding the
 * `Request` object can attach one, so nothing a client sends arms it.
 */

import type { RequestFrame } from '../server/request-frame.js';
import type { SurfaceDescriptor } from './surfaces.js';

/** A request the chain admitted: the surface, and whether the caller is anonymous. */
export interface Admitted {
  readonly surface: SurfaceDescriptor;
  readonly anonymous: boolean;
}

/** The admission of each admitted request, by its frame. */
const admissions = new WeakMap<RequestFrame, Admitted>();

/** The frames of the requests the chain denied. */
const denials = new WeakSet<RequestFrame>();

/** Record that the chain admitted `frame`'s request (the chain only). */
export function recordAdmission(frame: RequestFrame, admitted: Admitted): void {
  admissions.set(frame, admitted);
}

/** Record that the chain denied `frame`'s request (the chain only). */
export function recordDenial(frame: RequestFrame): void {
  denials.add(frame);
}

/** The admission the chain recorded for `frame`'s request, if it admitted one. */
export function admissionOf(frame: RequestFrame): Admitted | undefined {
  return admissions.get(frame);
}

/** Whether the chain denied `frame`'s request. */
export function wasDenied(frame: RequestFrame): boolean {
  return denials.has(frame);
}

/**
 * Whether an admitted request's answer may be stored by a shared cache and
 * replayed to anyone: the surface is public and the caller anonymous.
 */
export function isPubliclyCacheable(admitted: Admitted): boolean {
  return admitted.surface.access.kind === 'public' && admitted.anonymous;
}

/**
 * The access matrix's stand-in for a route's code, on one synthesised
 * request.
 */
export interface AccessProbe {
  /** The chain of `surface` denied the request with `code` (a `Failure` code). */
  denied(surface: SurfaceDescriptor, code: string | undefined): void;
  /**
   * The request reached the place of the route's middleware and handler,
   * admitted as `admitted`: answer in their place.
   */
  reached(admitted: Admitted): Response;
}

/** The probe of each synthesised request, and of the frame request bound to it. */
const probes = new WeakMap<Request, AccessProbe>();

/** Attach `probe` to `request` (the access matrix, and `openFrame` for the request it binds). */
export function attachAccessProbe(request: Request, probe: AccessProbe): void {
  probes.set(request, probe);
}

/** The probe attached to `request`, if any. */
export function accessProbeOf(request: Request): AccessProbe | undefined {
  return probes.get(request);
}
