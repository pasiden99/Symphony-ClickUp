export class SymphonyError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message, cause ? { cause } : undefined);
    this.name = "SymphonyError";
    this.code = code;
    this.details = details;
  }
}

export function isSymphonyError(error: unknown): error is SymphonyError {
  return error instanceof SymphonyError;
}

export function toErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof SymphonyError) {
    return {
      code: error.code,
      ...error.details
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return undefined;
}
