/**
 * Value-free HTTP error responses for the admin surfaces.
 *
 * The panel routes, the resource routes, and admin plugins (the plugin manager,
 * the flags page) all answer failures with an admin document carrying a stable
 * status and a fixed message; raw error text is never emitted. A forbidden
 * response may carry a reason, but only a fixed reason the caller produced
 * itself — never a caught exception's message.
 */

import { h } from 'preact';

import { adminHtmlResponse, renderAdminDocumentWithTheme } from './document.js';

/**
 * A minimal, unthemed admin error document with a heading and an optional
 * fixed message. The message is the caller's own constant, never an error's
 * text.
 */
export function adminErrorResponse(status: number, title: string, message?: string): Response {
  return adminHtmlResponse(
    renderAdminDocumentWithTheme(
      { title },
      h('h1', null, title),
      message === undefined ? null : h('p', null, message),
    ),
    status,
  );
}

/** A value-free 400 for a malformed request. */
export function adminBadRequestResponse(): Response {
  return adminErrorResponse(400, 'Bad Request');
}

/**
 * A 403 document. The session id and the denial cause are never emitted; an
 * optional `reason` must be a fixed string the caller produced itself.
 */
export function adminForbiddenResponse(reason?: string): Response {
  return adminErrorResponse(403, 'Forbidden', reason);
}

/** A value-free 404 document. */
export function adminNotFoundResponse(): Response {
  return adminErrorResponse(404, 'Not Found');
}

/** A 405 for a mutation on a read-only resource or page, with a fixed message. */
export function adminMethodNotAllowedResponse(message: string): Response {
  return adminErrorResponse(405, 'Method Not Allowed', message);
}

/** A value-free 500 document; internal details are never emitted. */
export function adminServerErrorResponse(): Response {
  return adminErrorResponse(500, 'Internal Server Error');
}
