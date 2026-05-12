export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly sourceError?: Error,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationException extends AppError {
  constructor(opts: { message: string; sourceError?: Error }) {
    super(opts.message, 400, 'VALIDATION_ERROR', opts.sourceError);
  }
}

export class AccessDeniedException extends AppError {
  constructor(opts: { message?: string; sourceError?: Error } = {}) {
    super(opts.message ?? 'Access denied', 403, 'ACCESS_DENIED', opts.sourceError);
  }
}

export class UpgradeRequiredException extends AppError {
  constructor(opts: { message?: string; sourceError?: Error } = {}) {
    super(opts.message ?? 'Upgrade required', 402, 'UPGRADE_REQUIRED', opts.sourceError);
  }
}

export class ThrottlingException extends AppError {
  constructor(opts: { message?: string; sourceError?: Error } = {}) {
    super(opts.message ?? 'Too many requests', 429, 'THROTTLED', opts.sourceError);
  }
}

export class ResourceNotFoundException extends AppError {
  constructor(opts: { message: string; sourceError?: Error }) {
    super(opts.message, 404, 'NOT_FOUND', opts.sourceError);
  }
}

export class ConflictException extends AppError {
  constructor(opts: { message: string; sourceError?: Error }) {
    super(opts.message, 409, 'CONFLICT', opts.sourceError);
  }
}

export class InternalServiceException extends AppError {
  constructor(opts: { message: string; sourceError?: Error }) {
    super(opts.message, 500, 'INTERNAL_ERROR', opts.sourceError);
  }
}

export class AiException extends AppError {
  constructor(opts: { message: string; sourceError?: Error }) {
    super(opts.message, 502, 'AI_ERROR', opts.sourceError);
  }
}

export class OpenAiException extends AppError {
  constructor(opts: { message: string; sourceError?: Error }) {
    super(opts.message, 502, 'OPENAI_ERROR', opts.sourceError);
  }
}

export class AnthropicException extends AppError {
  constructor(opts: { message: string; sourceError?: Error }) {
    super(opts.message, 502, 'ANTHROPIC_ERROR', opts.sourceError);
  }
}

export interface NormalizedError {
  status: number;
  code: string;
  message: string;
}

export interface ErrorResponseBody {
  success: false;
  error: string;
  code: string;
}

export function normalizeError(err: Error): NormalizedError {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' };
}

export function errorBody(err: NormalizedError | Error): ErrorResponseBody {
  const n: NormalizedError = 'status' in err ? err : normalizeError(err);
  return { success: false, error: n.message, code: n.code };
}

export function logError(
  err: Error,
  context: string,
  meta: Record<string, string | number | boolean | null | undefined> = {},
): NormalizedError {
  const normalized = normalizeError(err);
  console.error(
    JSON.stringify({
      level: 'error',
      msg: context,
      ...meta,
      error: normalized,
      sourceError: { message: err.message, stack: err.stack },
    }),
  );
  return normalized;
}
