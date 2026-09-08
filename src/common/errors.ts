/**
 * Helpers for values caught in a `catch` block.
 *
 * `catch (e: unknown)` is the honest type — anything can be thrown — but every
 * call site then has to narrow it before reading `.message`. These do that
 * once.
 */

/** The message of a thrown value, whatever it turned out to be. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/** The stack of a thrown value, when it has one. */
export function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

/** Narrows to an object carrying a string `code`, as Node and axios errors do. */
export function hasErrorCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  );
}
