import { ApplicationError } from '../shared/errors.js';

const connectionCodes: Readonly<Record<string, true>> = {
  ECONNREFUSED: true,
  ECONNRESET: true,
  ETIMEDOUT: true,
  EHOSTUNREACH: true,
  ENETUNREACH: true,
  ENOTFOUND: true,
  EAI_AGAIN: true,
  TimeoutError: true,
  AbortError: true,
};

/** Finds connection failures in wrapped causes without looping through cyclic errors. */
export function translateQueueError(cause: unknown): ApplicationError {
  if (ApplicationError.is(cause)) {
    return cause;
  }

  const visited = new Set<object>();
  let current = cause;

  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current);
    const fields = current as Record<string, unknown>;
    if (
      (typeof fields.code === 'string' && Object.hasOwn(connectionCodes, fields.code)) ||
      (typeof fields.name === 'string' && Object.hasOwn(connectionCodes, fields.name))
    ) {
      return new ApplicationError(
        {
          category: 'ExternalConnectionError',
          code: 'QUEUE_CONNECTION_FAILED',
          message:
            'The application cannot establish or maintain the queue service connection.',
          publicMessage: 'The queue service is unavailable.',
        },
        undefined,
        cause,
      );
    }

    current = fields.cause;
  }

  return new ApplicationError(
    {
      category: 'ServerError',
      code: 'QUEUE_OPERATION_FAILED',
      message: 'The queue operation failed without a recognized connection condition.',
      publicMessage: 'The server cannot complete the queue operation.',
    },
    undefined,
    cause,
  );
}

export function invalidQueueResponse(cause: unknown): ApplicationError {
  return new ApplicationError(
    {
      category: 'ServerError',
      code: 'QUEUE_RESPONSE_INVALID',
      message: 'The queue service response does not contain a valid queue URL.',
      publicMessage: 'The queue service returned an invalid response.',
    },
    undefined,
    cause,
  );
}
