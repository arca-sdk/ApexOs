import { TrueNasConnectionError, TrueNasError } from '@apexos/truenas-client';
import { ZodError } from 'zod';

/** An error whose message is safe and useful to show to the user. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'BAD_REQUEST',
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

export interface ErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}

export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof UserError) {
    return { status: err.statusCode, body: { error: { code: err.code, message: err.message, fields: err.fields } } };
  }
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) fields[issue.path.join('.') || '_'] = issue.message;
    return { status: 400, body: { error: { code: 'VALIDATION', message: 'Some fields are invalid', fields } } };
  }
  if (err instanceof TrueNasConnectionError) {
    return { status: 503, body: { error: { code: 'TRUENAS_UNAVAILABLE', message: err.message } } };
  }
  if (err instanceof TrueNasError) {
    const fields = err.validationErrors;
    return {
      status: 502,
      body: {
        error: {
          code: 'TRUENAS_ERROR',
          message: err.reason ?? err.message,
          fields: Object.keys(fields).length ? fields : undefined,
        },
      },
    };
  }
  const statusCode = (err as { statusCode?: number })?.statusCode;
  if (statusCode && statusCode < 500) {
    return { status: statusCode, body: { error: { code: 'BAD_REQUEST', message: (err as Error).message } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Something went wrong. Check the server logs for details.' } } };
}
