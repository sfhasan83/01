export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) { super(422, 'validation_failed', message, details); }
}
export class NotFoundError extends AppError {
  constructor(what: string) { super(404, 'not_found', `${what} not found`); }
}
export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) { super(409, 'conflict', message, details); }
}
export class UnauthenticatedError extends AppError {
  constructor(message = 'authentication required') { super(401, 'unauthenticated', message); }
}
export class TooManyRequestsError extends AppError {
  readonly retryAfter: number;
  constructor(message: string, retryAfterSeconds: number) { super(429, 'too_many_requests', message); this.retryAfter = retryAfterSeconds; }
}
export class ForbiddenError extends AppError {
  readonly permission: string;
  readonly resource: unknown;
  constructor(permission: string, resource: unknown, reason: string) {
    super(403, 'forbidden', `not permitted: ${permission} (${reason})`);
    this.permission = permission;
    this.resource = resource;
  }
}

/** Translate PostgreSQL errors into application errors. */
export function fromPg(err: unknown): unknown {
  const e = err as { code?: string; message?: string; detail?: string; constraint?: string };
  if (!e || typeof e.code !== 'string') return err;
  switch (e.code) {
    case '23505': return new ConflictError(`duplicate value (${e.constraint ?? 'unique'})`, e.detail);
    case '23503': return new ValidationError(`referenced record does not exist (${e.constraint ?? 'foreign key'})`, e.detail);
    case '23514': return new ValidationError(`value violates rule (${e.constraint ?? 'check'})`, e.detail);
    case '23502': return new ValidationError(`missing required value`, e.detail);
    case '22P02': return new ValidationError(`invalid value: ${e.message}`);
    case 'P0001': return new ValidationError(e.message ?? 'rule violated');
    default: return err;
  }
}
