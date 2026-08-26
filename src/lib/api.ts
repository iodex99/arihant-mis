/**
 * API route error handling.
 *
 * `requireUser`/`requireAdmin` throw, and an uncaught throw in a route handler
 * becomes an opaque 500. That is the wrong signal for "you are not signed in":
 * the caller cannot tell a permissions problem from a server fault, and a
 * genuine fault gets lost among them.
 */

import { NextResponse } from 'next/server';
import { ForbiddenError, UnauthorizedError } from './auth';
import { ImportFormatError } from './parser/readers';
import { logger } from './logger';

export function toErrorResponse(error: unknown, scope: string): NextResponse {
  if (error instanceof UnauthorizedError) {
    return NextResponse.json(
      { error: 'You are not signed in.', remedy: 'Sign in again and retry.' },
      { status: 401 },
    );
  }

  if (error instanceof ForbiddenError) {
    return NextResponse.json(
      { error: 'Your account does not have permission to do that.', remedy: 'Ask an administrator.' },
      { status: 403 },
    );
  }

  if (error instanceof ImportFormatError) {
    return NextResponse.json({ error: error.message, remedy: error.remedy }, { status: 415 });
  }

  const message = error instanceof Error ? error.message : String(error);
  logger.error({ scope, err: message }, 'request failed');

  // The detail goes to the log, not to the caller.
  return NextResponse.json(
    { error: 'Something went wrong handling that request.', remedy: 'Try again; if it persists, check the server logs.' },
    { status: 500 },
  );
}

/**
 * Import-specific variant: a failure to read the file is almost always a
 * problem with the file, so it carries a concrete remedy and the underlying
 * message, which the operator needs in order to fix their export.
 */
export function toImportErrorResponse(error: unknown): NextResponse {
  if (
    error instanceof UnauthorizedError ||
    error instanceof ForbiddenError ||
    error instanceof ImportFormatError
  ) {
    return toErrorResponse(error, 'import');
  }

  const message = error instanceof Error ? error.message : String(error);
  logger.error({ scope: 'import', err: message }, 'import failed');

  return NextResponse.json(
    {
      error: 'The file could not be read.',
      remedy:
        'This usually means the file is corrupt or password-protected. Open it in Excel, re-save it as .xlsx, and try again.',
      detail: message,
    },
    { status: 500 },
  );
}

/** Wrap a route handler so auth failures become 401/403 rather than 500. */
export function withErrors<A extends unknown[]>(
  scope: string,
  handler: (...args: A) => Promise<NextResponse>,
): (...args: A) => Promise<NextResponse> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (error) {
      return toErrorResponse(error, scope);
    }
  };
}
