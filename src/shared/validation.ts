import type { z } from 'zod';
import type { ApplicationError } from './errors.js';

/** Validates input against a Zod schema and maps validation failure to an ApplicationError. */
export function validateInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  error: (cause: unknown) => ApplicationError,
): z.output<Schema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw error(result.error);
  }
  return result.data;
}
