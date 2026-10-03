import { ApplicationError } from '../../shared/errors.js';

export function invalidEnvironment(cause: unknown) {
  return new ApplicationError(
    {
      category: 'ServerError',
      code: 'ENVIRONMENT_INVALID',
      message: 'The environment does not satisfy the application configuration schema.',
      publicMessage: 'The server configuration is invalid.',
    },
    undefined,
    cause,
  );
}
