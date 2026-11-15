export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (code = 'bad_request', message?: string, details?: unknown) => new AppError(400, code, message, details),
  unauthorized: (code = 'unauthorized', message?: string) => new AppError(401, code, message),
  /** 402: the action is blocked by the subscription/plan, not by the user's role. */
  paymentRequired: (code: string, message?: string, details?: unknown) => new AppError(402, code, message, details),
  forbidden: (code = 'forbidden', message?: string) => new AppError(403, code, message),
  notFound: (code = 'not_found', message?: string) => new AppError(404, code, message),
  conflict: (code: string, message?: string, details?: unknown) => new AppError(409, code, message, details),
  tooMany: (code = 'rate_limited', message?: string) => new AppError(429, code, message),
};

interface PgError { code?: string; constraint?: string; message?: string; hint?: string }

/** Translate Postgres errors raised by constraints/triggers into API errors. */
export function mapDbError(err: unknown): AppError | null {
  const e = err as PgError;
  if (!e || typeof e.code !== 'string') return null;
  switch (e.code) {
    case 'KD001':
      return Errors.paymentRequired('seat_limit_reached', 'Your plan has no free seats. Upgrade or disable a member.');
    case '23505':
      return Errors.conflict('conflict', 'This record already exists.', { constraint: e.constraint });
    case '23514':
      return Errors.badRequest('constraint_violation', 'A value is not valid.', { constraint: e.constraint });
    case '23503':
      return Errors.badRequest('invalid_reference', 'A referenced record does not exist.', { constraint: e.constraint });
    case '42501':
      return Errors.forbidden('forbidden');
    default:
      return null;
  }
}
