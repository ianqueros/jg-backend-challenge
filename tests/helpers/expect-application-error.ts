import { expect } from 'bun:test';
import { ApplicationError, type ErrorCategory } from '../../src/shared/errors.js';

export function expectApplicationError(
  error: unknown,
  expected: { category: ErrorCategory; code: string },
): ApplicationError {
  expect(error).toBeInstanceOf(ApplicationError);
  if (!ApplicationError.is(error)) {
    throw new Error('Expected error to be an ApplicationError instance');
  }

  expect(error.category).toBe(expected.category);
  expect(error.code).toBe(expected.code);

  return error;
}
