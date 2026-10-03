import { ApplicationError, boundaryErrors } from './errors.js';

/** Formats uncaught process errors to JSON standard error and marks process failure exit code. */
export function reportFailure(cause: unknown): void {
  const error = ApplicationError.is(cause) ? cause : boundaryErrors.unexpected(cause);
  console.error(
    JSON.stringify({
      category: error.category,
      code: error.code,
      message: error.message,
      ...(error.metadata === undefined ? {} : { metadata: error.metadata }),
    }),
  );
  process.exitCode = 1;
}
