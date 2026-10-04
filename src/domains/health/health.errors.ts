import { ApplicationError } from '../../shared/errors.js';

export const healthErrors = {
  dependenciesUnavailable: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'ExternalConnectionError',
        code: 'DEPENDENCIES_UNAVAILABLE',
        message: 'A required dependency did not pass its readiness check.',
        publicMessage: 'Required dependencies are unavailable.',
      },
      undefined,
      cause,
    ),
  invalidDatabaseResponse: (cause: unknown) =>
    new ApplicationError(
      {
        category: 'DatabaseOperationError',
        code: 'DATABASE_HEALTH_RESPONSE_INVALID',
        message: 'The database readiness query returned an invalid probe result.',
        publicMessage: 'The database readiness check failed.',
      },
      undefined,
      cause,
    ),
};
