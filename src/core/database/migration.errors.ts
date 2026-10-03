import { ApplicationError } from '../../shared/errors.js';

export function invalidMigrationAction(cause: unknown) {
  return new ApplicationError(
    {
      category: 'ValidationError',
      code: 'MIGRATION_ACTION_INVALID',
      message: 'The migration action must be up or down.',
      publicMessage: 'The migration action must be up or down.',
    },
    undefined,
    cause,
  );
}
