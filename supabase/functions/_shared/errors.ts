export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly sourceError?: unknown,
  ) {
    super(message)
    this.name = this.constructor.name
  }
}

export class ValidationException extends AppError {
  constructor(opts: { message: string; sourceError?: unknown }) {
    super(opts.message, 400, 'VALIDATION_ERROR', opts.sourceError)
  }
}

export class AccessDeniedException extends AppError {
  constructor(opts: { message?: string; sourceError?: unknown } = {}) {
    super(opts.message ?? 'Access denied', 403, 'ACCESS_DENIED', opts.sourceError)
  }
}

export class InternalServiceException extends AppError {
  constructor(opts: { message: string; sourceError?: unknown }) {
    super(opts.message, 500, 'INTERNAL_ERROR', opts.sourceError)
  }
}

export interface NormalizedError {
  status: number
  code: string
  message: string
}

export function normalizeError(err: unknown): NormalizedError {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message }
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }
}

export function errorBody(err: NormalizedError | unknown): Record<string, unknown> {
  const n = err instanceof Object && 'status' in (err as object)
    ? (err as NormalizedError)
    : normalizeError(err)
  return { ok: false, error: (n as NormalizedError).message, code: (n as NormalizedError).code }
}

export function logError(
  err: unknown,
  context: string,
  meta: Record<string, unknown> = {},
): NormalizedError {
  const normalized = normalizeError(err)
  console.error(JSON.stringify({
    level: 'error',
    msg: context,
    ...meta,
    error: normalized,
    sourceError: err instanceof Error ? { message: err.message, stack: err.stack } : err,
  }))
  return normalized
}
